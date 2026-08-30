// 对局管理：核心状态机
// 职责：落子/虚手流程、布局阶段、兵力上限、虚手限制、连续虚手终局、终局结算
// 对应 GDScript c:\边境线\scripts\core\GameSession.gd (750行)
//
// MVP 简化：
//   - 不实现 SpecialForces（特种部队关闭）
//   - 不实现全局同形劫争历史（仅基本劫）
//   - 终局劫争简化为 ko_point 净增判定
//   - 保留悔棋接口但简化快照

import {
  Color, opponent, KOMI_DEFAULT, PIECE_LIMIT,
  isDefenseZone, isAttackZone, ownZone, Zone,
  PASS_LIMIT_PER_GAME, PASS_COOLDOWN_TURNS,
  DEPLOY_PHASE_MOVES, FOG_DAWN_PLY,
} from "./Const.js";
import { BoardModel, Point, Group } from "./BoardModel.js";
import { GoRules, MoveResult, NO_KO } from "./GoRules.js";
import { visionCells, visibleGrid, fogCells } from "./FogUtils.js";
import { SiegeDetector } from "./SiegeDetector.js";
import { TerritoryDetector, Enclosure } from "./TerritoryDetector.js";
import {
  ScoreCalculator, CountersMap, makeCounters,
} from "./ScoreCalculator.js";
import type { MoveOutcome, FinalResult, ScoreBreakdown, ScoreSide, MoveRecord } from "@warhorn/shared";

export interface GameSessionOptions {
  komi?: number;
  pieceLimit?: number;
  enableDeployPhase?: boolean; // 布局阶段（前4手必须落己方领土）
  fogEnabled?: boolean; // 战争迷雾（可选规则，默认关闭）
  specialForces?: boolean; // 特种部队（可选规则，默认关闭，与迷雾互斥）
}

// 特种部队常量
export const SPECIAL_MAX_USES = 2;          // 每局每方最多发动次数
const SPECIAL_DURATION_OWN_MOVES = 20; // 部署后该方再走 20 手（各走20手）到期自动现形

export class GameSession {
  readonly board: BoardModel;
  komi: number;
  pieceLimit: number;
  enableDeployPhase: boolean;
  fogEnabled: boolean; // 战争迷雾开关
  specialForces: boolean; // 特种部队开关（与迷雾互斥）
  fogRevealed: Set<number> = new Set(); // 已现形的对方隐藏棋子（索引），网络/渲染可见
  // 特种部队状态
  specialUses: Map<Color, number>; // 每方已发动次数（上限 SPECIAL_MAX_USES）
  specialStones: Map<Color, Map<number, number>>; // 每方部署过的隐子 idx -> 部署该方ownMoves序
  exposedSpecials: Set<number> = new Set(); // 已现形的隐子 idx（对手可见）
  lastSpecialOwnMove: Map<Color, number>; // 每方上次发动时的ownMoves（用于"不可连续使用"）

  toMove: Color = Color.BLACK;
  ply: number = 0;
  consecutivePasses: number = 0;
  passCounts: Map<Color, number>; // 每方本局虚手次数
  passCooldown: Map<Color, number>; // color -> 己方回合计数（达到 PASS_COOLDOWN_TURNS 即可虚手）
  skipPassLimits: boolean = false; // 回放/审计用

  gameOver: boolean = false;
  stonesPlaced: Map<Color, number>; // 累计普通落子数
  stonesOnBoard: Map<Color, number> = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]); // 当前棋盘上的子数（含特种隐子）
  replenishTotal: Map<Color, number> = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]); // 累计吃子补充兵力
  ownMoves: Map<Color, number>; // 每方已走总手数（含特种部署，用于特种到期判定）
  counters: CountersMap;
  lastOutcome: MoveOutcome | FinalResult | null = null;

  koPoint: Point = NO_KO;
  lastFinalResult: FinalResult | null = null;

  // 逐手棋谱（在线持久化到 games.json，供对局存档/回放）
  moveHistory: MoveRecord[] = [];

  // 缓存
  private _cachedScores: { black: ScoreBreakdown; white: ScoreBreakdown } | null = null;
  private _cachedEnclosures: Enclosure[] | null = null;
  private _cachedSiegedGroups: Group[] | null = null;
  private _cacheValid: boolean = false;
  private _useCache: boolean = true;

  // 悔棋栈（简化）
  private _undoStack: GameSnapshot[] = [];
  private _pendingSnap: GameSnapshot | null = null;
  private static readonly MAX_UNDO = 30;

  // 事件回调（替代 GDScript signal）
  onMoveCommitted?: (outcome: MoveOutcome) => void;
  onScoresChanged?: (scores: { black: ScoreBreakdown; white: ScoreBreakdown }) => void;
  onGameEnded?: (result: FinalResult) => void;
  emitSignals: boolean = true;

  constructor(opts: GameSessionOptions = {}) {
    this.board = new BoardModel();
    this.komi = opts.komi ?? KOMI_DEFAULT;
    this.pieceLimit = opts.pieceLimit ?? PIECE_LIMIT;
    this.enableDeployPhase = opts.enableDeployPhase ?? true;
    this.fogEnabled = opts.fogEnabled ?? false;
    // 特种部队可与迷雾同时启用；同时启用时迷雾活跃期间不可部署，黎明降临后方可使用
    this.specialForces = opts.specialForces ?? false;
    this.passCounts = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]);
    this.passCooldown = new Map([[Color.BLACK, PASS_COOLDOWN_TURNS], [Color.WHITE, PASS_COOLDOWN_TURNS]]);
    this.stonesPlaced = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]);
    this.specialUses = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]);
    this.specialStones = new Map([[Color.BLACK, new Map()], [Color.WHITE, new Map()]]);
    this.lastSpecialOwnMove = new Map([[Color.BLACK, -10], [Color.WHITE, -10]]);
    this.ownMoves = new Map([[Color.BLACK, 0], [Color.WHITE, 0]]);
    this.counters = makeCounters();
    this._resetState();
  }

  private _resetState(): void {
    this.toMove = Color.BLACK;
    this.ply = 0;
    this.consecutivePasses = 0;
    this.passCounts.set(Color.BLACK, 0);
    this.passCounts.set(Color.WHITE, 0);
    this.passCooldown.set(Color.BLACK, PASS_COOLDOWN_TURNS);
    this.passCooldown.set(Color.WHITE, PASS_COOLDOWN_TURNS);
    this.gameOver = false;
    this.stonesPlaced.set(Color.BLACK, 0);
    this.stonesPlaced.set(Color.WHITE, 0);
    this.stonesOnBoard.set(Color.BLACK, 0);
    this.stonesOnBoard.set(Color.WHITE, 0);
    this.replenishTotal.set(Color.BLACK, 0);
    this.replenishTotal.set(Color.WHITE, 0);
    this.ownMoves.set(Color.BLACK, 0);
    this.ownMoves.set(Color.WHITE, 0);
    this.specialUses.set(Color.BLACK, 0);
    this.specialUses.set(Color.WHITE, 0);
    this.specialStones.set(Color.BLACK, new Map());
    this.specialStones.set(Color.WHITE, new Map());
    this.exposedSpecials.clear();
    this.lastSpecialOwnMove.set(Color.BLACK, -10);
    this.lastSpecialOwnMove.set(Color.WHITE, -10);
    this.counters = makeCounters();
    this.koPoint = NO_KO;
    this.lastOutcome = null;
    this.lastFinalResult = null;
    this.moveHistory = [];
    this.fogRevealed.clear();
    this._undoStack = [];
    this._pendingSnap = null;
    this._invalidateCache();
  }

  newGame(): void {
    this.board.grid.fill(Color.EMPTY);
    this._resetState();
  }

  // ====== 缓存 ======
  private _invalidateCache(): void {
    this._cacheValid = false;
    this._cachedScores = null;
    this._cachedEnclosures = null;
    this._cachedSiegedGroups = null;
  }

  private _ensureCache(): void {
    if (!this._useCache || this._cacheValid) return;
    const da = SiegeDetector.solveDeadAlive(this.board);
    this._cachedSiegedGroups = da.sieged;
    this._cachedEnclosures = TerritoryDetector.enclosures(this.board);
    this._cachedScores = ScoreCalculator.compute(
      this.board, this.counters, this._cachedSiegedGroups, this._cachedEnclosures
    );
    this._cacheValid = true;
  }

  scores(): { black: ScoreBreakdown; white: ScoreBreakdown } {
    let res: { black: ScoreBreakdown; white: ScoreBreakdown };
    if (this._useCache) {
      this._ensureCache();
      res = this._cachedScores!;
    } else {
      res = ScoreCalculator.compute(this.board, this.counters);
    }
    return res;
  }

  enclosures(): Enclosure[] {
    if (this._useCache) {
      this._ensureCache();
      return this._cachedEnclosures!;
    }
    return TerritoryDetector.enclosures(this.board);
  }

  siegedGroups(): Group[] {
    if (this._useCache) {
      this._ensureCache();
      return this._cachedSiegedGroups!;
    }
    return SiegeDetector.solveDeadAlive(this.board).sieged;
  }

  // ====== 兵力 ======
  piecesLeft(color: Color): number {
    return Math.max(0, this.pieceLimit - (this.stonesPlaced.get(color) ?? 0));
  }

  // 当前棋盘上该方子数（含特种隐子）
  stonesOnBoardOf(color: Color): number {
    return this.stonesOnBoard.get(color) ?? 0;
  }

  // 该方累计吃子补充兵力
  replenishOf(color: Color): number {
    return this.replenishTotal.get(color) ?? 0;
  }

  canPlace(color: Color): boolean {
    return !this.gameOver && this.piecesLeft(color) > 0;
  }

  // ====== 布局阶段 ======
  isInDeployPhase(): boolean {
    if (!this.enableDeployPhase) return false;
    return this.ply < DEPLOY_PHASE_MOVES;
  }

  // 布局阶段：必须落己方领土（row 0..8 for BLACK, row 10..18 for WHITE）
  private _isDeployMoveLegal(row: number, col: number, color: Color): boolean {
    const zone = ownZone(color);
    const rowZone = row < 9 ? Zone.BLACK : row === 9 ? Zone.BORDER : Zone.WHITE;
    return rowZone === zone;
  }

  // ====== 落子 ======
  playMove(color: Color, row: number, col: number): MoveOutcome {
    const outcome: MoveOutcome = {
      ok: false,
      moverColor: color,
    };

    if (this.gameOver) {
      outcome.reason = "对局已结束";
      return outcome;
    }
    if (this.toMove !== color) {
      outcome.reason = "非该方行棋";
      return outcome;
    }
    if (!this.canPlace(color)) {
      outcome.reason = "兵力已用尽";
      return outcome;
    }
    if (!this.board.inBounds(row, col)) {
      outcome.reason = "越界";
      return outcome;
    }
    if (this.isInDeployPhase() && !this._isDeployMoveLegal(row, col, color)) {
      outcome.reason = "布局阶段必须落己方领土";
      return outcome;
    }

    // 取行棋前快照（遭遇战/正常落子均在此之后变更棋盘）
    this._beginUndoSnapshot();

    // 特种遭遇战：落点被对方隐藏特种棋子占据（mover 不可见）
    if (this.specialForces && !this.board.isEmpty(row, col)) {
      if (this._resolveSpecialEncounter(color, row, col, outcome)) {
        // 弹子成功则提交整手；落子退回则不改动回合
        if (outcome.ok) this._commitTurn(outcome, color, true);
        return outcome;
      }
    }

    // 战争迷雾遭遇战：落点被对方隐藏棋子占据（mover 迷雾下不可见）
    if (!this.board.isEmpty(row, col)) {
      if (this.isFogActive() && this._resolveEncounter(color, row, col, outcome)) {
        // 已现形并弹子/吞子，完成整手
        this._commitFogMove(outcome, color);
        return outcome;
      }
      outcome.reason = "该点已有棋子";
      return outcome;
    }

    const res = GoRules.tryMove(this.board, row, col, color, this.koPoint);
    if (!res.legal) {
      outcome.ok = false;
      outcome.reason = res.reason;
      return outcome;
    }

    outcome.ok = true;
    outcome.placed = { row, col };
    outcome.captures = res.captured;
    outcome.capturedColor = res.capturedColor;
    this.koPoint = res.koPoint;

    // 执行邻位暴露：对手落子在该隐子或其四邻 → 该隐子现形
    this._exposeAdjacentSpecials(color, row, col, outcome);

    // 处理被提子（计数 + 歼灭分）
    this._processCaptures(res, color);

    // 计数普通落子
    this.stonesPlaced.set(color, (this.stonesPlaced.get(color) ?? 0) + 1);
    this.stonesOnBoard.set(color, (this.stonesOnBoard.get(color) ?? 0) + 1);

    this._commitTurn(outcome, color, true);
    return outcome;
  }

  // ====== 虚手 ======
  doPass(color: Color): MoveOutcome {
    const outcome: MoveOutcome = {
      ok: false,
      moverColor: color,
    };

    if (this.gameOver) {
      outcome.reason = "对局已结束";
      return outcome;
    }
    if (this.toMove !== color) {
      outcome.reason = "非该方行棋";
      return outcome;
    }

    // 棋子用尽：自动获得虚手权——不消耗次数、不受冷却限制（可无限虚手直至终局）
    const exhausted = this.piecesLeft(color) <= 0;

    // 虚手次数限制（每方每局 2 次）；棋子用尽时豁免
    if (!this.skipPassLimits && !exhausted && (this.passCounts.get(color) ?? 0) >= PASS_LIMIT_PER_GAME) {
      outcome.ok = false;
      outcome.reason = `虚手次数已用尽（每方每局 ${PASS_LIMIT_PER_GAME} 次）`;
      return outcome;
    }

    // 虚手冷却（自上次虚手后需 2 个己方实际行棋回合）；棋子用尽时豁免
    if (!this.skipPassLimits && !exhausted && (this.passCooldown.get(color) ?? PASS_COOLDOWN_TURNS) < PASS_COOLDOWN_TURNS) {
      outcome.ok = false;
      const left = PASS_COOLDOWN_TURNS - (this.passCooldown.get(color) ?? 0);
      outcome.reason = `虚手冷却中（还需 ${left} 个己方回合）`;
      return outcome;
    }

    this._beginUndoSnapshot();
    this.consecutivePasses += 1;
    if (!exhausted) {
      this.passCounts.set(color, (this.passCounts.get(color) ?? 0) + 1);
      this.passCooldown.set(color, 0);
    }

    outcome.ok = true;
    outcome.passed = true;
    outcome.placed = { row: -1, col: -1 };
    this.koPoint = NO_KO; // 虚手不产生劫

    // 终局判定
    let endReason = "";
    if (this.consecutivePasses >= 2) {
      const blackExhausted = this.piecesLeft(Color.BLACK) <= 0;
      const whiteExhausted = this.piecesLeft(Color.WHITE) <= 0;
      if (blackExhausted || whiteExhausted) {
        endReason = "一方兵力用尽且双方连续虚手";
      } else if (this._bothCannotMove()) {
        endReason = "双方均无法落子";
      } else {
        endReason = "双方连续虚手";
      }
    }

    if (endReason !== "") {
      this._endGame(endReason);
      outcome.gameOver = true;
      outcome.result = this.lastFinalResult ?? undefined;
      this._emitMove(outcome);
      return outcome;
    }

    this._commitTurn(outcome, color, false);
    return outcome;
  }

  // ====== 认输 ======
  resign(color: Color): MoveOutcome {
    const outcome: MoveOutcome = { ok: false, moverColor: color };
    if (this.gameOver) {
      outcome.reason = "对局已结束";
      return outcome;
    }
    const winner = opponent(color);
    const result = this._buildFinalResult(`${color === Color.BLACK ? "黑" : "白"}方认输`);
    result.winner = winner === Color.BLACK ? "黑方胜" : "白方胜";
    result.winnerColor = winner;
    this.lastFinalResult = result;
    this.gameOver = true;
    outcome.ok = true;
    outcome.gameOver = true;
    outcome.result = result;
    if (this.emitSignals) this.onGameEnded?.(result);
    return outcome;
  }

  // ====== 特种部队（可选规则） ======
  canDeploySpecial(color: Color): string | null {
    if (!this.specialForces) return "本局未启用特种部队";
    if (this.gameOver) return "对局已结束";
    if (this.toMove !== color) return "非该方行棋";
    if (this.fogEnabled && this.isFogActive()) return "迷雾未散，黎明降临后方可部署特种部队";
    if ((this.specialUses.get(color) ?? 0) >= SPECIAL_MAX_USES)
      return `特种部队每局最多发动 ${SPECIAL_MAX_USES} 次`;
    if ((this.ownMoves.get(color) ?? 0) - (this.lastSpecialOwnMove.get(color) ?? -10) < 2)
      return "不可连续使用特种部队";
    return null;
  }

  // 部署特种隐子：不计入兵力上限，不产生即时得分
  deploySpecial(color: Color, row: number, col: number): MoveOutcome {
    const outcome: MoveOutcome = { ok: false, moverColor: color, special: true };
    const err = this.canDeploySpecial(color);
    if (err) { outcome.reason = err; return outcome; }
    if (!this.board.inBounds(row, col)) { outcome.reason = "越界"; return outcome; }
    if (!this.board.isEmpty(row, col)) { outcome.reason = "该点已有棋子"; return outcome; }
    // 部署限制：以落点为中心，曼哈顿距离 ≤3 范围内不得有棋子（对方特种棋子除外）
    const size = this.board.size;
    const enemy = opponent(color);
    const enemySpecials = this.specialStones.get(enemy);
    outer: for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        if (Math.abs(dr) + Math.abs(dc) > 3) continue;
        const rr = row + dr, cc = col + dc;
        if (!this.board.inBounds(rr, cc)) continue;
        if (this.board.isEmpty(rr, cc)) continue;
        // 仅对方特种棋子允许存在于该范围，其余任何棋子（含己方/对方普通棋子、己方特种棋子）均拒绝
        if (!enemySpecials?.has(rr * size + cc)) {
          outcome.reason = "该位置周围 3 格内存在棋子，无法部署特种部队";
          return outcome;
        }
      }
    }
    if (this.isInDeployPhase() && !this._isDeployMoveLegal(row, col, color)) {
      outcome.reason = "布局阶段必须落己方领土";
      return outcome;
    }

    this._beginUndoSnapshot();

    const res = GoRules.tryMove(this.board, row, col, color, this.koPoint);
    if (!res.legal) { outcome.ok = false; outcome.reason = res.reason; return outcome; }

    outcome.ok = true;
    outcome.placed = { row, col };
    outcome.captures = res.captured;
    outcome.capturedColor = res.capturedColor;
    outcome.specialDeployAt = { row, col };
    this.koPoint = res.koPoint;
    this._processCaptures(res, color);

    // 记录为隐子
    this.lastSpecialOwnMove.set(color, this.ownMoves.get(color) ?? 0); // 记录当前行棋序用于连续判定
    const idx = row * this.board.size + col;
    this.specialStones.get(color)!.set(idx, this.ownMoves.get(color) ?? 0);
    this.specialUses.set(color, (this.specialUses.get(color) ?? 0) + 1);
    // 特种隐子也是棋盘上的子
    this.stonesOnBoard.set(color, (this.stonesOnBoard.get(color) ?? 0) + 1);

    this._commitTurn(outcome, color, true);
    return outcome;
  }

  // 特种遭遇战：落点被对方隐藏特种棋子占据 → 隐子现形，mover 落子弹至周围八格。
  // 八格均不可落子 → 落子退回，对手重新落子（不消耗棋子、无战损）。
  private _resolveSpecialEncounter(color: Color, row: number, col: number, outcome: MoveOutcome): boolean {
    const enemy = opponent(color);
    const size = this.board.size;
    const idx = row * size + col;
    if (this.board.getAt(row, col) !== enemy) return false;
    if (!this.specialStones.get(enemy)?.has(idx)) return false; // 仅对部署过的特种隐子触发
    if (this.exposedSpecials.has(idx)) return false;            // 已现形则按正常拒绝路径

    outcome.encounter = true;

    // 1. 隐子现形
    this.exposedSpecials.add(idx);
    (outcome.revealed ??= []).push({ row, col });

    // 2. 弹子：周围八格选可落子（优先能形成活形）
    const landing = this._bounceCandidates(color, row, col)[0] ?? null;
    if (!landing) {
      // 退回：撤销显现，不改动回合，对手重新落子
      this.exposedSpecials.delete(idx);
      outcome.revealed = (outcome.revealed ?? []).filter(r => !(r.row === row && r.col === col));
      outcome.ok = false;
      outcome.placed = { row: -1, col: -1 };
      outcome.reason = "该点被隐藏棋子阻挡且四周无落脚点，请重新落子";
      return true;
    }

    // 3. 落子弹入 landing
    const res = GoRules.tryMove(this.board, landing.row, landing.col, color, this.koPoint);
    if (!res.legal) {
      outcome.ok = false;
      outcome.reason = "该点被隐藏棋子阻挡，请重新落子";
      return true;
    }
    outcome.ok = true;
    outcome.placed = { row: landing.row, col: landing.col };
    outcome.captures = res.captured;
    outcome.capturedColor = res.capturedColor;
    this.koPoint = res.koPoint;
    this._processCaptures(res, color);
    this.stonesPlaced.set(color, (this.stonesPlaced.get(color) ?? 0) + 1);
    this.stonesOnBoard.set(color, (this.stonesOnBoard.get(color) ?? 0) + 1);
    this._exposeAdjacentSpecials(color, landing.row, landing.col, outcome);
    return true;
  }

  // 邻位暴露：color 落子后，暴露其四邻（含本点）的对方隐藏特种隐子
  private _exposeAdjacentSpecials(color: Color, row: number, col: number, outcome: MoveOutcome): void {
    if (!this.specialForces) return;
    const enemy = opponent(color);
    const size = this.board.size;
    const check = (r: number, c: number) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      const idx = r * size + c;
      if (!this.specialStones.get(enemy)?.has(idx)) return;
      if (this.exposedSpecials.has(idx)) return;
      this.exposedSpecials.add(idx);
      (outcome.revealed ??= []).push({ row: r, col: c });
    };
    check(row, col);
    for (const [nr, nc] of this.board.neighbors(row, col)) check(nr, nc);
  }

  // 到期现形：该方再走满 SPECIAL_DURATION_OWN_MOVES 手后，其未暴露隐子自动现形
  private _ageSpecials(color: Color, outcome: MoveOutcome): void {
    if (!this.specialForces) return;
    const stones = this.specialStones.get(color);
    if (!stones) return;
    const cur = this.ownMoves.get(color) ?? 0;
    for (const [idx, deployOwnMove] of stones) {
      if (this.exposedSpecials.has(idx)) continue;
      if (cur - deployOwnMove >= SPECIAL_DURATION_OWN_MOVES) {
        this.exposedSpecials.add(idx);
        (outcome.revealed ??= []).push({ row: Math.floor(idx / this.board.size), col: idx % this.board.size });
      }
    }
  }

  // 特种模式下，对方视角应隐藏的未暴露特种隐子索引集合
  hiddenSpecialsFrom(color: Color): Set<number> {
    const enemy = opponent(color);
    const stones = this.specialStones.get(enemy);
    const set = new Set<number>();
    if (!stones) return set;
    for (const idx of stones.keys()) {
      if (this.exposedSpecials.has(idx)) continue;
      set.add(idx);
    }
    return set;
  }

  // color 方自己的未暴露特种隐子索引集合（供己方渲染标记）
  ownHiddenSpecialsOf(color: Color): Set<number> {
    const stones = this.specialStones.get(color);
    const set = new Set<number>();
    if (!stones) return set;
    for (const idx of stones.keys()) {
      if (this.exposedSpecials.has(idx)) continue;
      set.add(idx);
    }
    return set;
  }

  // color 视角可见的特种隐子索引集合（供前端画特殊标记）：
  // 包含己方未现形隐子 + 双方已现形隐子；不含对方未现形隐子 → 不会暴露对方隐藏位置
  visibleSpecialsOf(color: Color): Set<number> {
    const out = new Set<number>();
    for (const owner of [Color.BLACK, Color.WHITE]) {
      const stones = this.specialStones.get(owner);
      if (!stones) continue;
      for (const idx of stones.keys()) {
        if (this.exposedSpecials.has(idx) || owner === color) out.add(idx);
      }
    }
    return out;
  }

  // 特种模式下，按接收方视角返回棋盘网格（隐藏对方未暴露隐子）
  // 迷雾活跃时由迷雾 visibleGridOf 负责过滤，此方法仅在迷雾消散后生效
  specialVisibleGrid(color: Color): Uint8Array {
    const grid = this.board.grid.slice();
    if (this.specialForces && !this.isFogActive()) {
      for (const idx of this.hiddenSpecialsFrom(color)) grid[idx] = Color.EMPTY;
    }
    return grid;
  }

  // 终局奖励：该方是否有存活到终局且参与围困/围空的特种隐子
  private _specialRewardActive(color: Color): boolean {
    if (!this.specialForces) return false;
    const stones = this.specialStones.get(color);
    if (!stones || stones.size === 0) return false;
    const size = this.board.size;
    for (const idx of stones.keys()) {
      const r = Math.floor(idx / size);
      const c = idx % size;
      if (this.board.getAt(r, c) !== color) continue; // 已被提走 → 不存活，不奖励
      if (this._specialParticipates(color, r, c)) return true;
    }
    return false;
  }

  // 判断隐子是否参与围困或围空：属于该方某包围圈边界(围空)，或相邻敌方棋子属于被围困组(围困)
  private _specialParticipates(color: Color, row: number, col: number): boolean {
    const size = this.board.size;
    const idx = row * size + col;
    for (const e of this.enclosures()) {
      if (e.color !== color) continue;
      if (e.borderStonesIdx.has(idx)) return true;
    }
    const enemy = opponent(color);
    const sieged = this.siegedGroups();
    for (const [nr, nc] of this.board.neighbors(row, col)) {
      const nIdx = nr * size + nc;
      if (this.board.getAt(nr, nc) !== enemy) continue;
      for (const g of sieged) {
        if (g.color !== enemy) continue;
        if (g.stones.some(s => s.row * size + s.col === nIdx)) return true;
      }
    }
    return false;
  }

  // ====== 内部 ======
  private _processCaptures(res: MoveResult, moverColor: Color): void {
    const capturedColor = res.capturedColor;
    if (capturedColor === Color.EMPTY || res.captured.length === 0) return;
    const counter = this.counters.get(capturedColor) ?? { annihilate: 0, normalLost: 0, specialLost: 0 };
    const size = this.board.size;
    const specialIdxs = this.specialStones.get(capturedColor);
    for (const cap of res.captured) {
      if (specialIdxs?.has(cap.row * size + cap.col)) counter.specialLost += 1;
      else counter.normalLost += 1;
    }
    this.counters.set(capturedColor, counter);
    // 被提子离盘：扣减该方当前棋盘子数
    this.stonesOnBoard.set(capturedColor, Math.max(0, (this.stonesOnBoard.get(capturedColor) ?? 0) - res.captured.length));

    // 歼灭分：提吃发生在「提子方」的防御区（己境/边境）
    const moverCounter = this.counters.get(moverColor) ?? { annihilate: 0, normalLost: 0, specialLost: 0 };
    // 兵力补充：在己方地盘（防御区）吃掉对方普通棋子可补充兵力，一子补一兵力，不超过兵力上限。
    // 等价于减少己方已落子数（stonesPlaced），clamp 到下限0（即可用兵力最多回到 pieceLimit）。
    let replenish = 0;
    for (const cap of res.captured) {
      if (!isDefenseZone(cap.row, moverColor)) continue;
      moverCounter.annihilate += 1;
      // 特殊子不计入兵力上限，提吃不触发兵力补充
      if (!specialIdxs?.has(cap.row * size + cap.col)) replenish += 1;
    }
    this.counters.set(moverColor, moverCounter);
    if (replenish > 0) {
      const placed = this.stonesPlaced.get(moverColor) ?? 0;
      this.stonesPlaced.set(moverColor, Math.max(0, placed - replenish));
      this.replenishTotal.set(moverColor, (this.replenishTotal.get(moverColor) ?? 0) + replenish);
    }
  }

  // 遭遇战整手收尾：标记成功并转账，随即提交（含黎明检测）
  private _commitFogMove(outcome: MoveOutcome, color: Color): void {
    outcome.ok = true;
    if (!outcome.placed) outcome.placed = { row: -1, col: -1 };
    this._commitTurn(outcome, color, true);
  }

  private _commitTurn(outcome: MoveOutcome, color: Color, didPlace: boolean): void {
    if (!outcome.passed) {
      this.consecutivePasses = 0;
      const prev = this.passCooldown.get(color) ?? 0;
      this.passCooldown.set(color, Math.min(prev + 1, PASS_COOLDOWN_TURNS));
    }
    // 计数该方已走手数（用于特种到期判定）
    if (didPlace) {
      this.ownMoves.set(color, (this.ownMoves.get(color) ?? 0) + 1);
      this._ageSpecials(color, outcome);
    }
    this.ply += 1;
    outcome.ply = this.ply;
    // 记录逐手棋谱
    {
      let kind: MoveRecord["k"] = outcome.passed ? "v" : "p";
      if (outcome.special) kind = "s";
      else if (outcome.encounter) kind = "e";
      this.moveHistory.push({
        c: color,
        k: kind,
        r: outcome.placed?.row ?? -1,
        col: outcome.placed?.col ?? -1,
      });
    }
    // 第 FOG_DAWN_PLY 手黎明：迷雾消散，全盘可见
    if (this.fogEnabled && this.ply === FOG_DAWN_PLY && !outcome.dawn) {
      outcome.dawn = true;
      this.fogRevealed.clear();
    }
    this.toMove = opponent(color);
    this.lastOutcome = outcome; // 记录最后一手（供 UI 标记/悔棋对比基准）

    // 悔棋栈
    if (this._pendingSnap) {
      this._undoStack.push(this._pendingSnap);
      this._pendingSnap = null;
      if (this._undoStack.length > GameSession.MAX_UNDO) this._undoStack.shift();
    }
    this._invalidateCache();

    // 终局提前判定：落后方兵力用尽且领先方仍有剩余兵力 → 直接终局
    // （依据：实时总分判定领先/落后，不含贴目/终局特种奖励；平局不触发；
    //   不绑定本手落子方——落后方耗尽的当手若尚平局/领先，靠此后领先方的每一手持续复查）
    if (didPlace && !outcome.passed && !this.gameOver) {
      const sc = this.scores();
      // 实时总分 = breakdown 各子项之和（live scores() 无 .total，需按 _totalOf 口径）
      const bt = this._totalOf(sc.black);
      const wt = this._totalOf(sc.white);
      if (bt !== wt) {
        const trailing: Color = bt < wt ? Color.BLACK : Color.WHITE;
        const leading: Color = bt > wt ? Color.BLACK : Color.WHITE;
        if (this.piecesLeft(trailing) <= 0 && this.piecesLeft(leading) > 0) {
          const endReason = `${trailing === Color.BLACK ? "黑" : "白"}方兵力用尽且落后，立即终局`;
          this._endGame(endReason);
          outcome.gameOver = true;
          outcome.result = this.lastFinalResult ?? undefined;
          this._emitMove(outcome);
          return;
        }
      }
    }

    this._emitMove(outcome);
  }

  private _emitMove(outcome: MoveOutcome): void {
    if (!this.emitSignals) return;
    this.onMoveCommitted?.(outcome);
    this.onScoresChanged?.(this.scores());
  }

  private _bothCannotMove(): boolean {
    if (GoRules.hasAnyLegalMove(this.board, Color.BLACK, this.koPoint)) return false;
    if (GoRules.hasAnyLegalMove(this.board, Color.WHITE, this.koPoint)) return false;
    return true;
  }

  hasLegalMove(color: Color): boolean {
    if (!this.canPlace(color)) return false;
    return GoRules.hasAnyLegalMove(this.board, color, this.koPoint);
  }

  // ====== 战争迷雾（可选规则） ======
  // 迷雾从布局阶段起生效，第30手（总手数）黎明后全盘可见
  isFogActive(): boolean {
    return this.fogEnabled && this.ply < FOG_DAWN_PLY;
  }

  // color 方的可见单元格（己方棋子 + 曼哈顿距离≤2）
  visionCellsOf(color: Color): Set<number> {
    return visionCells(color, this.board);
  }

  // color 方视角的可见网格（隐藏视野外对方棋子）
  visibleGridOf(color: Color): Uint8Array {
    return visibleGrid(this.board.grid, color, this.board, this.isFogActive(), this.fogRevealed);
  }

  // color 方视角的迷雾覆盖区域
  fogCellsOf(color: Color): Set<number> {
    return fogCells(this.board, color, this.isFogActive(), this.fogRevealed);
  }

  // 遭遇战落子：落点被对方隐藏棋子占据（mover 迷雾下不可见）。
  // 规则书 v7.3：对方显形，mover 落子弹至周围可落子点；无可用点则被消灭(-1战损，棋子不保留)。
  private _resolveEncounter(color: Color, row: number, col: number, outcome: MoveOutcome): boolean {
    const enemy = opponent(color);
    if (this.board.getAt(row, col) !== enemy) return false;
    if (this.fogRevealed.has(row * this.board.size + col)) return false; // 已现形则按正常路径拒绝
    // 该点必须在 mover 视野外（真·隐藏）才触发遭遇战
    if (this.visionCellsOf(color).has(row * this.board.size + col)) return false;

    // 1. 对方隐藏子现形
    this.fogRevealed.add(row * this.board.size + col);
    (outcome.revealed ??= []).push({ row, col });

    // 2. 弹子：周围八格优先选可落子且更靠近己方棋子的位置
    const candidates = this._bounceCandidates(color, row, col);
    let landed: Point | null = null;
    if (candidates.length > 0) {
      landed = candidates[0];
      const res = GoRules.tryMove(this.board, landed.row, landed.col, color, this.koPoint);
      if (res.legal) {
        outcome.placed = { row: landed.row, col: landed.col };
        outcome.captures = res.captured;
        outcome.capturedColor = res.capturedColor;
        this.koPoint = res.koPoint;
        this._processCaptures(res, color);
        this.stonesPlaced.set(color, (this.stonesPlaced.get(color) ?? 0) + 1);
        this.stonesOnBoard.set(color, (this.stonesOnBoard.get(color) ?? 0) + 1);
      } else {
        landed = null;
      }
    }

    // 3. 弹子失败（或被八格均不可落）：棋子被消灭
    if (!landed) {
      const counter = this.counters.get(color) ?? { annihilate: 0, normalLost: 0, specialLost: 0 };
      counter.normalLost += 1;
      this.counters.set(color, counter);
      this.stonesPlaced.set(color, (this.stonesPlaced.get(color) ?? 0) + 1);
    }

    outcome.encounter = true;
    return true;
  }

  // 遭遇战弹子候选：周围八格中空且合法，优先靠近己方棋子（能形成活形）
  private _bounceCandidates(color: Color, row: number, col: number): Point[] {
    const size = this.board.size;
    const list: Point[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (GoRules.isLegal(this.board, nr, nc, color, this.koPoint)) list.push({ row: nr, col: nc });
      }
    }
    // 优先选择与己方棋子相邻的位置（更易形成活形、不被反吃）
    const nearOwn = (p: Point): boolean => {
      for (const [nr, nc] of this.board.neighbors(p.row, p.col)) {
        if (this.board.getAt(nr, nc) === color) return true;
      }
      return false;
    };
    list.sort((a, b) => (nearOwn(b) ? 1 : 0) - (nearOwn(a) ? 1 : 0));
    return list;
  }

  private _endGame(reason: string): void {
    this.gameOver = true;
    const result = this._buildFinalResult(reason);
    this.lastFinalResult = result;
    if (this.emitSignals) this.onGameEnded?.(result);
  }

  // 终局结算（含简化的终局劫争处理）
  private _buildFinalResult(reason: string): FinalResult {
    // 简化：终局若有 ko_point，直接判定谁提劫净增更大
    this._resolveKoAtEndgame();

    const res = ScoreCalculator.computeFinal(this.board, this.counters, this.komi);

    // 特种部队成功奖励：存活到终局且参与围困/围空 → 该方占领分总额+50%向上取整
    for (const color of [Color.BLACK, Color.WHITE]) {
      const side = color === Color.BLACK ? res.black : res.white;
      if (!this._specialRewardActive(color)) continue;
      const b = side.breakdown;
      const occ = b.occupationTerritory + b.occupationEfficiency;
      if (occ <= 0) continue; // 无占领分则奖励为0
      const boosted = Math.ceil(occ * 1.5);
      b.specialReward = boosted - occ;
      side.total += b.specialReward;
      side.final += b.specialReward;
    }
    // 奖励可能翻转胜负，重新判定
    let winner = "和棋";
    let winnerColor: Color = Color.EMPTY;
    if (res.black.final > res.white.final) { winner = "黑方胜"; winnerColor = Color.BLACK; }
    else if (res.white.final > res.black.final) { winner = "白方胜"; winnerColor = Color.WHITE; }
    res.winner = winner;
    res.winnerColor = winnerColor;

    res.reason = reason;
    res.ply = this.ply;
    return res;
  }

  // 终局劫争处理（简化版）：若有 ko_point，模拟双方提劫，取净增较大者
  private _resolveKoAtEndgame(): void {
    if (this.koPoint.row < 0 || this.koPoint.col < 0) return;

    const savedBoard = this.board.clone();
    const savedCounters = this.counters;
    const savedKo = this.koPoint;

    // 模拟黑方提劫
    this.counters = new Map(savedCounters);
    const blackNet = this._simulateKoWin(Color.BLACK);

    // 还原 → 模拟白方提劫
    this.board.grid = new Uint8Array(savedBoard.grid);
    this.counters = new Map(savedCounters);
    const whiteNet = this._simulateKoWin(Color.WHITE);

    // 还原 → 应用净增较大者
    this.board.grid = new Uint8Array(savedBoard.grid);
    this.counters = new Map(savedCounters);
    if (blackNet > whiteNet) this._applyKoWin(Color.BLACK);
    else if (whiteNet > blackNet) this._applyKoWin(Color.WHITE);

    this.koPoint = NO_KO;
    this._invalidateCache();
    void savedKo;
  }

  private _simulateKoWin(winner: Color): number {
    const before = ScoreCalculator.compute(this.board, this.counters);
    const beforeTotal = winner === Color.BLACK
      ? this._totalOf(before.black)
      : this._totalOf(before.white);
    this._applyKoWin(winner);
    const after = ScoreCalculator.compute(this.board, this.counters);
    const afterTotal = winner === Color.BLACK
      ? this._totalOf(after.black)
      : this._totalOf(after.white);
    return afterTotal - beforeTotal;
  }

  private _applyKoWin(winner: Color): void {
    const res = GoRules.tryMove(this.board, this.koPoint.row, this.koPoint.col, winner, NO_KO);
    if (res.legal) {
      this._processCaptures(res, winner);
    }
  }

  private _totalOf(b: ScoreBreakdown): number {
    return b.occupationTerritory + b.occupationEfficiency + b.defenseAnnihilate + b.defenseSiege + b.casualtyLoss + b.casualtySpecial;
  }

  // ====== 悔棋 ======
  canUndo(): boolean {
    return this._undoStack.length > 0 && !this.gameOver;
  }

  undo(): MoveOutcome {
    const outcome: MoveOutcome = { ok: false, moverColor: this.toMove };
    if (!this.canUndo()) {
      outcome.reason = "无法悔棋";
      return outcome;
    }
    const snap = this._undoStack.pop()!;
    this._restoreSnapshot(snap);
    outcome.ok = true;
    outcome.undid = true;
    return outcome;
  }

  // ====== 快照 ======
  private _beginUndoSnapshot(): void {
    this._pendingSnap = this._takeSnapshot();
  }

  private _takeSnapshot(): GameSnapshot {
    return {
      grid: new Uint8Array(this.board.grid),
      toMove: this.toMove,
      ply: this.ply,
      consecutivePasses: this.consecutivePasses,
      passCounts: new Map(this.passCounts),
      passCooldown: new Map(this.passCooldown),
      gameOver: this.gameOver,
      stonesPlaced: new Map(this.stonesPlaced),
      stonesOnBoard: new Map(this.stonesOnBoard),
      replenishTotal: new Map(this.replenishTotal),
      ownMoves: new Map(this.ownMoves),
      specialUses: new Map(this.specialUses),
      specialStones: new Map(Array.from(this.specialStones.entries()).map(([k, v]) => [k, new Map(v)])),
      exposedSpecials: new Set(this.exposedSpecials),
      lastSpecialOwnMove: new Map(this.lastSpecialOwnMove),
      counters: new Map(
        Array.from(this.counters.entries()).map(([k, v]) => [k, { ...v }])
      ),
      koPoint: { ...this.koPoint },
      lastOutcome: this.lastOutcome,
      fogEnabled: this.fogEnabled,
      fogRevealed: new Set(this.fogRevealed),
    };
  }

  private _restoreSnapshot(snap: GameSnapshot): void {
    this.board.grid = new Uint8Array(snap.grid);
    this.toMove = snap.toMove;
    this.ply = snap.ply;
    this.consecutivePasses = snap.consecutivePasses;
    this.passCounts = new Map(snap.passCounts);
    this.passCooldown = new Map(snap.passCooldown);
    this.gameOver = snap.gameOver;
    this.stonesPlaced = new Map(snap.stonesPlaced);
    this.stonesOnBoard = new Map(snap.stonesOnBoard);
    this.replenishTotal = new Map(snap.replenishTotal);
    this.ownMoves = new Map(snap.ownMoves);
    this.specialUses = new Map(snap.specialUses);
    this.specialStones = new Map(Array.from(snap.specialStones.entries()).map(([k, v]) => [k, new Map(v)]));
    this.exposedSpecials = new Set(snap.exposedSpecials);
    this.lastSpecialOwnMove = new Map(snap.lastSpecialOwnMove);
    this.counters = new Map(
      Array.from(snap.counters.entries()).map(([k, v]) => [k, { ...v }])
    );
    this.koPoint = { ...snap.koPoint };
    this.lastOutcome = snap.lastOutcome;
    this.fogEnabled = snap.fogEnabled;
    this.fogRevealed = new Set(snap.fogRevealed);
    this._invalidateCache();
  }

  // ====== 克隆（供 AI 搜索用，MVP 暂不用但保留） ======
  clone(): GameSession {
    const s = new GameSession({
      komi: this.komi,
      pieceLimit: this.pieceLimit,
      enableDeployPhase: this.enableDeployPhase,
      fogEnabled: this.fogEnabled,
      specialForces: this.specialForces,
    });
    s.board.grid = new Uint8Array(this.board.grid);
    s.toMove = this.toMove;
    s.ply = this.ply;
    s.consecutivePasses = this.consecutivePasses;
    s.passCounts = new Map(this.passCounts);
    s.passCooldown = new Map(this.passCooldown);
    s.gameOver = this.gameOver;
    s.stonesPlaced = new Map(this.stonesPlaced);
    s.stonesOnBoard = new Map(this.stonesOnBoard);
    s.replenishTotal = new Map(this.replenishTotal);
    s.ownMoves = new Map(this.ownMoves);
    s.specialUses = new Map(this.specialUses);
    s.specialStones = new Map(Array.from(this.specialStones.entries()).map(([k, v]) => [k, new Map(v)]));
    s.exposedSpecials = new Set(this.exposedSpecials);
    s.lastSpecialOwnMove = new Map(this.lastSpecialOwnMove);
    s.counters = new Map(
      Array.from(this.counters.entries()).map(([k, v]) => [k, { ...v }])
    );
    s.koPoint = { ...this.koPoint };
    s.fogRevealed = new Set(this.fogRevealed);
    s._useCache = false; // 克隆禁用缓存避免频繁失效
    return s;
  }
}

interface GameSnapshot {
  grid: Uint8Array;
  toMove: Color;
  ply: number;
  consecutivePasses: number;
  passCounts: Map<Color, number>;
  passCooldown: Map<Color, number>;
  gameOver: boolean;
  stonesPlaced: Map<Color, number>;
  stonesOnBoard: Map<Color, number>;
  replenishTotal: Map<Color, number>;
  ownMoves: Map<Color, number>;
  specialUses: Map<Color, number>;
  specialStones: Map<Color, Map<number, number>>;
  exposedSpecials: Set<number>;
  lastSpecialOwnMove: Map<Color, number>;
  counters: CountersMap;
  koPoint: Point;
  lastOutcome: MoveOutcome | FinalResult | null;
  fogEnabled: boolean;
  fogRevealed: Set<number>;
}
