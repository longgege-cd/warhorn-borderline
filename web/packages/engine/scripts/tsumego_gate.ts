// 死活题闯关评测：让指定难度 AI 逐关下首手，对照题库正解首手集（nextHintMoves）判命中。
// 用法: node --import tsx scripts/tsumego_gate.ts HARD [--ms 800]
import { GameSession } from "../src/GameSession.js";
import { Color } from "../src/Const.js";
import {
  AIEngine, AIDifficulty, getAIConfig,
} from "../src/AI.js";
import { getPuzzleList, buildPuzzleBoard, isCorrectNext } from "../src/index.js";

const diffRaw = process.argv[2] ?? "HARD";
const ms = parseInt(process.argv[process.argv.indexOf("--ms") + 1] ?? "800", 10);
const DIFFS: Record<string, AIDifficulty> = {
  EASY: AIDifficulty.EASY, NORMAL: AIDifficulty.NORMAL, HARD: AIDifficulty.HARD,
};
const diff = DIFFS[diffRaw.toUpperCase()];
if (diff === undefined) { console.error("难度: EASY/NORMAL/HARD"); process.exit(1); }

const cfg = getAIConfig(diff);
cfg.thinkTimeMs = ms;

const LEVEL_LABEL: Record<number, string> = { 1: "易", 2: "普通", 3: "难", 4: "大师" };
const perLevel = new Map<number, { pass: number; total: number }>();
let pass = 0;
const fails: string[] = [];

for (const p of getPuzzleList()) {
  const session = new GameSession({ enableDeployPhase: false });
  const b = buildPuzzleBoard(p);
  for (let r = 0; r < b.size; r++)
    for (let c = 0; c < b.size; c++)
      session.board.setAt(r, c, b.grid[r * b.size + c]);
  session.toMove = p.solver;
  const ai = new AIEngine(p.solver, diff);
  const t0 = Date.now();
  const move = ai.chooseMove(session, cfg);
  const ok = move.type === "move" && isCorrectNext(p, [], [move.row, move.col]);
  const stat = perLevel.get(p.level) ?? { pass: 0, total: 0 };
  stat.total++; if (ok) stat.pass++;
  perLevel.set(p.level, stat);
  if (ok) pass++;
  else fails.push(`${p.source}(L${p.level}) AI=(${move.row},${move.col})`);
  console.log(
    `[${ok ? "√" : "×"}] ${p.source} L${p.level}(${LEVEL_LABEL[p.level]}) 执${p.solver === Color.BLACK ? "黑" : "白"} ` +
    `AI首手=(${move.row},${move.col}) ${Date.now() - t0}ms`
  );
}

console.log(`\n===== ${diffRaw} | 30关首手闯关 | think=${ms}ms =====`);
console.log(`总计: ${pass}/30`);
for (const [lv, s] of [...perLevel.entries()].sort((a, b) => a[0] - b[0]))
  console.log(`  L${lv}(${LEVEL_LABEL[lv]}): ${s.pass}/${s.total}`);
console.log("未命中首手:");
for (const f of fails) console.log(`  ${f}`);