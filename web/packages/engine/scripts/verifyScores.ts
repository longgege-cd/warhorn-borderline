// 棋盘播放 + 得分规则验证
// 解析自对弈棋谱（records_*.txt：每行 `winner|r-c r-c ... p`，黑先黑白交替，p=虚手），
// 用 GameSession 从空盘逐手重放，终局调 scores() 复算胜负，与棋谱记录的 winner 比对，
// 验证得分计算是否可复现、胜负判定是否与生成口径一致；可选打印单局得分明细供规则书对照。
// 用法:
//   node --import tsx scripts/verifyScores.ts                                    # 默认验证 scripts/data/records_all.txt
//   node --import tsx scripts/verifyScores.ts --file data/records_all.txt        # 指定单文件
//   node --import tsx scripts/verifyScores.ts --limit 200                        # 仅验证前 200 局
//   node --import tsx scripts/verifyScores.ts --detail 3                         # 打印第 3 局(1基)得分明细
import { GameSession } from "../src/GameSession.js";
import { Color, opponent } from "../src/Const.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARGV = process.argv.slice(2);
function flagVal(k: string, def: string): string {
  const i = ARGV.findIndex((a) => a.startsWith(k + "="));
  if (i >= 0) return ARGV[i].slice(k.length + 1);
  const j = ARGV.indexOf(k);
  if (j >= 0 && j + 1 < ARGV.length) return ARGV[j + 1];
  return def;
}
const filePath = path.resolve(__dirname, flagVal("--file", "data/records_all.txt"));
const limit = parseInt(flagVal("--limit", "0"), 10) || 0;
const detailAt = parseInt(flagVal("--detail", "0"), 10) || 0;

interface Book {
  occupationTerritory: number;
  occupationEfficiency: number;
  defenseAnnihilate: number;
  defenseSiege: number;
  casualtyLoss: number;
  casualtySpecial: number;
  specialReward: number;
}
function total(b: Book): number {
  return b.occupationTerritory + b.occupationEfficiency + b.defenseAnnihilate
    + b.defenseSiege + b.casualtyLoss + b.casualtySpecial + b.specialReward;
}
function winnerOf(b: Book, w: Book): number {
  const tb = total(b), tw = total(w);
  return tb > tw ? Color.BLACK : tb < tw ? Color.WHITE : 0;
}
const colorName = (c: number): string => (c === Color.BLACK ? "黑" : c === Color.WHITE ? "白" : "平局");
const EMPTY_BOOK: Book = {
  occupationTerritory: 0, occupationEfficiency: 0, defenseAnnihilate: 0,
  defenseSiege: 0, casualtyLoss: 0, casualtySpecial: 0, specialReward: 0,
};

// 重放一局：返回复算胜负与得分；ok=false 表示重放中途被拒(非法着/状态不一致)。
function replayLine(line: string): {
  ok: boolean; failIdx: number; recordWinner: number; recomputed: number;
  bs: Book; ws: Book;
} {
  const sep = line.indexOf("|");
  const recordWinner = parseInt(line.slice(0, sep).trim(), 10);
  const restRaw = line.slice(sep + 1);
  const tokens = restRaw.trim().split(/\s+/).filter((t) => t.length > 0);
  const s = new GameSession({ enableDeployPhase: true }); // 与 genData 生成配置一致
  let color = Color.BLACK;
  for (let i = 0; i < tokens.length && !s.gameOver; i++) {
    const tok = tokens[i];
    let ok: boolean;
    if (tok === "p") {
      ok = s.doPass(color).ok;
    } else {
      const dash = tok.indexOf("-");
      const r = parseInt(tok.slice(0, dash), 10);
      const c = parseInt(tok.slice(dash + 1), 10);
      ok = s.playMove(color, r, c).ok;
    }
    if (!ok) return { ok: false, failIdx: i, recordWinner, recomputed: -1, bs: EMPTY_BOOK, ws: EMPTY_BOOK };
    color = opponent(color);
  }
  const sc = s.scores();
  const bs = sc.black as unknown as Book;
  const ws = sc.white as unknown as Book;
  return { ok: true, failIdx: -1, recordWinner, recomputed: winnerOf(bs, ws), bs, ws };
}

function printDetail(bs: Book, ws: Book): void {
  const rows: Array<[string, number, number]> = [
    ["围空(占领)分", bs.occupationTerritory, ws.occupationTerritory],
    ["效率分(备用·恒0)", bs.occupationEfficiency, ws.occupationEfficiency],
    ["歼灭(守方)分", bs.defenseAnnihilate, ws.defenseAnnihilate],
    ["围困(守方)分", bs.defenseSiege, ws.defenseSiege],
    ["损失(攻方)分", bs.casualtyLoss, ws.casualtyLoss],
    ["特种伤害分", bs.casualtySpecial, ws.casualtySpecial],
    ["特种奖励(备用·恒0)", bs.specialReward, ws.specialReward],
    ["合计", total(bs), total(ws)],
  ];
  const pad = (v: number) => String(v).padStart(6);
  console.log("  得分项".padEnd(24) + "  黑".padStart(6) + "   白".padStart(6));
  for (const [name, b, w] of rows) {
    console.log(`  ${name.padEnd(22)}${pad(b)} ${pad(w)}  →胜者 ${colorName(winnerOf(bs, ws))}`);
  }
}

// ===== 主流程 =====
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split("\n").filter((l) => l.trim());
const totalGames = lines.length;
const count = limit > 0 ? Math.min(limit, totalGames) : totalGames;

let okCount = 0, failCount = 0, mismatchCount = 0;
const mismatches: Array<{ idx: number; rec: number; recGained: number }> = [];
for (let i = 0; i < count; i++) {
  const r = replayLine(lines[i]);
  if (!r.ok) { failCount++; if (failCount <= 20) console.log(`【重放异常】第${i + 1}局 第${r.failIdx}手被拒`); continue; }
  if (detailAt > 0 && i + 1 === detailAt) {
    console.log(`\n== 第 ${i + 1} 局明细 ==（记录胜者 ${colorName(r.recordWinner)}）`);
    printDetail(r.bs, r.ws);
  }
  if (r.recomputed === r.recordWinner) okCount++;
  else { mismatchCount++; mismatches.push({ idx: i + 1, rec: r.recordWinner, recGained: r.recomputed }); }
}

const judged = okCount + mismatchCount;
console.log(`\n棋谱: ${filePath}`);
console.log(`局数: ${count}/${totalGames}（limit=${limit || "全部"}）`);
console.log(`胜者判定一致: ${okCount}  不一致: ${mismatchCount}  重放异常: ${failCount}`);
if (judged > 0) console.log(`一致率: ${(okCount / judged * 100).toFixed(2)}%`);
if (mismatches.length) {
  console.log("不一致局（行号 | 记录胜者 → 复算胜者）:");
  for (const m of mismatches.slice(0, 20)) console.log(`  #${m.idx}  ${colorName(m.rec)} → ${colorName(m.recGained)}`);
}
if (judged > 0 && mismatches.length === judged) process.exitCode = 1;