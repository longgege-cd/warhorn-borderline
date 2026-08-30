// P0 评估函数可靠性验证（AI 算法文档 v9.0 §十二）
// 验证 quickEvaluate 是否具备 4 项基础判别能力：
//   A 提吃高分  B 送死低分  C 大包围圈高分  D 被围困己方棋块扣分
// 用法:
//   node --import tsx scripts/evalcheck.ts
import { GameSession } from "../src/GameSession.js";
import { Color, opponent } from "../src/Const.js";
import { GoRules, NO_KO } from "../src/GoRules.js";
import { quickEvaluate } from "../src/AI.js";

const DW = 1.5;

// 用 GameSession 按顺序落子构造局面（黑白必须交替）
function setup(moves: Array<[Color, number, number]>): GameSession {
  const s = new GameSession({ enableDeployPhase: false });
  for (const [c, r, col] of moves) {
    const out = s.playMove(c, r, col);
    if (!out.ok) throw new Error(`构造落子不合法 ${c}(${r},${col}): ${out.reason}`);
  }
  return s;
}

// 对候选点打分：落子后评估 - 落子前评估（rootColor 视角）
function gainOf(s: GameSession, rootColor: Color, r: number, c: number): { legal: boolean; gain: number } {
  const b = s.board.clone();
  const res = GoRules.tryMove(b, r, c, rootColor, NO_KO);
  if (!res.legal) return { legal: false, gain: -Infinity };
  const rootLeft = s.piecesLeft(rootColor);
  const oppLeft = s.piecesLeft(opponent(rootColor));
  const before = quickEvaluate(s.board, rootColor, s.komi, s.pieceLimit, rootLeft, oppLeft, DW);
  const after = quickEvaluate(b, rootColor, s.komi, s.pieceLimit, rootLeft, oppLeft, DW);
  return { legal: true, gain: after - before };
}

// 纯评估一个盘面（rootColor 视角）
function evalBoard(s: GameSession, rootColor: Color): number {
  return quickEvaluate(s.board, rootColor, s.komi, s.pieceLimit, s.piecesLeft(rootColor), s.piecesLeft(opponent(rootColor)), DW);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { pass++; console.log(`  ✔ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✘ ${name}  ${detail}`); }
}

// ===== Case A: 提吃高分 =====
{
  console.log("Case A 提吃：黑单子(9,9)被白三面围、剩1气(10,9)，白落(10,9)提黑");
  const s = setup([
    [Color.BLACK, 9, 9],
    [Color.WHITE, 8, 9],
    [Color.BLACK, 0, 0],
    [Color.WHITE, 9, 8],
    [Color.BLACK, 0, 1],
    [Color.WHITE, 9, 10],
    [Color.BLACK, 0, 2],
  ]);
  const g = gainOf(s, Color.WHITE, 10, 9);
  const gFar = gainOf(s, Color.WHITE, 0, 18);
  check("提吃点 gain 显著为正(>+3)", g.legal && g.gain > 3, `提吃点 gain=${g.legal ? g.gain.toFixed(2) : "非法"}，远点 gain=${gFar.legal ? gFar.gain.toFixed(2) : "非法"}`);
  check("提吃点 gain > 无关远点", g.legal && gFar.legal && g.gain > gFar.gain, `提吃 ${g.legal ? g.gain.toFixed(2) : "-"} vs 远点 ${gFar.legal ? gFar.gain.toFixed(2) : "-"}`);
}

// ===== Case B: 送死低分 =====
{
  console.log("Case B 送死：黑2子(9,9)(9,10)被白围只剩1气(8,9)。黑补(8,9)活 vs 黑落远处送死");
  const s = setup([
    [Color.BLACK, 9, 9],
    [Color.WHITE, 9, 8],
    [Color.BLACK, 9, 10],
    [Color.WHITE, 10, 9],
    [Color.BLACK, 0, 0],
    [Color.WHITE, 8, 10],
    [Color.BLACK, 0, 1],
    [Color.WHITE, 9, 11],
    [Color.BLACK, 0, 2],
    [Color.WHITE, 10, 10],
    [Color.BLACK, 0, 3],
  ]);
  const gSave = gainOf(s, Color.BLACK, 8, 9);   // 补气做活
  const gSui = gainOf(s, Color.BLACK, 0, 18);   // 远处乱伸（组群仍1气将死）
  check("补气做活 gain > 送死乱伸 gain", gSave.legal && gSui.legal && gSave.gain > gSui.gain,
    `补活 ${gSave.legal ? gSave.gain.toFixed(2) : "非法"} vs 送死 ${gSui.legal ? gSui.gain.toFixed(2) : "非法"}`);
}

// ===== Case C: 大包围圈高分 =====
{
  console.log("Case C 大包围圈：黑在白半场 U 形围墙，封口(11,9)闭合 2 点围空");
  const moves: Array<[Color, number, number]> = [];
  const blacks: Array<[number, number]> = [
    [10, 6], [10, 7], [10, 8], [10, 9],
    [12, 6], [12, 7], [12, 8], [12, 9],
    [11, 6],
  ];
  blacks.forEach(([r, c], i) => {
    moves.push([Color.BLACK, r, c]);
    moves.push([Color.WHITE, 0, i]);
  });
  const s = setup(moves);
  const g = gainOf(s, Color.BLACK, 11, 9); // 封口
  const gFar = gainOf(s, Color.BLACK, 0, 18);
  check("封口闭合大空 gain 显著为正(>+4)", g.legal && g.gain > 4, `封口 gain=${g.legal ? g.gain.toFixed(2) : "非法"}，远点 ${gFar.legal ? gFar.gain.toFixed(2) : "非法"}`);
  check("封口 gain > 无关远点", g.legal && gFar.legal && g.gain > gFar.gain, `封口 ${g.legal ? g.gain.toFixed(2) : "-"} vs 远点 ${gFar.legal ? gFar.gain.toFixed(2) : "-"}`);
}

// ===== Case D: 被围困扣分 =====
{
  console.log("Case D 被围困：黑5子十字被白围1气 vs 同形但气多（活棋）");
  // 被困盘：黑十字 (9,9)(9,10)(9,11)(8,10)(10,10)，白占黑组全部邻点仅留(8,9)一气
  const trapBlack: Array<[Color, number, number]> = [
    [Color.BLACK, 9, 9], [Color.WHITE, 9, 8],
    [Color.BLACK, 9, 10], [Color.WHITE, 10, 9],
    [Color.BLACK, 9, 11], [Color.WHITE, 8, 11],
    [Color.BLACK, 8, 10], [Color.WHITE, 9, 12],
    [Color.BLACK, 10, 10], [Color.WHITE, 10, 11],
    [Color.BLACK, 0, 0], [Color.WHITE, 7, 10],
    [Color.BLACK, 0, 1], [Color.WHITE, 11, 10],
  ];
  // 宽松盘：黑同形5子，白只在远角垫手不围黑
  const loose: Array<[Color, number, number]> = [
    [Color.BLACK, 9, 9], [Color.WHITE, 1, 1],
    [Color.BLACK, 9, 10], [Color.WHITE, 1, 2],
    [Color.BLACK, 9, 11], [Color.WHITE, 1, 3],
    [Color.BLACK, 8, 10], [Color.WHITE, 1, 4],
    [Color.BLACK, 10, 10], [Color.WHITE, 1, 5],
  ];
  const sTrap = setup(trapBlack);
  const sLoose = setup(loose);
  const evTrap = evalBoard(sTrap, Color.BLACK);
  const evLoose = evalBoard(sLoose, Color.BLACK);
  check("被围困黑组评估 < 宽松活棋评估", evTrap < evLoose, `被困=${evTrap.toFixed(2)} 活=${evLoose.toFixed(2)}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
