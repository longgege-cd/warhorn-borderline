// 策略卷积网络：3层 3x3 同 padding 卷积(10->32->32->32, ReLU) + 1x1 头(32->1)
// 纯 TS 零外部依赖，浏览器与 node 通用。
// 棋盘为 19x19 (BOARD_SIZE)，N=361。状态编码为 CIN=10 个 361 长度平面。

import { BOARD_SIZE, Color, isAttackZone, isDefenseZone } from "./Const.js";
import type { BoardModel } from "./BoardModel.js";

export const CIN = 10;
export const COUT = 32;
export const N = BOARD_SIZE * BOARD_SIZE; // 361
const SIZE = BOARD_SIZE;
const K9 = 9; // 3x3 核体积

// ===== 权重容器 =====
// conv1: Cout x Cin x 3 x 3   (32 x 10 x 9)
// conv2: Cout x Cout x 3 x 3  (32 x 32 x 9)
// conv3: Cout x Cout x 3 x 3  (32 x 32 x 9)
// head : Cout (32 -> 1)，headB 为偏置标量
export interface PolicyWeights {
  conv1: Float32Array;
  b1: Float32Array; // Cout
  conv2: Float32Array;
  b2: Float32Array;
  conv3: Float32Array;
  b3: Float32Array;
  head: Float32Array; // Cout
  headB: Float32Array; // 1
}

// 乘加种子伪随机（Xavier 初始化用）
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Xavier 初始化卷积核(半径 sqrt(6/(fanIn+fanOut)))、0 偏置。seed 省略则用 Math.random。 */
export function initWeights(seed?: number): PolicyWeights {
  const rand = seed !== undefined ? mulberry32(seed) : Math.random;
  // fanIn/fanOut 为通道数；核长 = fanOut * (fanIn * K9)。注意 fanIn 不要再乘 K9。
  const makeConv = (fanIn: number, fanOut: number): Float32Array => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    const a = new Float32Array(fanOut * fanIn * K9);
    for (let i = 0; i < a.length; i++) a[i] = (rand() * 2 - 1) * limit;
    return a;
  };
  const head = new Float32Array(COUT);
  for (let i = 0; i < head.length; i++) head[i] = (rand() * 2 - 1) / Math.sqrt(COUT);
  return {
    conv1: makeConv(CIN, COUT),
    b1: new Float32Array(COUT),
    conv2: makeConv(COUT, COUT),
    b2: new Float32Array(COUT),
    conv3: makeConv(COUT, COUT),
    b3: new Float32Array(COUT),
    head,
    headB: new Float32Array(1),
  };
}

// ===== 状态平面编码 =====
const DIRS: ReadonlyArray<ReadonlyArray<number>> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

/** 构造 CIN*N 的状态平面。
 *  0 己方子  1 对方子  2 空点  3 attackZone(该行 isAttackZone(toMove))
 *  4 defenseZone(己半场或边境)  5 lastIdx 热点(小于0 全0)  6 己方点有气(紧邻空)
 *  7 对方点有气  8 己方块大小(连通块数/4 封顶1)  9 常数边界(行/列==0或==18)
 */
export function buildPlanes(board: BoardModel, toMove: number, lastIdx: number): Float32Array {
  const size = board.size;
  const p = new Float32Array(CIN * N);
  const grid = board.grid;
  const enemy = toMove === Color.BLACK ? Color.WHITE : Color.BLACK;

  for (let r = 0; r < size; r++) {
    const attack = isAttackZone(r, toMove as Color) ? 1 : 0;
    const def = isDefenseZone(r, toMove as Color) ? 1 : 0;
    const rBase = r * size;
    for (let c = 0; c < size; c++) {
      const idx = rBase + c;
      const cell = grid[idx] as number;
      if (cell === toMove) p[0 * N + idx] = 1;
      else if (cell === enemy) p[1 * N + idx] = 1;
      else p[2 * N + idx] = 1;
      p[3 * N + idx] = attack;
      p[4 * N + idx] = def;
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) p[9 * N + idx] = 1;
    }
  }

  if (lastIdx >= 0 && lastIdx < N) p[5 * N + lastIdx] = 1;

  // 平面 6/7：气（紧邻空点）
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      const cell = grid[idx] as number;
      if (cell !== toMove && cell !== enemy) continue;
      let lib = 0;
      for (const [dr, dc] of DIRS) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= size || c2 < 0 || c2 >= size) continue;
        if (grid[r2 * size + c2] === Color.EMPTY) { lib = 1; break; }
      }
      if (lib) p[(cell === toMove ? 6 : 7) * N + idx] = 1;
    }
  }

  // 平面 8：己方连通块大小 /4 封顶 1
  const visited = new Uint8Array(N);
  const stack: number[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      if (grid[idx] !== toMove || visited[idx]) continue;
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      let count = 0;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        count++;
        const cr = (cur / size) | 0, cc = cur % size;
        for (const [dr, dc] of DIRS) {
          const r2 = cr + dr, c2 = cc + dc;
          if (r2 < 0 || r2 >= size || c2 < 0 || c2 >= size) continue;
          const nIdx = r2 * size + c2;
          if (grid[nIdx] === toMove && !visited[nIdx]) { visited[nIdx] = 1; stack.push(nIdx); }
        }
      }
      const val = Math.min(count / 4, 1);
      p[8 * N + idx] = val;
    }
  }

  return p;
}

// ===== 前向 =====
/** 3x3 同 padding 卷积。X: Cin*N, W: Cout x Cin x 3 x 3, B: Cout。返回 Cout*N。 */
export function conv3x3Same(
  X: Float32Array, Cin: number, Cout: number, W: Float32Array, B: Float32Array
): Float32Array {
  const Y = new Float32Array(Cout * N);
  for (let oc = 0; oc < Cout; oc++) {
    const oBase = oc * N;
    const bias = B[oc];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        let acc = bias;
        for (let ic = 0; ic < Cin; ic++) {
          const iBase = ic * N;
          const wBase = oc * (Cin * K9) + ic * K9;
          for (let di = 0; di < 3; di++) {
            const r2 = r + di - 1;
            if (r2 < 0 || r2 >= SIZE) continue;
            const wRow = wBase + di * 3;
            const xRowBase = iBase + r2 * SIZE;
            for (let dj = 0; dj < 3; dj++) {
              const c2 = c + dj - 1;
              if (c2 < 0 || c2 >= SIZE) continue;
              acc += X[xRowBase + c2] * W[wRow + dj];
            }
          }
        }
        Y[oBase + r * SIZE + c] = acc;
      }
    }
  }
  return Y;
}

/** 就地 ReLU（便于训练时保留激活前后状态）。 */
export function reluInPlace(A: Float32Array): Float32Array {
  for (let i = 0; i < A.length; i++) if (A[i] < 0) A[i] = 0;
  return A;
}

/** 完整前向，返回未掩 361 logits。 */
export function forwardLogits(w: PolicyWeights, planes: Float32Array): Float32Array {
  const x1 = reluInPlace(conv3x3Same(planes, CIN, COUT, w.conv1, w.b1));
  const x2 = reluInPlace(conv3x3Same(x1, COUT, COUT, w.conv2, w.b2));
  const x3 = reluInPlace(conv3x3Same(x2, COUT, COUT, w.conv3, w.b3));
  const logits = new Float32Array(N);
  const hb = w.headB[0];
  for (let ic = 0; ic < COUT; ic++) {
    const hw = w.head[ic];
    const base = ic * N;
    for (let i = 0; i < N; i++) logits[i] += x3[base + i] * hw;
  }
  for (let i = 0; i < N; i++) logits[i] += hb;
  return logits;
}

/** 占点掩：occupiedMask[i]===true 的点置 -Infinity，返回 softmax 概率。 */
export function policyProbs(
  w: PolicyWeights, planes: Float32Array, occupiedMask: boolean[]
): Float32Array {
  const logits = forwardLogits(w, planes);
  for (let i = 0; i < N; i++) if (occupiedMask[i]) logits[i] = -Infinity;
  return softmaxInPlace(logits);
}

/** 就地稳定 softmax（自动处理 -Infinity），返回输入。 */
export function softmaxInPlace(logits: Float32Array): Float32Array {
  let mx = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] === -Infinity) { logits[i] = 0; continue; }
    const e = Math.exp(logits[i] - mx);
    logits[i] = e;
    sum += e;
  }
  if (sum > 0) for (let i = 0; i < logits.length; i++) logits[i] /= sum;
  return logits;
}

// ===== 价值网络（共享 conv1-3 骨干，价值头为逐点加权后全局平均→标量） =====
// 用途：主训价值网络替代启发式评估。价值头 vHead: Cout->1，vBias 标量。
// 输出 v = mean_cells( sum_ic x3[ic]·vHead[ic] + vBias )，线性出值，目标 ±1。
export interface ValueWeights {
  conv1: Float32Array; b1: Float32Array;
  conv2: Float32Array; b2: Float32Array;
  conv3: Float32Array; b3: Float32Array;
  vHead: Float32Array; // Cout
  vBias: Float32Array; // 1
}

/** 初始化价值网络权重（骨干同策略网，价值头 Xavier）。seed 省略则用 Math.random。 */
export function initValueWeights(seed?: number): ValueWeights {
  const rand = seed !== undefined ? mulberry32(seed) : Math.random;
  const makeConv = (fanIn: number, fanOut: number): Float32Array => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    const a = new Float32Array(fanOut * fanIn * K9);
    for (let i = 0; i < a.length; i++) a[i] = (rand() * 2 - 1) * limit;
    return a;
  };
  const vHead = new Float32Array(COUT);
  for (let i = 0; i < vHead.length; i++) vHead[i] = (rand() * 2 - 1) / Math.sqrt(COUT);
  return {
    conv1: makeConv(CIN, COUT), b1: new Float32Array(COUT),
    conv2: makeConv(COUT, COUT), b2: new Float32Array(COUT),
    conv3: makeConv(COUT, COUT), b3: new Float32Array(COUT),
    vHead, vBias: new Float32Array(1),
  };
}

/** 价值前向：返回标量 v（线性，未激活）。 */
export function forwardValue(w: ValueWeights, planes: Float32Array): number {
  const x1 = reluInPlace(conv3x3Same(planes, CIN, COUT, w.conv1, w.b1));
  const x2 = reluInPlace(conv3x3Same(x1, COUT, COUT, w.conv2, w.b2));
  const x3 = reluInPlace(conv3x3Same(x2, COUT, COUT, w.conv3, w.b3));
  const vb = w.vBias[0];
  let sum = 0;
  for (let i = 0; i < N; i++) {
    let acc = vb;
    for (let ic = 0; ic < COUT; ic++) acc += x3[ic * N + i] * w.vHead[ic];
    sum += acc;
  }
  return sum / N;
}

/** 从纯 JSON（serializeValueWeights 产出的 Record<string, number[]>）解析回价值网络权重。 */
export function parseValueWeights(r: Record<string, number[]>): ValueWeights {
  return {
    conv1: Float32Array.from(r.conv1), b1: Float32Array.from(r.b1),
    conv2: Float32Array.from(r.conv2), b2: Float32Array.from(r.b2),
    conv3: Float32Array.from(r.conv3), b3: Float32Array.from(r.b3),
    vHead: Float32Array.from(r.vHead), vBias: Float32Array.from(r.vBias),
  };
}

/** 序列化价值网络权重为纯 JSON（5 位有效数字压体积）。 */
export function serializeValueWeights(w: ValueWeights): Record<string, number[]> {
  const r5 = (a: Float32Array): number[] => {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Number(a[i].toPrecision(5));
    return out;
  };
  return {
    conv1: r5(w.conv1), b1: r5(w.b1),
    conv2: r5(w.conv2), b2: r5(w.b2),
    conv3: r5(w.conv3), b3: r5(w.b3),
    vHead: r5(w.vHead), vBias: [Number(w.vBias[0].toPrecision(5))],
  };
}

/** 序列化为纯 JSON 对象（普通 number 数组），便于 JSON.stringify 存盘。 */
export function serializeWeights(w: PolicyWeights): Record<string, number[]> {
  // 每个权重四舍五入到 5 位有效数字，控制 JSON 体积（硬指标 ≤1.5MB）
  const r5 = (a: Float32Array): number[] => {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Number(a[i].toPrecision(5));
    return out;
  };
  return {
    conv1: r5(w.conv1),
    b1: r5(w.b1),
    conv2: r5(w.conv2),
    b2: r5(w.b2),
    conv3: r5(w.conv3),
    b3: r5(w.b3),
    head: r5(w.head),
    headB: [Number(w.headB[0].toPrecision(5))],
  };
}