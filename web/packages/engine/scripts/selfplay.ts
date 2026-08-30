// 自我对弈强度验证（AI 算法文档 v9.0 §十二）
// 驱动两个难度的 AI 对弈若干局，统计"强者"胜率，用于验证难度梯度与调优。
// 用法:
//   node --import tsx scripts/selfplay.ts NORMAL EASY
//   node --import tsx scripts/selfplay.ts NORMAL EASY --games 3 --plies 200 --full
// --full 使用真实 thinkTimeMs；否则统一缩到 300ms 做快速粗验。
import { GameSession } from "../src/GameSession.js";
import { Color } from "../src/Const.js";
import {
  AIEngine,
  AIDifficulty,
  getAIConfig,
  AI_DIFFICULTY_NAMES,
} from "../src/AI.js";

const [, , strongerRaw, weakerRaw] = process.argv;
// BUG 修复：原 `argv[argv.indexOf("--games")+1]` 在未传 --games 时 indexOf=-1→读取 argv[0](node路径)→parseInt=NaN，
// 导致 `plies<cap` 恒 false、对局 0 手即结束。改为 findIndex 判断后回退默认值。
function getOptI(k: string): number { return process.argv.findIndex((a) => a === k); }
const games = (getOptI("--games") >= 0 ? parseInt(process.argv[getOptI("--games") + 1] ?? "3", 10) : 3) || 3;
const pliesCap = (getOptI("--plies") >= 0 ? parseInt(process.argv[getOptI("--plies") + 1] ?? "240", 10) : 240) || 240;
const full = process.argv.includes("--full");
const noLayout = process.argv.includes("--nlayout"); // 禁用布局阶段（快速乱战模式）
const noIter = process.argv.includes("--noIter"); // 对比实验：强制大师走非迭代路径（sortCandidatesByGain+MCTS）
const trace = process.argv.includes("--trace"); // 追踪每 20 手分数变化，定位崩盘
// HARD 调优开关（仅对 stronger=HARD 或 weaker=HARD 生效）：
//   --hRc=20  强制 HARD refineCands=20（原 12，扩精读候选）
//   --hDiv=light  强制 HARD diversity="light"（原 full，减轻同群惩罚）
//   --hSaf=filter  强制 HARD safety="filter"（原 full，降低保守度）
//   --hRef=5  强制 HARD refinePly=5（原 4，加深一层）
function parseOverride<T = any>(key: string): T | undefined {
  const i = process.argv.findIndex((a) => a.startsWith(key + "="));
  if (i < 0) return undefined;
  return process.argv[i].slice(key.length + 1) as unknown as T;
}
const hRc = parseOverride<number>("--hRc");
const hDiv = parseOverride<string>("--hDiv");
const hSaf = parseOverride<string>("--hSaf");
const hRef = parseOverride<number>("--hRef");

// 策略网络一期(方案 doc)：--dump <file> 追加导出紧凑棋谱供训练重放。
// 格式每盘一行：winner|r-c r-c …（r-c 十进制坐标，虚手记 p）
// 记录 black/white total(不含贴目) 判胜者，实际落子 vs 非法兜底 pass 一并以 move 序列记录。
import fs from "node:fs";
const dumpFile = process.argv[getOptI("--dump") >= 0 ? getOptI("--dump") + 1 : -1];

// 价值网络软校正：--vnet=<weight.json> 注入已训权重(缺省值 0 关闭=基线)；--vnetW= 调修正强度
import { setValueNetWeight } from "../src/AI.js";
import { parseValueWeights } from "../src/policyNet.js";
const vnetRaw = process.argv[getOptI("--vnet") >= 0 ? getOptI("--vnet") + 1 : undefined];
const vnetW = parseOverride<number>("--vnetW") ?? 6;
if (vnetRaw) {
  if (!fs.existsSync(vnetRaw)) {
    console.error(`价值网络权重不存在: ${vnetRaw}`);
    process.exit(1);
  }
  const w = parseValueWeights(JSON.parse(fs.readFileSync(vnetRaw, "utf8")));
  setValueNetWeight(w, vnetW);
  console.log(`[VNET] 已注入价值网络软校正(${vnetRaw}, 强度 ${vnetW})`);
}

const DIFFS: Record<string, AIDifficulty> = {
  EASY: AIDifficulty.EASY,
  NORMAL: AIDifficulty.NORMAL,
  HARD: AIDifficulty.HARD,
};

if (!strongerRaw || !weakerRaw || !(strongerRaw in DIFFS) || !(weakerRaw in DIFFS)) {
  console.error("用法: node --import tsx scripts/selfplay.ts <强者> <弱者> [--games N] [--plies N] [--full]");
  console.error("难度: " + Object.keys(DIFFS).join(" / "));
  process.exit(1);
}

const stronger = DIFFS[strongerRaw];
const weaker = DIFFS[weakerRaw];

// AI 构造：可选缩小思考时间以加速粗验
function makeStrength(color: Color, d: AIDifficulty): { engine: AIEngine; cfg: ReturnType<typeof getAIConfig> } {
  const cfg = getAIConfig(d);
  // 对比实验(--noIter)：大师走非迭代路径，隔离验证"迭代加深搜索是否拖累棋力"
  if (noIter) (cfg as { useIterative: boolean }).useIterative = false;
  // HARD 调优 override（仅 HARD 难度）
  if (d === AIDifficulty.HARD) {
    if (hRc !== undefined) (cfg as { refineCands: number }).refineCands = hRc;
    if (hDiv !== undefined) (cfg as { diversity: "off" | "light" | "full" }).diversity = hDiv as any;
    if (hSaf !== undefined) (cfg as { safety: "off" | "filter" | "full" | "master" }).safety = hSaf as any;
    if (hRef !== undefined) (cfg as { refinePly: number }).refinePly = hRef;
  }
  if (!full) (cfg as { thinkTimeMs: number }).thinkTimeMs = 300;
  return { engine: new AIEngine(color, d), cfg };
}

function total(b: { occupationTerritory: number; occupationEfficiency: number; defenseAnnihilate: number; defenseSiege: number; casualtyLoss: number; casualtySpecial: number; specialReward: number }): number {
  return b.occupationTerritory + b.occupationEfficiency + b.defenseAnnihilate + b.defenseSiege + b.casualtyLoss + b.casualtySpecial + b.specialReward;
}

function playOne(stB: boolean): { winStronger: boolean; plies: number; scoreDiff: number; seq: string[]; blackScore: number; whiteScore: number } {
  const s = new GameSession({ enableDeployPhase: !noLayout });
  const blackAI = makeStrength(Color.BLACK, stB ? stronger : weaker);
  const whiteAI = makeStrength(Color.WHITE, !stB ? stronger : weaker);
  const strongerColor = stB ? Color.BLACK : Color.WHITE;

  const seq: string[] = [];
  let plies = 0;
  while (!s.gameOver && plies < pliesCap) {
    const color = s.toMove;
    const ai = color === Color.BLACK ? blackAI : whiteAI;
    const move = ai.engine.chooseMove(s, ai.cfg);
    if (move.type === "pass") {
      s.doPass(color);
      seq.push("p");
    } else {
      const out = s.playMove(color, move.row, move.col);
      if (!out.ok) {
        // 非法落子（极罕见）：视为虚手兜底，避免死循环
        s.doPass(color);
        seq.push("p");
      } else {
        seq.push(`${move.row}-${move.col}`);
      }
    }
    plies++;
    // --trace：每 20 手输出当前分数，定位崩盘起始手数
    if (trace && plies % 20 === 0) {
      const sc = s.scores();
      const bs = total(sc.black), ws = total(sc.white);
      const tag = color === strongerColor ? "强" : "弱";
      const mv = move.type === "pass" ? "pass" : `(${move.row},${move.col})`;
      console.log(`    [手${plies}] ${tag}方${color === Color.BLACK ? "黑" : "白"} 下 ${mv} | 黑=${bs.toFixed(1)} 白=${ws.toFixed(1)} 差=${(stB ? bs - ws : ws - bs).toFixed(1)}`);
    }
  }

  const sc = s.scores();
  if (process.env.SELFPLAY_DEBUG) {
    console.log(JSON.stringify({ ply: s.ply, black: sc.black, white: sc.white }, null, 1));
  }
  const blackScore = total(sc.black);
  const whiteScore = total(sc.white);
  // 以 total 判强弱（不含贴目，对称公平），平局计强者不胜
  const diff = stB ? blackScore - whiteScore : whiteScore - blackScore;
  return { winStronger: diff > 0, plies, scoreDiff: diff, seq, blackScore, whiteScore };
}

// 每盘写一行紧凑棋谱供策略网络训练(P0)
function writeRecord(seq: string[], blackScore: number, whiteScore: number): void {
  if (!dumpFile || seq.length === 0) return;
  const winner = blackScore > whiteScore ? Color.BLACK : blackScore < whiteScore ? Color.WHITE : 0;
  fs.appendFileSync(dumpFile, `${winner}|${seq.join(" ")}\n`);
}

console.log(`自我对弈：${AI_DIFFICULTY_NAMES[stronger]} 执子 vs ${AI_DIFFICULTY_NAMES[weaker]}  共 ${games} 局${full ? "（真实思考）" : "（快速 300ms）"}`);
let strongWins = 0;
let sumPlies = 0;
let sumDiff = 0;
for (let i = 0; i < games; i++) {
  const stB = i % 2 === 0; // 交替执黑白，消除先手偏向
  const r = playOne(stB);
  if (r.winStronger) strongWins++;
  sumPlies += r.plies;
  sumDiff += r.scoreDiff;
  writeRecord(r.seq, r.blackScore, r.whiteScore);
  const mark = r.winStronger ? "强者胜" : "弱者/平";
  console.log(
    `  第${i + 1}局 执${stB ? "黑" : "白"}：${mark}  (强弱分差=${r.scoreDiff >= 0 ? "+" : ""}${r.scoreDiff.toFixed(1)}，手数=${r.plies})`
  );
}
const rate = (strongWins / games) * 100;
console.log(`\n强者胜率：${strongWins}/${games} = ${rate.toFixed(0)}%  平均分差=${(sumDiff / games).toFixed(1)}  平均手数=${Math.round(sumPlies / games)}`);