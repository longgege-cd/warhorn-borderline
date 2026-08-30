// 围空能力基准测试（2026-08-24）
// 三个维度：
//   §1 围空封口构造   : 缺口棋墙局面，AI 能否一手封口形成完整围空圈（对应死活做活题）
//   §2 破围/点眼      : 对方已围成闭合圈，AI 首手能否落入对方围空圈内部破空
//   §3 全盘围空效率   : 各档 AI 执黑自战固定手数，统计其围空圈数与围空空点数
// 判定口径全部基于 TerritoryDetector.enclosures 的围空圈闭合/覆盖。
// 运行: node --import tsx bench/enclosure_bench.ts [--diff EASY|NORMAL|HARD] [--ms N] [--hands N]

import { GameSession } from "../src/GameSession.js";
import { Color, opponent } from "../src/Const.js";
import { BoardModel } from "../src/BoardModel.js";
import { TerritoryDetector } from "../src/TerritoryDetector.js";
import { AIEngine, AIDifficulty, getAIConfig } from "../src/AI.js";

const KEY = (r: number, c: number): number => r * 19 + c;

// 画一个空心矩形边框（某色棋子墙），连成一块作为包围圈
function drawRectWall(b: BoardModel, color: Color, r0: number, c0: number, r1: number, c1: number): void {
  for (let c = c0; c <= c1; c++) {
    b.setAt(r0, c, color);
    b.setAt(r1, c, color);
  }
  for (let r = r0; r <= r1; r++) {
    b.setAt(r, c0, color);
    b.setAt(r, c1, color);
  }
}

// 指定色是否形成了覆盖 expectInside 全部点的围空圈
function sealed(b: BoardModel, color: Color, expectInside: Set<number>): boolean {
  for (const e of TerritoryDetector.enclosuresOf(b, color)) {
    let ok = true;
    for (const k of expectInside) {
      if (!e.points.some((p) => KEY(p.row, p.col) === k)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ====== §1 围空封口构造题 ======
// 4x4 墙框内部留 2x2 空，墙上一非角点作缺口（内部空腔经缺口与外连通）。
// AI 执墙色，唯一封口点 = 缺口，落子后内部 2x2 成该色围空圈。
function buildSeal(
  color: Color, ro: number, co: number,
  edge: "top" | "bottom" | "left" | "right", pos: number
): { b: BoardModel; expectInside: Set<number> } {
  const b = new BoardModel(19);
  drawRectWall(b, color, ro, co, ro + 3, co + 3);
  const gap: [number, number] =
    edge === "top" ? [ro, co + pos]
    : edge === "bottom" ? [ro + 3, co + pos]
    : edge === "left" ? [ro + pos, co]
    : [ro + pos, co + 3];
  b.setAt(gap[0], gap[1], Color.EMPTY); // 开口缺口
  const exp = new Set<number>();
  for (let r = ro + 1; r <= ro + 2; r++)
    for (let c = co + 1; c <= co + 2; c++) exp.add(KEY(r, c));
  return { b, expectInside: exp };
}

// 封口题落点：不同框位置 + 四条边，黑白各若干
const sealSpecs: Array<{ color: Color; ro: number; co: number; edge: "top" | "bottom" | "left" | "right"; pos: number }> = [
  { color: Color.BLACK, ro: 2, co: 3, edge: "top", pos: 2 },
  { color: Color.BLACK, ro: 3, co: 10, edge: "bottom", pos: 1 },
  { color: Color.BLACK, ro: 8, co: 2, edge: "left", pos: 2 },
  { color: Color.BLACK, ro: 9, co: 12, edge: "right", pos: 1 },
  { color: Color.BLACK, ro: 13, co: 4, edge: "top", pos: 1 },
  { color: Color.BLACK, ro: 14, co: 11, edge: "bottom", pos: 2 },
  { color: Color.WHITE, ro: 2, co: 6, edge: "top", pos: 1 },
  { color: Color.WHITE, ro: 5, co: 13, edge: "bottom", pos: 2 },
  { color: Color.WHITE, ro: 10, co: 6, edge: "left", pos: 2 },
  { color: Color.WHITE, ro: 11, co: 15, edge: "right", pos: 1 },
];

// ====== §2 破围/点眼题 ======
// 6x6 黑墙框完整闭合，内部留 4x4=16 空点，黑形成大围空。AI 执白，首手落入圈内即破围成功。
function buildInvade(ro: number, co: number): { b: BoardModel; victim: Color; attacker: Color; victimInside: Set<number> } {
  const b = new BoardModel(19);
  drawRectWall(b, Color.BLACK, ro, co, ro + 5, co + 5);
  const inside = new Set<number>();
  for (let r = ro + 1; r <= ro + 4; r++)
    for (let c = co + 1; c <= co + 4; c++) inside.add(KEY(r, c));
  return { b, victim: Color.BLACK, attacker: Color.WHITE, victimInside: inside };
}
const invadeSpecs: Array<{ ro: number; co: number }> = [
  { ro: 2, co: 2 }, { ro: 3, co: 9 }, { ro: 7, co: 3 }, { ro: 8, co: 11 }, { ro: 12, co: 5 }, { ro: 2, co: 13 },
];

function loadSession(b: BoardModel): GameSession {
  const s = new GameSession({ enableDeployPhase: false });
  for (let i = 0; i < b.grid.length; i++) s.board.grid[i] = b.grid[i];
  return s;
}

// ====== §3 全盘围空效率 ======
function runFull(diff: AIDifficulty, hands: number, ms: number): { blackPts: number; whitePts: number; blackCircles: number; whiteCircles: number } {
  const s = new GameSession({ enableDeployPhase: false });
  const cfg = getAIConfig(AIDifficulty.NORMAL);
  cfg.thinkTimeMs = ms;
  const blackAI = new AIEngine(Color.BLACK, diff);
  const whiteAI = new AIEngine(Color.WHITE, AIDifficulty.NORMAL);
  for (let i = 0; i < hands; i++) {
    const eng = s.toMove === Color.BLACK ? blackAI : whiteAI;
    const mv = eng.chooseMove(s, cfg);
    if (mv.type === "move") s.playMove(s.toMove, mv.row, mv.col);
    else s.toMove = opponent(s.toMove);
  }
  const blackEnc = TerritoryDetector.enclosuresOf(s.board, Color.BLACK);
  const whiteEnc = TerritoryDetector.enclosuresOf(s.board, Color.WHITE);
  return {
    blackPts: blackEnc.reduce((a, e) => a + e.points.length, 0),
    whitePts: whiteEnc.reduce((a, e) => a + e.points.length, 0),
    blackCircles: blackEnc.length,
    whiteCircles: whiteEnc.length,
  };
}

// ====== 主流程 ======
function main(): void {
  const argv = process.argv;
  const diffRaw = argv.find((a) => a.startsWith("--diff="))?.split("=")[1]?.toUpperCase();
  const onlyDiffMap: Record<string, AIDifficulty> = { EASY: AIDifficulty.EASY, NORMAL: AIDifficulty.NORMAL, HARD: AIDifficulty.HARD };
  const onlyDiff = diffRaw ? onlyDiffMap[diffRaw] : undefined;
  const ms = parseInt(argv.find((a) => a.startsWith("--ms="))?.split("=")[1] ?? "", 10);
  const hands = parseInt(argv.find((a) => a.startsWith("--hands="))?.split("=")[1] ?? "80", 10);
  const cfgMs = Number.isNaN(ms) ? 800 : ms;

  const runDiffs: Array<{ name: string; diff: AIDifficulty }> = [
    { name: "简单", diff: AIDifficulty.EASY },
    { name: "普通", diff: AIDifficulty.NORMAL },
    { name: "困难", diff: AIDifficulty.HARD },
  ].filter((d) => onlyDiff === undefined || d.diff === onlyDiff);

  for (const { name, diff } of runDiffs) {
    const cfg = getAIConfig(diff);
    cfg.thinkTimeMs = cfgMs;

    // §1 封口
    let sealPass = 0;
    let sealTotal = 0;
    const sealFailAt: string[] = [];
    for (const spec of sealSpecs) {
      const { b, expectInside } = buildSeal(spec.color, spec.ro, spec.co, spec.edge, spec.pos);
      if (sealed(b, spec.color, expectInside)) continue; // 缺口头题面应未闭合
      sealTotal++;
      const s = loadSession(b);
      s.toMove = spec.color;
      const ai = new AIEngine(spec.color, diff);
      const mv = ai.chooseMove(s, cfg);
      if (mv.type === "move") {
        s.playMove(s.toMove, mv.row, mv.col);
        if (sealed(s.board, spec.color, expectInside)) sealPass++;
        else sealFailAt.push(`AI=(${mv.row},${mv.col})`);
      } else sealFailAt.push("pass");
    }

    // §2 破围
    let invPass = 0;
    const invFails: string[] = [];
    for (const sp of invadeSpecs) {
      const { b, victim, attacker, victimInside } = buildInvade(sp.ro, sp.co);
      const s = loadSession(b);
      s.toMove = attacker;
      const ai = new AIEngine(attacker, diff);
      const mv = ai.chooseMove(s, cfg);
      if (mv.type === "move") {
        const k = KEY(mv.row, mv.col);
        let inside = victimInside.has(k);
        // 兼容：黑已围空圈判点也可能落在经 territory 判出来的圈内
        if (!inside) {
          inside = TerritoryDetector.enclosuresOf(s.board, victim)
            .some((e) => e.points.some((p) => KEY(p.row, p.col) === k));
        }
        if (inside) invPass++;
        else invFails.push(`AI=(${mv.row},${mv.col})`);
      } else invFails.push("pass");
    }

    console.log(`===== ${name} | 封口 ${sealPass}/${sealTotal} | 破围 ${invPass}/${invadeSpecs.length} | think=${cfgMs}ms =====`);
    if (sealFailAt.length) console.log(`  封口未中: ${sealFailAt.join("  ")}`);
    if (invFails.length) console.log(`  破围未中: ${invFails.join("  ")}`);
  }

  // §3 全盘效率
  console.log(`\n===== 全盘围空效率（执黑 | ${hands}手 | per-move=${cfgMs}ms，白=普通） =====`);
  for (const { name, diff } of runDiffs) {
    const r = runFull(diff, hands, Math.min(cfgMs, 200)); // 自战加速
    console.log(
      `  ${name}: 黑围空圈 ${r.blackCircles} | 黑围空空点 ${r.blackPts} | 白圈 ${r.whiteCircles} | 白空点 ${r.whitePts}`
    );
  }
}

main();