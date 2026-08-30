// 价值网络训练脚本（一期：主训价值网络替代启发式评估）
// 用法:
//   node --import tsx scripts/trainValueNet.ts <records_all.txt> [--epochs N] [--out assets/value_weights.json] [--lr 0.001] [--stride 8]
// 输入: genData.ts/selfplay --dump 产出的紧凑棋谱(每行 winner|move…)
// 数据: 重放每局，在每个落子时刻取其局面(先行方视角)，标签 = 该先行方是否最终获胜(+1/-1/0平)。
//       --stride 每隔 K 手采样一个局面，降相邻局面相关性与训练量。
//       --cap 限制最多训练对局数(调试用)。
// 优化: 手写 minibatch SGD + MSE，三层 3x3 卷积(ReLU)+价值头(逐点加权全局平均→标量)。零第三方依赖。
// 流式: 不缓存所有局面(planes 14.4KB/个)，每 epoch 重放棋谱，内存仅受 batch 约束。

import fs from "node:fs";
import path from "node:path";
import { GameSession } from "../src/GameSession.js";
import {
  buildPlanes, conv3x3Same, initValueWeights, serializeValueWeights,
  CIN, COUT, N,
} from "../src/policyNet.js";
import type { ValueWeights } from "../src/policyNet.js";

const S = 19;

// ===== 参数解析 =====
function argValue(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return def;
  return process.argv[i + 1];
}
const recordFile = process.argv[2];
const epochs = parseInt(argValue("--epochs", "3"), 10) || 3;
const outPath = argValue("--out", "assets/value_weights.json");
const lr = parseFloat(argValue("--lr", "0.0005")) || 0.0005;
const stride = parseInt(argValue("--stride", "8"), 10) || 1;
const BATCH = parseInt(argValue("--batch", "32"), 10) || 32;
const cap = parseInt(argValue("--cap", "0"), 10) || 0; // 0 = 不限

if (!recordFile || !fs.existsSync(recordFile)) {
  console.error("用法: node --import tsx scripts/trainValueNet.ts <records.txt> [--epochs N] [--out assets/value_weights.json] [--lr 0.001] [--stride 8] [--cap 0]");
  process.exit(1);
}

// ===== 读入棋谱行（仅存字符串，planes 不缓存） =====
const allLines = fs.readFileSync(recordFile, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
const lines = cap > 0 ? allLines.slice(0, cap) : allLines;
console.log(`加载棋谱: ${recordFile}  ${lines.length} 局${cap > 0 ? `(限制前 ${cap} 局)` : ""}`);

// ===== 卷积+ReLU 反向（与 trainPolicy 同构） =====
function reluCopy(Y: Float32Array): Float32Array {
  const A = new Float32Array(Y.length);
  for (let i = 0; i < A.length; i++) A[i] = Y[i] > 0 ? Y[i] : 0;
  return A;
}

interface FwdV { y1: Float32Array; x1: Float32Array; y2: Float32Array; x2: Float32Array; y3: Float32Array; x3: Float32Array; v: number; }
/** 价值前向(非就地，保留各层激活供反向)。 */
function forwardV(w: ValueWeights, planes: Float32Array): FwdV {
  const y1 = conv3x3Same(planes, CIN, COUT, w.conv1, w.b1);
  const x1 = reluCopy(y1);
  const y2 = conv3x3Same(x1, COUT, COUT, w.conv2, w.b2);
  const x2 = reluCopy(y2);
  const y3 = conv3x3Same(x2, COUT, COUT, w.conv3, w.b3);
  const x3 = reluCopy(y3);
  const vb = w.vBias[0];
  let sum = 0;
  for (let i = 0; i < N; i++) {
    let acc = vb;
    for (let ic = 0; ic < COUT; ic++) acc += x3[ic * N + i] * w.vHead[ic];
    sum += acc;
  }
  return { y1, x1, y2, x2, y3, x3, v: sum / N };
}

function reluGrad(Y: Float32Array, dY: Float32Array, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = Y[i] > 0 ? dY[i] : 0;
}
function convBackwardAcc(
  W: Float32Array, Xin: Float32Array, dY: Float32Array, Cin: number, Cout: number,
  accW: Float32Array, accB: Float32Array, dxin: Float32Array
): void {
  const sm1 = S - 1;
  for (let oc = 0; oc < Cout; oc++) {
    const oBase = oc * N;
    let bacc = 0;
    for (let r = 0; r < S; r++) { const oRow = oBase + r * S; for (let c = 0; c < S; c++) bacc += dY[oRow + c]; }
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
            const r2 = r + dr; if (r2 < 0 || r2 > sm1) continue;
            const xRow = iBase + r2 * S; const oRow = oBase + r * S;
            for (let c = 0; c < S; c++) {
              const c2 = c + dc; if (c2 < 0 || c2 > sm1) continue;
              wG += Xin[xRow + c2] * dY[oRow + c];
              dxin[xRow + c2] += dY[oRow + c] * W[wIdx];
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
  dW1: Float32Array; dB1: Float32Array; dW2: Float32Array; dB2: Float32Array; dW3: Float32Array; dB3: Float32Array;
  dVHead: Float32Array; dVBias: number;
}
function makeAcc(): Acc {
  return {
    dW1: new Float32Array(COUT * CIN * 9), dB1: new Float32Array(COUT),
    dW2: new Float32Array(COUT * COUT * 9), dB2: new Float32Array(COUT),
    dW3: new Float32Array(COUT * COUT * 9), dB3: new Float32Array(COUT),
    dVHead: new Float32Array(COUT), dVBias: 0,
  };
}
function zeroAcc(a: Acc): void {
  a.dW1.fill(0); a.dB1.fill(0); a.dW2.fill(0); a.dB2.fill(0); a.dW3.fill(0); a.dB3.fill(0);
  a.dVHead.fill(0); a.dVBias = 0;
}

/** 单样本价值前向+反向：返回 loss 与方向命中，梯度累加进 acc。 */
function backpropOne(w: ValueWeights, planes: Float32Array, label: number, acc: Acc): { loss: number; hit: boolean } {
  const f = forwardV(w, planes);
  const diff = f.v - label;
  const loss = diff * diff;

  // 价值头反向：v = mean_i vcell_i；dvcell_i = diff/N；dx3[ic,i] = dvcell_i·vHead[ic]
  const k = diff / N;
  const dx3 = new Float32Array(COUT * N);
  for (let ic = 0; ic < COUT; ic++) {
    const hw = w.vHead[ic];
    const base = ic * N;
    let hG = 0;
    for (let i = 0; i < N; i++) {
      const xv = f.x3[base + i];
      hG += k * xv;
      dx3[base + i] = k * hw;
    }
    acc.dVHead[ic] += hG;
  }
  acc.dVBias += diff; // sum_i k = diff

  // conv3/2/1 反向
  const dy3 = new Float32Array(COUT * N); reluGrad(f.y3, dx3, dy3);
  const dx2 = new Float32Array(COUT * N);
  convBackwardAcc(w.conv3, f.x2, dy3, COUT, COUT, acc.dW3, acc.dB3, dx2);
  const dy2 = new Float32Array(COUT * N); reluGrad(f.y2, dx2, dy2);
  const dx1 = new Float32Array(COUT * N);
  convBackwardAcc(w.conv2, f.x1, dy2, COUT, COUT, acc.dW2, acc.dB2, dx1);
  const dy1 = new Float32Array(COUT * N); reluGrad(f.y1, dx1, dy1);
  convBackwardAcc(w.conv1, planes, dy1, CIN, COUT, acc.dW1, acc.dB1, new Float32Array(CIN * N));

  return { loss, hit: (f.v > 0 && label > 0) || (f.v < 0 && label < 0) || (f.v === 0 && label === 0) };
}

// ===== SGD =====
function applySGD(w: ValueWeights, a: Acc, effLr: number): void {
  for (let i = 0; i < w.conv1.length; i++) w.conv1[i] -= effLr * a.dW1[i];
  for (let i = 0; i < w.b1.length; i++) w.b1[i] -= effLr * a.dB1[i];
  for (let i = 0; i < w.conv2.length; i++) w.conv2[i] -= effLr * a.dW2[i];
  for (let i = 0; i < w.b2.length; i++) w.b2[i] -= effLr * a.dB2[i];
  for (let i = 0; i < w.conv3.length; i++) w.conv3[i] -= effLr * a.dW3[i];
  for (let i = 0; i < w.b3.length; i++) w.b3[i] -= effLr * a.dB3[i];
  for (let i = 0; i < w.vHead.length; i++) w.vHead[i] -= effLr * a.dVHead[i];
  w.vBias[0] -= effLr * a.dVBias;
}

/** 重放一行棋谱，对每个落子时刻(按 stride)收集 (planes,label)：交替累积梯度与更新。 */
function trainGame(
  w: ValueWeights, winner: number, moveSeq: string[], acc: Acc,
): { n: number; sumLoss: number; hits: number } {
  const session = new GameSession({ enableDeployPhase: true });
  let lastIdx = -1;
  let n = 0, sumLoss = 0, hits = 0;
  const moves = moveSeq.split(/\s+/).filter((x) => x.length > 0);
  let ply = 0;
  for (const m of moves) {
    const curColor = session.toMove;
    // 采样本局面(先行方视角)，标签 = 先行方是否最终获胜
    if (ply % stride === 0) {
      const planes = buildPlanes(session.board, curColor, lastIdx);
      const label = winner === 0 ? 0 : (winner === curColor ? 1 : -1);
      const r = backpropOne(w, planes, label, acc);
      sumLoss += r.loss; if (r.hit) hits++; n++;
    }
    if (m === "p") { session.doPass(curColor); ply++; continue; }
    const dash = m.indexOf("-");
    if (dash < 0) { ply++; continue; }
    const r = parseInt(m.slice(0, dash), 10);
    const c = parseInt(m.slice(dash + 1), 10);
    if (Number.isNaN(r) || Number.isNaN(c)) { ply++; continue; }
    const out = session.playMove(curColor, r, c);
    if (out.ok) lastIdx = r * 19 + c;
    ply++;
  }
  return { n, sumLoss, hits };
}

// ===== 主流程 =====
const weights = initValueWeights(1234);
console.log(`价值网络参数: 骨干(${CIN}->${COUT}->${COUT}->${COUT}) + 价值头 ${COUT}->1，总参数 ${weights.conv1.length + weights.conv2.length * 2 + weights.b1.length * 3 + COUT + 1}`);

for (let ep = 0; ep < epochs; ep++) {
  // 洗牌棋谱行（游戏内顺序保留，batch 内随机性来自行序洗牌）
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }

  const acc = makeAcc();
  let sumLoss = 0, hits = 0, totalS = 0, inBatch = 0;
  const t0 = Date.now();

  for (const line of lines) {
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const winner = parseInt(line.slice(0, bar), 10);
    const seq = line.slice(bar + 1).trim();
    const r = trainGame(weights, winner, seq, acc);
    sumLoss += r.sumLoss; hits += r.hits; totalS += r.n; inBatch += r.n;
    if (inBatch >= BATCH) { applySGD(weights, acc, lr / inBatch); zeroAcc(acc); inBatch = 0; }
  }
  if (inBatch > 0) { applySGD(weights, acc, lr / inBatch); zeroAcc(acc); inBatch = 0; }

  const sec = (Date.now() - t0) / 1000 || 1e-9;
  const rmse = Math.sqrt(sumLoss / Math.max(totalS, 1));
  console.log(
    `epoch ${ep + 1}/${epochs}  样本${totalS}  RMSE=${rmse.toFixed(4)}  方向acc=${((hits / Math.max(totalS, 1)) * 100).toFixed(3)}%  用时${sec.toFixed(1)}s (${(totalS / sec).toFixed(0)}样本/s)`
  );
}

// 写出权重
if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(serializeValueWeights(weights)), "utf8");
console.log(`已写出: ${outPath}  (${fs.statSync(outPath).size} bytes)`);