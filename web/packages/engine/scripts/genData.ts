// 数据吞吐提升：多进程并发自对弈生成训练棋谱（策略/价值网络一期数据）。
// 实测吞吐（2026-08-25 校准）：
//   EASY/NORMAL 出真局 ~190-196 手/局，单 worker ~7-8 手/s，4 并发聚合 ~28 手/s；
//   HARD 单局 60-180s(~1-3 手/s/worker)，比 EASY 慢一个数量级，混入会拖垮墙钟时间。
// 结论：批量数据应以 NORMAL/EASY 为主体，HARD 占比 ≤1:5 或单独小批量跑。
// 用法:
//   node --import tsx scripts/genData.ts --workers 4 --games 500 --out scripts/data --ms 40 --mix 3:2:1
//   --workers N   并发 worker 进程数（默认 4）
//   --games  G    总对局数（默认 500）
//   --out    dir  输出目录，每个 worker 写 records_<i>.txt，完成后合并为 records_all.txt
//   --ms     T    每手下限思考毫秒（默认 40；越小越快、数据质量越低）
//   --mix    H:N:E 困难/普通/简单 权重（默认 3:2:1，困难主体+简单补多样性）
//   --nlayout     禁用布局阶段（快速乱战，记录阶段与后续训练不一致，默认不传）
//   --noMCTS      数据生成的 HARD 也关掉 MCTS（更快，默认关闭 MCTS 以提速）
//   --plies  P    单局手数上限（默认 240）
// 内部：driver(--workers>=1 且非 --worker) 用 child_process 派生 N 个自进程 worker；
//       worker(--worker i) 真实对弈并写各自独立文件避免写竞争，全部完成后 driver 合并。

import { GameSession } from "../src/GameSession.js";
import { Color } from "../src/Const.js";
import {
  AIEngine, AIDifficulty, getAIConfig, AIConfig,
} from "../src/AI.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const ARGV = process.argv.slice(2);
function flagVal(k: string, def: string): string {
  const i = ARGV.findIndex((a) => a.startsWith(k + "="));
  if (i >= 0) return ARGV[i].slice(k.length + 1);
  const j = ARGV.indexOf(k); // 支持空格分隔 `--k value`
  if (j >= 0 && j + 1 < ARGV.length && !ARGV[j + 1].startsWith("--")) return ARGV[j + 1];
  return def;
}
function has(k: string): boolean { return ARGV.includes(k); }
const isWorker = has("--worker");
const workerIdx = isWorker ? parseInt(flagVal("--worker", "0"), 10) : -1;

const workers = parseInt(flagVal("--workers", "4"), 10) || 4;
const gamesTotal = parseInt(flagVal("--games", "500"), 10) || 500;
const outDir = flagVal("--out", "scripts/data");
const ms = parseInt(flagVal("--ms", "40"), 10) || 40;
const mixRaw = flagVal("--mix", "3:2:1").split(":").map((s) => parseInt(s, 10) || 0);
const noLayout = has("--nlayout");
const noMCTS = !has("--mcts"); // 默认关 MCTS 提速；传 --mcts 则 HARD 保留 MCTS
const pliesCap = parseInt(flagVal("--plies", "240"), 10) || 240;

const DIFFS: AIDifficulty[] = [AIDifficulty.HARD, AIDifficulty.NORMAL, AIDifficulty.EASY];

function total(b: { occupationTerritory: number; occupationEfficiency: number; defenseAnnihilate: number; defenseSiege: number; casualtyLoss: number; casualtySpecial: number; specialReward: number }): number {
  return b.occupationTerritory + b.occupationEfficiency + b.defenseAnnihilate + b.defenseSiege + b.casualtyLoss + b.casualtySpecial + b.specialReward;
}

// 数据生成的加速配置：压思考时间、削精读候选/关 MCTS，换取吞吐
function makeGenCfg(d: AIDifficulty, color: Color): { engine: AIEngine; cfg: AIConfig } {
  const cfg = getAIConfig(d);
  cfg.thinkTimeMs = ms; // 与 selfplay 一致直接用 ms；不 *3（*3 会让低 ms 下 AI 过早 pass）
  // 压缩细分开销：HARD 削精读但仍保留足以出真手的深度/候选；
  // 关 MCTS(数据生成默认)是主要提速来源（HARD 全配置 MCTS 太慢）。
  if (d === AIDifficulty.HARD) {
    cfg.maxCandidates = 20;
    cfg.refineCands = 10;
    cfg.refinePly = 3;
    cfg.mctsSims = noMCTS ? 0 : 100;
  }
  if (d === AIDifficulty.NORMAL) {
    cfg.mctsSims = 0;
  }
  if (d === AIDifficulty.EASY) {
    cfg.mctsSims = 0;
  }
  return { engine: new AIEngine(color, d), cfg };
}

// 按 mix 权重从 [HARD,NORMAL,EASY] 抽一个难度（打散顺序）
function pickDiff(rng: () => number): AIDifficulty {
  const weights = [mixRaw[0] || 0, mixRaw[1] || 0, mixRaw[2] || 0];
  const s = weights[0] + weights[1] + weights[2];
  let x = rng() * (s || 1);
  for (let i = 0; i < 3; i++) { if (x < weights[i]) return DIFFS[i]; x -= weights[i]; }
  return DIFFS[0];
}

function playOne(shard: string, rng: () => number): { plies: number; moves: number } {
  const d = pickDiff(rng);
  const blackAI = makeGenCfg(d, Color.BLACK);
  const whiteAI = makeGenCfg(pickDiff(rng), Color.WHITE); // 对手另一随机难度，增加多样性

  const s = new GameSession({ enableDeployPhase: !noLayout });
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
      if (!out.ok) { s.doPass(color); seq.push("p"); }
      else seq.push(`${move.row}-${move.col}`);
    }
    plies++;
  }
  const sc = s.scores();
  const bs = total(sc.black), ws = total(sc.white);
  const winner = bs > ws ? Color.BLACK : bs < ws ? Color.WHITE : 0;
  let moves = 0;
  for (const m of seq) if (m !== "p") moves++;
  fs.appendFileSync(path.join(outDir, `records_${shard}.txt`), `${winner}|${seq.join(" ")}\n`);
  return { plies, moves };
}

function runWorker(idx: number, games: number): void {
  fs.mkdirSync(outDir, { recursive: true });
  const shardFile = path.join(outDir, `records_${idx}.txt`);
  fs.writeFileSync(shardFile, ""); // 清空分片，避免上次残留被合并
  // 用固定种子区分 worker，保证可复现
  let st = 1000 + idx * 7919;
  const rng = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const t0 = Date.now();
  let totalMoves = 0;
  for (let g = 0; g < games; g++) {
    totalMoves += playOne(String(idx), rng).moves;
  }
  const sec = (Date.now() - t0) / 1000 || 1e-9;
  console.log(`[worker ${idx}] ${games}局 ${totalMoves}落子 ${sec.toFixed(1)}s @ ${(totalMoves / sec).toFixed(1)}落子/s`);
}

// ===== driver：派生 N 个 worker 并合并 =====
if (!isWorker) {
  if (workers < 1) { console.error("--workers 至少 1"); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const per = Math.ceil(gamesTotal / workers);
  const procs: ReturnType<typeof spawn>[] = [];
  let sharedIdx = 0;
  for (let i = 0; i < workers; i++) {
    const games = Math.max(0, Math.min(per, gamesTotal - sharedIdx));
    sharedIdx += games;
    if (games <= 0) break;
    const args = ["--import", "tsx", __filename, "--worker", String(i), "--out", outDir,
      "--ms", String(ms), "--mix", mixRaw.join(":"), "--games", String(games), "--plies", String(pliesCap)];
    if (noLayout) args.push("--nlayout");
    if (noMCTS) args.push("--noMCTS");
    procs.push(spawn(process.execPath, args, { stdio: "inherit" }));
  }
  let remaining = procs.length;
  const t0 = Date.now();
  procs.forEach((p) => {
    p.on("exit", () => {
      remaining--;
      if (remaining === 0) {
        const all: string[] = [];
        for (let i = 0; i < workers; i++) {
          const f = path.join(outDir, `records_${i}.txt`);
          if (fs.existsSync(f)) {
            all.push(fs.readFileSync(f, "utf8"));
            try { fs.unlinkSync(f); } catch { /* ignore */ }
          }
        }
        const merged = path.join(outDir, "records_all.txt");
        fs.writeFileSync(merged, all.join("").replace(/\n+$/, "") + "\n");
        const totalSec = (Date.now() - t0) / 1000 || 1e-9;
        const content = fs.readFileSync(merged, "utf8");
        const lines = content.split("\n").filter((l) => l.trim()).length;
        const bytes = fs.statSync(merged).size;
        console.log(`合并完成: ${merged}  ${lines}局  ${bytes}bytes  ${totalSec.toFixed(1)}s 平均${(totalSec / lines).toFixed(2)}s/局`);
      }
    });
  });
} else {
  runWorker(workerIdx, gamesTotal);
}