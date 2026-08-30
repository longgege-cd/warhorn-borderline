// 策略卷积网络会话式训练脚本
// 用法: node --import tsx scripts/trainPolicy.ts <records.txt> [--epochs N] [--out assets/policy_weights.json] [--lr 0.001]
// 读取 selfplay 导出的紧凑棋谱，用 GameSession 重放并收集 (planes, target) 样本，
// 手写 minibatch SGD + 交叉熵，含三层 3x3 卷积(ReLU)与 1x1 头的完整反向传播。零第三方依赖。

import fs from "node:fs";
import path from "node:path";
import { GameSession } from "../src/GameSession.js";
import {
  buildPlanes, softmaxInPlace, serializeWeights, initWeights,
  CIN, COUT, N,
} from "../src/policyNet.js";
import type { PolicyWeights } from "../src/policyNet.js";

const S = 19; // BOARD_SIZE（棋盘边长，N == S*S）
const BATCH = 32;

// ===== 参数解析 =====
function argValue(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return def;
  return process.argv[i + 1];
}
const recordFile = process.argv[2];
const epochs = parseInt(argValue("--epochs", "3"), 10) || 3;
const outPath = argValue("--out", "assets/policy_weights.json");
const lr = parseFloat(argValue("--lr", "0.001")) || 0.001;

if (!recordFile || !fs.existsSync(recordFile)) {
  console.error("用法: node --import tsx scripts/trainPolicy.ts <records.txt> [--epochs N] [--out assets/policy_weights.json] [--lr 0.001]");
  process.exit(1);
}

// ===== 重放收集样本 =====
interface Sample { planes: Float32Array; target: number; }

function loadSamples(): Sample[] {
  const lines = fs.readFileSync(recordFile, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const samples: Sample[] = [];
  for (const line of lines) {
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const seq = line.slice(bar + 1).trim().split(/\s+/).filter((x) => x.length > 0);
    const session = new GameSession({ enableDeployPhase: true });
    let lastIdx = -1;
    for (const m of seq) {
      const curColor = session.toMove;
      if (m === "p") { session.doPass(curColor); continue; }
      const dash = m.indexOf("-");
      if (dash < 0) continue;
      const r = parseInt(m.slice(0, dash), 10);
      const c = parseInt(m.slice(dash + 1), 10);
      if (Number.isNaN(r) || Number.isNaN(c)) continue;
      const target = r * 19 + c;
      const planes = buildPlanes(session.board, curColor, lastIdx);
      const out = session.playMove(curColor, r, c);
      if (out.ok) { samples.push({ planes, target }); lastIdx = target; }
      // 非法落点：丢弃样本、lastIdx 保持
    }
  }
  return samples;
}

// ===== 前向（保留每层激活与 softmax） =====
interface Fwd {
  y1: Float32Array; x1: Float32Array; y2: Float32Array; x2: Float32Array;
  y3: Float32Array; x3: Float32Array; probs: Float32Array; hit: boolean;
}
function convSame(X: Float32Array, Cin: number, Cout: number, W: Float32Array, B: Float32Array): Float32Array {
  const Y = new Float32Array(Cout * N);
  const sm1 = S - 1;
  for (let oc = 0; oc < Cout; oc++) {
    const oBase = oc * N;
    const bias = B[oc];
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        let acc = bias;
        for (let ic = 0; ic < Cin; ic++) {
          const iBase = ic * N;
          const wBase = oc * (Cin * 9) + ic * 9;
          for (let di = 0; di < 3; di++) {
            const r2 = r + di - 1;
            if (r2 < 0 || r2 > sm1) continue;
            const wRow = wBase + di * 3;
            const xRowBase = iBase + r2 * S;
            for (let dj = 0; dj < 3; dj++) {
              const c2 = c + dj - 1;
              if (c2 < 0 || c2 > sm1) continue;
              acc += X[xRowBase + c2] * W[wRow + dj];
            }
          }
        }
        Y[oBase + r * S + c] = acc;
      }
    }
  }
  return Y;
}
function reluCopy(Y: Float32Array): Float32Array {
  const A = new Float32Array(Y.length);
  for (let i = 0; i < A.length; i++) A[i] = Y[i] > 0 ? Y[i] : 0;
  return A;
}
function forwardSample(w: PolicyWeights, s: Sample): Fwd {
  const y1 = convSame(s.planes, CIN, COUT, w.conv1, w.b1);
  const x1 = reluCopy(y1);
  const y2 = convSame(x1, COUT, COUT, w.conv2, w.b2);
  const x2 = reluCopy(y2);
  const y3 = convSame(x2, COUT, COUT, w.conv3, w.b3);
  const x3 = reluCopy(y3);

  const logits = new Float32Array(N);
  const hb = w.headB[0];
  for (let ic = 0; ic < COUT; ic++) {
    const hw = w.head[ic];
    const base = ic * N;
    for (let i = 0; i < N; i++) logits[i] += x3[base + i] * hw;
  }
  for (let i = 0; i < N; i++) logits[i] += hb;

  // 掩非法点（平面2=0 → 已被占），softmax
  const p2 = s.planes.subarray(2 * N, 3 * N);
  for (let i = 0; i < N; i++) if (p2[i] === 0) logits[i] = -Infinity;
  const probs = softmaxInPlace(logits);

  let bestIdx = -1, bestP = -1;
  for (let i = 0; i < N; i++) if (probs[i] > bestP) { bestP = probs[i]; bestIdx = i; }
  return { y1, x1, y2, x2, y3, x3, probs, hit: bestIdx === s.target };
}

// ===== 卷积+ReLU 反向，累加梯度 =====
function reluGrad(Y: Float32Array, dY: Float32Array, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = Y[i] > 0 ? dY[i] : 0;
}
/** 卷积反向就地累加 dW/db 至 acc，输入 dY(已过 ReLU 门) 输出 dxin。 */
function convBackwardAcc(
  W: Float32Array, Xin: Float32Array, dY: Float32Array, Cin: number, Cout: number,
  accW: Float32Array, accB: Float32Array, dxin: Float32Array
): void {
  const sm1 = S - 1;
  for (let oc = 0; oc < Cout; oc++) {
    const oBase = oc * N;
    // 偏置梯度
    let bacc = 0;
    for (let r = 0; r < S; r++) {
      const oRow = oBase + r * S;
      for (let c = 0; c < S; c++) bacc += dY[oRow + c];
    }
    accB[oc] += bacc;

    for (let ic = 0; ic < Cin; ic++) {
      const iBase = ic * N;
      const wBase = oc * (Cin * 9) + ic * 9;
      for (let di = 0; di < 3; di++) {
        const dr = di - 1;
        for (let dj = 0; dj < 3; dj++) {
          const dc = dj - 1;
          const wIdx = wBase + di * 3 + dj;
          let wG = 0;
          for (let r = 0; r < S; r++) {
            const r2 = r + dr;
            if (r2 < 0 || r2 > sm1) continue;
            const xRow = iBase + r2 * S;
            const oRow = oBase + r * S;
            for (let c = 0; c < S; c++) {
              const c2 = c + dc;
              if (c2 < 0 || c2 > sm1) continue;
              const xv = Xin[xRow + c2];
              const dv = dY[oRow + c];
              wG += xv * dv;
              dxin[xRow + c2] += dv * W[wIdx];
            }
          }
          accW[wIdx] += wG;
        }
      }
    }
  }
}

// ===== 梯度累加器 =====
interface Acc {
  dW1: Float32Array; dB1: Float32Array; dW2: Float32Array; dB2: Float32Array;
  dW3: Float32Array; dB3: Float32Array; dHead: Float32Array; dHeadB: number;
}
function makeAcc(): Acc {
  return {
    dW1: new Float32Array(COUT * CIN * 9), dB1: new Float32Array(COUT),
    dW2: new Float32Array(COUT * COUT * 9), dB2: new Float32Array(COUT),
    dW3: new Float32Array(COUT * COUT * 9), dB3: new Float32Array(COUT),
    dHead: new Float32Array(COUT), dHeadB: 0,
  };
}
function zeroAcc(a: Acc): void {
  a.dW1.fill(0); a.dB1.fill(0); a.dW2.fill(0); a.dB2.fill(0);
  a.dW3.fill(0); a.dB3.fill(0); a.dHead.fill(0); a.dHeadB = 0;
}

/** 单样本前向+反向：返回 loss 与命中，梯度累加进 acc。 */
function backpropOne(w: PolicyWeights, s: Sample, acc: Acc): { loss: number; hit: boolean } {
  const f = forwardSample(w, s);
  const loss = -Math.log(Math.min(Math.max(f.probs[s.target], 1e-12), 1));

  // 1) 头反向：dLogits = probs - onehot
  const dLogits = new Float32Array(N);
  for (let i = 0; i < N; i++) dLogits[i] = f.probs[i];
  dLogits[s.target] -= 1;
  for (let i = 0; i < N; i++) acc.dHeadB += dLogits[i];

  const dx3 = new Float32Array(COUT * N);
  for (let ic = 0; ic < COUT; ic++) {
    const hw = w.head[ic];
    const base = ic * N;
    for (let i = 0; i < N; i++) {
      acc.dHead[ic] += dLogits[i] * f.x3[base + i];
      dx3[base + i] += dLogits[i] * hw;
    }
  }

  // 2) conv3：输入 x2 → y3 →(relu)→ x3
  const dy3 = new Float32Array(COUT * N);
  reluGrad(f.y3, dx3, dy3);
  const dx2 = new Float32Array(COUT * N);
  convBackwardAcc(w.conv3, f.x2, dy3, COUT, COUT, acc.dW3, acc.dB3, dx2);

  // 3) conv2：输入 x1 → y2 →(relu)→ x2
  const dy2 = new Float32Array(COUT * N);
  reluGrad(f.y2, dx2, dy2);
  const dx1 = new Float32Array(COUT * N);
  convBackwardAcc(w.conv2, f.x1, dy2, COUT, COUT, acc.dW2, acc.dB2, dx1);

  // 4) conv1：输入 planes → y1 →(relu)→ x1（无需回传输入梯度）
  const dy1 = new Float32Array(COUT * N);
  reluGrad(f.y1, dx1, dy1);
  convBackwardAcc(w.conv1, s.planes, dy1, CIN, COUT, acc.dW1, acc.dB1, new Float32Array(CIN * N));

  return { loss, hit: f.hit };
}

// ===== SGD 更新 =====
function applySGD(w: PolicyWeights, a: Acc, effLr: number): void {
  for (let i = 0; i < w.conv1.length; i++) w.conv1[i] -= effLr * a.dW1[i];
  for (let i = 0; i < w.b1.length; i++) w.b1[i] -= effLr * a.dB1[i];
  for (let i = 0; i < w.conv2.length; i++) w.conv2[i] -= effLr * a.dW2[i];
  for (let i = 0; i < w.b2.length; i++) w.b2[i] -= effLr * a.dB2[i];
  for (let i = 0; i < w.conv3.length; i++) w.conv3[i] -= effLr * a.dW3[i];
  for (let i = 0; i < w.b3.length; i++) w.b3[i] -= effLr * a.dB3[i];
  for (let i = 0; i < w.head.length; i++) w.head[i] -= effLr * a.dHead[i];
  w.headB[0] -= effLr * a.dHeadB;
}

// ===== 主流程 =====
console.log(`加载棋谱: ${recordFile}`);
const samples = loadSamples();
console.log(`样本数: ${samples.length}`);
if (samples.length === 0) {
  console.error("无可用样本，中止。");
  process.exit(1);
}

const weights = initWeights(1234);

for (let ep = 0; ep < epochs; ep++) {
  // 洗牌（本 epoch 内随机顺序）
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }

  const acc = makeAcc();
  let sumLoss = 0, hits = 0, inBatch = 0;

  for (let si = 0; si < samples.length; si++) {
    const res = backpropOne(weights, samples[si], acc);
    sumLoss += res.loss;
    if (res.hit) hits++;
    inBatch++;
    if ((si + 1) % BATCH === 0 || si === samples.length - 1) {
      applySGD(weights, acc, lr / inBatch);
      zeroAcc(acc);
      inBatch = 0;
    }
  }
  console.log(`epoch ${ep + 1}/${epochs}  avg_loss=${(sumLoss / samples.length).toFixed(4)}  top1_acc=${((hits / samples.length) * 100).toFixed(3)}%`);
}

// 写出权重
if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(serializeWeights(weights)), "utf8");
console.log(`已写出: ${outPath}  (${fs.statSync(outPath).size} bytes)`);