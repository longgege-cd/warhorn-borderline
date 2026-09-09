// 围棋基础规则：落子合法性、提子、自杀禁着、基本劫争
// 对应 GDScript c:\边境线\scripts\core\GoRules.gd

import { Color, opponent } from "./Const.js";
import { BoardModel, Point, Group } from "./BoardModel.js";

export const NO_KO: Point = { row: -1, col: -1 };

export class MoveResult {
  legal: boolean = false;
  reason: string = "";
  placed: Point = { row: 0, col: 0 };
  color: Color = Color.EMPTY;
  captured: Point[] = [];
  capturedColor: Color = Color.EMPTY;
  koPoint: Point = NO_KO;

  static makeIllegal(reason: string): MoveResult {
    const r = new MoveResult();
    r.legal = false;
    r.reason = reason;
    return r;
  }
}

export class GoRules {
  // 规范化盘面键：唯一序列化当前棋子分布（0=空/B/W），用于 superko 同形判定与历史去重
  static boardKey(board: BoardModel): string {
    const g = board.grid;
    let k = "";
    for (let i = 0; i < g.length; i++) k += g[i] === Color.EMPTY ? "." : g[i] === Color.BLACK ? "B" : "W";
    return k;
  }

  // 落子 + 提子 + 自杀判定 + 基本劫 + superko（会修改 board）
  // positionSet 可选：已出现过的盘面键集合。若落子（含提子后）重现其中任一盘面 → 判"全局同形禁着"并回滚。
  static tryMove(
    board: BoardModel,
    row: number,
    col: number,
    color: Color,
    koPoint: Point = NO_KO,
    positionSet?: Set<string>
  ): MoveResult {
    if (!board.inBounds(row, col)) return MoveResult.makeIllegal("越界");
    if (board.getAt(row, col) !== Color.EMPTY) return MoveResult.makeIllegal("该点已有棋子");
    if (koPoint.row >= 0 && koPoint.col >= 0 && koPoint.row === row && koPoint.col === col) {
      return MoveResult.makeIllegal("劫争禁着");
    }

    const opp = opponent(color);
    const size = board.size;
    board.setAt(row, col, color);

    // 检查相邻对方组群是否被提（去重避免重复扫描同一组群）
    const captured: Point[] = [];
    const seenGroups = new Set<number>();
    const neighbors = board.neighbors(row, col);
    for (const [nr, nc] of neighbors) {
      if (board.getAt(nr, nc) !== opp) continue;
      const gkey = nr * size + nc;
      if (seenGroups.has(gkey)) continue;
      const g = board.groupAt(nr, nc);
      for (const s of g.stones) seenGroups.add(s.row * size + s.col);
      if (board.libertyCount(g.stones) === 0) {
        for (const s of g.stones) {
          board.setAt(s.row, s.col, Color.EMPTY);
          captured.push({ row: s.row, col: s.col });
        }
      }
    }

    // 自杀判定：己方组群无气且未提子 → 非法，回滚
    const ownG = board.groupAt(row, col);
    const ownLibs = board.liberties(ownG.stones);
    if (ownLibs.length === 0) {
      board.setAt(row, col, Color.EMPTY);
      // 防御性还原（理论上 captured 非空时 ownLibs 不会空）
      for (const s of captured) board.setAt(s.row, s.col, opp);
      return MoveResult.makeIllegal("自杀禁着");
    }

    // superko：落子（含提子）后的盘面若已在历史中出现 → 全局同形禁着，回滚
    if (positionSet && positionSet.has(GoRules.boardKey(board))) {
      board.setAt(row, col, Color.EMPTY);
      for (const s of captured) board.setAt(s.row, s.col, opp);
      return MoveResult.makeIllegal("全局同形禁着");
    }

    const res = new MoveResult();
    res.legal = true;
    res.placed = { row, col };
    res.color = color;
    res.captured = captured;
    res.capturedColor = opp;
    // 基本劫：提单子 + 本子只有1气
    if (captured.length === 1 && ownLibs.length === 1) {
      res.koPoint = { ...captured[0] };
    }
    return res;
  }

  // 在 clone 上跑 tryMove，不改原盘
  static isLegal(
    board: BoardModel,
    row: number,
    col: number,
    color: Color,
    koPoint: Point = NO_KO
  ): boolean {
    if (!board.inBounds(row, col)) return false;
    if (board.getAt(row, col) !== Color.EMPTY) return false;
    const sim = board.clone();
    return GoRules.tryMove(sim, row, col, color, koPoint).legal;
  }

  // 是否还有任何合法落子（O(N²) 遍历空点）
  static hasAnyLegalMove(
    board: BoardModel,
    color: Color,
    koPoint: Point = NO_KO
  ): boolean {
    const size = board.size;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (board.getAt(r, c) !== Color.EMPTY) continue;
        if (GoRules.isLegal(board, r, c, color, koPoint)) return true;
      }
    }
    return false;
  }
}
