// 游戏房间：权威规则引擎集成（GameSession）、落子/虚手/认输处理、计时器、断线判负、终局结算
// 规划文档 §3：权威规则引擎在服务器运行，客户端只做渲染
//   - 计时：费舍尔制（基础 10 分钟 + 每手加 10 秒），服务器统一计时
//   - 断线处理：立即判负（MVP 不做重连）
//   - 对局结束：连续虚手 / 认输 / 超时 / 断线 / 兵力用尽

import type { Server } from "socket.io";
import {
  Color,
  GameSession,
  opponent,
  BOARD_SIZE,
  DEPLOY_PHASE_MOVES,
} from "@warhorn/engine";
import {
  ServerEvent,
  PlayerColor,
  type IdentityKind,
  type SerializedBoard,
  type MoveOutcome,
  type FinalResult,
  type ScoreSide,
  type ScoreBreakdown,
  type GameStartPayload,
  type GameUpdatePayload,
  type TimeUpdatePayload,
  type GameOverPayload,
  type GameRecoverPayload,
  type OpponentStatusPayload,
} from "@warhorn/shared";
import { ServerTimer, type TimerSnapshot } from "./Timer.js";
import type { EndCategory, GameMetrics } from "./Store.js";

// 断线重连窗口：离线后保留对局等待重连的总时长，超过则断线判负
const RECONNECT_WINDOW_MS = 45_000;

interface RoomPlayer {
  socketId: string;
  name: string;
  kind: IdentityKind;
  color: Color;
}

// 一局对局的参数快照（由 Config 提供，随对局记录落盘）
export interface RoomSettings {
  komi: number;
  pieceLimit: number;
  timerBaseSec: number;
  timerIncrementSec: number; // 已弃用：读秒制裁去每手加时（恒为0，兼容）
  byoPeriodSec: number; // 每次读秒秒数
  byoCount: number; // 读秒次数
  deployTimerSec: number;
  fogEnabled: boolean; // 战争迷雾（可选规则）：双方都勾选才启用
  specialForces: boolean; // 特种部队（可选规则）：双方都勾选才启用，与迷雾互斥
}

export interface GameRoomCallbacks {
  // 对局结束回调：index 用于清理房间 + 重置玩家状态 + 记录战绩（含平衡指标）
  onGameOver: (
    roomId: string,
    playerSocketIds: string[],
    result: FinalResult,
    metrics: GameMetrics
  ) => void;
}

export class GameRoom {
  readonly roomId: string;
  private readonly _io: Server;
  private readonly _cb: GameRoomCallbacks;
  private readonly _settings: RoomSettings;
  private readonly _session: GameSession;
  private readonly _timer: ServerTimer;
  private readonly _black: RoomPlayer;
  private readonly _white: RoomPlayer;
  // socketId -> Color（便于快速定位行棋方）
  private readonly _socketToColor: Map<string, Color> = new Map();
  private _ended: boolean = false;
  private _startedAt: number = 0;
  private _endCategory: EndCategory = "pass";
  // 断线重连：双方在线标志 + 各自重连等待定时器（超时才断线判负）
  private _connected: { black: boolean; white: boolean } = { black: true, white: true };
  private _reconnect: { black?: NodeJS.Timeout; white?: NodeJS.Timeout } = {};
  // 整盘计时是否因有人断线而暂停（等待窗口内不计时，重连后恢复计时）
  private _timerPaused: boolean = false;


  // 玩家信息只读暴露（持久化 + 天梯记账资格判断用）
  get blackInfo(): { socketId: string; name: string; kind: IdentityKind; color: Color } {
    return this._black;
  }
  get whiteInfo(): { socketId: string; name: string; kind: IdentityKind; color: Color } {
    return this._white;
  }
  get ended(): boolean {
    return this._ended;
  }

  constructor(
    roomId: string,
    io: Server,
    cb: GameRoomCallbacks,
    black: { socketId: string; name: string; kind: IdentityKind },
    white: { socketId: string; name: string; kind: IdentityKind },
    settings: RoomSettings
  ) {
    this.roomId = roomId;
    this._io = io;
    this._cb = cb;
    this._settings = settings;

    this._black = { socketId: black.socketId, name: black.name, kind: black.kind, color: Color.BLACK };
    this._white = { socketId: white.socketId, name: white.name, kind: white.kind, color: Color.WHITE };
    this._socketToColor.set(black.socketId, Color.BLACK);
    this._socketToColor.set(white.socketId, Color.WHITE);

    // 权威规则引擎：开启布局阶段，参数来自配置（贴目/兵力/迷雾）
    this._session = new GameSession({
      komi: settings.komi,
      pieceLimit: settings.pieceLimit,
      enableDeployPhase: true,
      fogEnabled: settings.fogEnabled,
      specialForces: settings.specialForces,
    });
    this._session.newGame();

    this._timer = new ServerTimer(
      {
        onTick: (snap: TimerSnapshot) => this._broadcastTime(snap),
        onTimeout: (loser: Color) => this._handleTimeout(loser),
      },
      {
        baseTime: settings.timerBaseSec,
        byoPeriod: settings.byoPeriodSec,
        byoCount: settings.byoCount,
        deployTime: settings.deployTimerSec,
      }
    );
  }

  // ====== 对局启动 ======

  start(): void {
    this._startedAt = Date.now();
    const base: GameStartPayload = {
      roomId: this.roomId,
      blackName: this._black.name,
      whiteName: this._white.name,
      ownColor: PlayerColor.BLACK,
      initialState: this._serializeBoard(),
      baseTimeSec: this._settings.timerBaseSec,
      incrementSec: this._settings.timerIncrementSec,
      byoPeriodSec: this._settings.byoPeriodSec,
      byoCount: this._settings.byoCount,
      komi: this._settings.komi,
      pieceLimit: this._settings.pieceLimit,
      fogEnabled: this._settings.fogEnabled,
      specialForces: this._settings.specialForces,
    };
    // 双方 ownColor 不同，分别发送
    this._io
      .to(this._black.socketId)
      .emit(ServerEvent.GAME_START, { ...base, ownColor: PlayerColor.BLACK });
    this._io
      .to(this._white.socketId)
      .emit(ServerEvent.GAME_START, { ...base, ownColor: PlayerColor.WHITE });

    // BLACK 先手，启动计时器（switchTo(BLACK) 不会给任何人加时）
    this._timer.start(Color.BLACK);
  }

  // ====== 客户端事件处理 ======

  hasSocket(socketId: string): boolean {
    return this._socketToColor.has(socketId);
  }

  handlePlace(socketId: string, row: number, col: number): void {
    if (this._ended) return;
    const color = this._socketToColor.get(socketId);
    if (color === undefined) {
      this._emitError(socketId, "你不在此房间");
      return;
    }
    // 权威引擎验证落子
    const outcome = this._session.playMove(color, row, col);
    if (!outcome.ok) {
      this._emitError(socketId, outcome.reason ?? "非法落子");
      return;
    }
    this._afterMove(outcome);
  }

  handlePass(socketId: string): void {
    if (this._ended) return;
    const color = this._socketToColor.get(socketId);
    if (color === undefined) {
      this._emitError(socketId, "你不在此房间");
      return;
    }
    const outcome = this._session.doPass(color);
    if (!outcome.ok) {
      this._emitError(socketId, outcome.reason ?? "非法虚手");
      return;
    }
    this._afterMove(outcome);
  }

  // 特种部队部署（可选规则）：与落子同构，走统一广播/计时流程
  handleSpecial(socketId: string, row: number, col: number): void {
    if (this._ended) return;
    const color = this._socketToColor.get(socketId);
    if (color === undefined) {
      this._emitError(socketId, "你不在此房间");
      return;
    }
    const outcome = this._session.deploySpecial(color, row, col);
    if (!outcome.ok) {
      this._emitError(socketId, outcome.reason ?? "非法部署");
      return;
    }
    this._afterMove(outcome);
  }

  handleResign(socketId: string): void {
    if (this._ended) return;
    const color = this._socketToColor.get(socketId);
    if (color === undefined) {
      this._emitError(socketId, "你不在此房间");
      return;
    }
    const outcome = this._session.resign(color);
    if (!outcome.ok || !outcome.result) {
      this._emitError(socketId, outcome.reason ?? "无法认输");
      return;
    }
    // resign 已在引擎内设置 gameOver，这里直接进入终局流程
    this._endCategory = "resign";
    this._endGame(outcome.result);
  }

  // 断线：进入重连等待窗口（暂停计时、通知对手），超时后才判负
  handleDisconnect(socketId: string): void {
    if (this._ended) return;
    const color = this._socketToColor.get(socketId);
    if (color === undefined) return;
    const key = color === Color.BLACK ? "black" : "white";
    // 已在该方断线窗口中（重复断线忽略）
    if (!this._connected[key]) return;
    this._connected[key] = false;

    // 整盘计时暂停：等待窗口内不消耗任何时间（对双方公平）
    if (!this._timerPaused) {
      this._timerPaused = true;
      this._timer.pause();
    }
    // 通知对手：对方断线，进入等待窗口
    this._io
      .to(this._opponentSocket(color))
      .emit(ServerEvent.OPPONENT_DISCONNECTED, { color: color as unknown as PlayerColor } as OpponentStatusPayload);

    // 启动重连等待窗口，超时则断线判负
    this._reconnect[key] = setTimeout(() => {
      this._reconnect[key] = undefined;
      if (this._ended) return;
      this._forfeitDisconnect(color);
    }, RECONNECT_WINDOW_MS);
  }

  // 重连身份校验：仅允许"名字 + 执色"匹配的玩家恢复本局
  matchPlayer(name: string, color: Color): boolean {
    const p = color === Color.BLACK ? this._black : this._white;
    return p.color === color && p.name === name;
  }

  // 重连：改绑新 socket、恢复计时、下发全盘快照并通知对手
  resumeGame(color: Color, newSocketId: string): boolean {
    if (this._ended) return false;
    const key = color === Color.BLACK ? "black" : "white";
    const pkt = color === Color.BLACK ? this._black : this._white;

    // 改绑 socket（旧 socket 已断开，emit 目标随之切换）
    this._socketToColor.delete(pkt.socketId);
    pkt.socketId = newSocketId;
    this._socketToColor.set(newSocketId, color);
    this._connected[key] = true;

    // 取消重连等待窗口
    const t = this._reconnect[key];
    if (t) {
      clearTimeout(t);
      this._reconnect[key] = undefined;
    }
    // 对手在线时恢复整盘计时
    if (this._connected[color === Color.BLACK ? "white" : "black"] && this._timerPaused) {
      this._timerPaused = false;
      this._timer.resume();
    }

    // 下发当前全盘恢复快照（按重连方视角）
    this._io.to(newSocketId).emit(ServerEvent.GAME_RECOVER, this._buildRecoverPayload(color));
    // 通知对手：对手已重连
    this._io
      .to(this._opponentSocket(color))
      .emit(ServerEvent.GAME_RESUMED, { color: color as unknown as PlayerColor } as OpponentStatusPayload);
    return true;
  }

  cleanup(): void {
    this._timer.stop();
    // 清理未决的重连等待定时器（对局结束时一并取消）
    for (const k of ["black", "white"] as const) {
      const t = this._reconnect[k];
      if (t) {
        clearTimeout(t);
        this._reconnect[k] = undefined;
      }
    }
  }

  // ====== 内部 ======

  // 落子/虚手后的统一处理：切换计时器、广播 update、必要时终局
  private _afterMove(outcome: MoveOutcome): void {
    if (outcome.gameOver) {
      this._timer.stop();
    } else {
      // 布局→正式阶段过渡：重置双方计时器为完整基础时间
      const wasDeploy = outcome.ply !== undefined && outcome.ply <= DEPLOY_PHASE_MOVES;
      if (wasDeploy && !this._session.isInDeployPhase()) {
        this._timer.resetToBaseTime();
      }
      // 切换行棋方：正式阶段加 increment（费舍尔制），布局阶段不加
      this._timer.switchTo(this._session.toMove);
    }

    this._broadcastUpdate(outcome);

    if (outcome.gameOver && outcome.result) {
      this._endGame(outcome.result);
    }
  }

  private _handleTimeout(loser: Color): void {
    if (this._ended) return;
    this._endCategory = "timeout";
    // 超时方判负
    const outcome = this._session.resign(loser);
    if (!outcome.ok || !outcome.result) {
      this._endGame(this._buildForfeitResult(loser, "超时判负"));
      return;
    }
    outcome.result.reason = `${loser === Color.BLACK ? "黑" : "白"}方超时判负`;
    this._endGame(outcome.result);
  }

  private _endGame(result: FinalResult): void {
    if (this._ended) return;
    this._ended = true;
    this._timer.stop();

    const payload: GameOverPayload = {
      winner: result.winnerColor,
      reason: result.reason,
      finalResult: result,
    };
    this._io.to(this._black.socketId).emit(ServerEvent.GAME_OVER, payload);
    this._io.to(this._white.socketId).emit(ServerEvent.GAME_OVER, payload);

    this._cb.onGameOver(
      this.roomId,
      [this._black.socketId, this._white.socketId],
      result,
      this._collectMetrics(result)
    );
  }

  // 采集终局平衡指标（随对局记录落盘，供平衡调参分析）
  private _collectMetrics(result: FinalResult): GameMetrics {
    const countersBlack = this._session.counters.get(Color.BLACK);
    const countersWhite = this._session.counters.get(Color.WHITE);
    return {
      endCategory: this._endCategory,
      durationSec: Math.max(0, Math.round((Date.now() - this._startedAt) / 1000)),
      // 黑方相对分差（正=黑方领先，用于分差分布/贴目评估）
      scoreDiff: result.black.final - result.white.final,
      stonesBlack: this._session.stonesPlaced.get(Color.BLACK) ?? 0,
      stonesWhite: this._session.stonesPlaced.get(Color.WHITE) ?? 0,
      passBlack: this._session.passCounts.get(Color.BLACK) ?? 0,
      passWhite: this._session.passCounts.get(Color.WHITE) ?? 0,
      // 提吃数 = 对方被提子数（normalLost 口径）
      captureBlack: countersWhite?.normalLost ?? 0,
      captureWhite: countersBlack?.normalLost ?? 0,
      breakdownBlack: result.black.breakdown,
      breakdownWhite: result.white.breakdown,
      moves: this._session.moveHistory, // 逐手棋谱
      fogEnabled: this._settings.fogEnabled, // 规则开关快照（回放需按相同开关重建）
      specialForces: this._settings.specialForces,
    };
  }

  // 超时/断线的兜底结果（当引擎已无法生成时使用）
  private _buildForfeitResult(loser: Color, reason: string): FinalResult {
    const winner = opponent(loser);
    const scores = this._session.scores();
    const blackSide = this._scoreSide(scores.black, true);
    const whiteSide = this._scoreSide(scores.white, false);
    return {
      black: blackSide,
      white: whiteSide,
      winner: winner === Color.BLACK ? "黑方胜" : "白方胜",
      winnerColor: winner,
      reason: `${loser === Color.BLACK ? "黑" : "白"}方${reason}`,
      ply: this._session.ply,
    };
  }

  // 断线重连窗口超时：断线方判负
  private _forfeitDisconnect(color: Color): void {
    if (this._ended) return;
    this._endCategory = "disconnect";
    const outcome = this._session.resign(color);
    if (!outcome.ok || !outcome.result) {
      this._endGame(this._buildForfeitResult(color, "断线判负"));
      return;
    }
    outcome.result.reason = `${color === Color.BLACK ? "黑" : "白"}方断线判负`;
    this._endGame(outcome.result);
  }

  // 指定执色的对手 socketId
  private _opponentSocket(color: Color): string {
    return color === Color.BLACK ? this._white.socketId : this._black.socketId;
  }

  // 构造重连全盘恢复快照（按重连方视角过滤迷雾/特种隐子）
  private _buildRecoverPayload(color: Color): GameRecoverPayload {
    const scores = this._session.scores();

    // 按重连方视角计算可见棋盘与迷雾/特种数据
    const fogActive = this._session.isFogActive();
    const specUses = this._settings.specialForces
      ? {
          black: this._session.specialUses.get(Color.BLACK) ?? 0,
          white: this._session.specialUses.get(Color.WHITE) ?? 0,
        }
      : undefined;

    let grid: number[];
    let fogCells: number[] | undefined;
    let specialOwn: number[] | undefined;
    let specials: number[] | undefined;
    if (fogActive) {
      grid = Array.from(this._session.visibleGridOf(color));
      fogCells = [...this._session.fogCellsOf(color)];
      if (this._settings.specialForces) {
        specialOwn = [...this._session.ownHiddenSpecialsOf(color)];
        specials = [...this._session.visibleSpecialsOf(color)];
      }
    } else if (this._settings.specialForces) {
      grid = Array.from(this._session.specialVisibleGrid(color));
      specialOwn = [...this._session.ownHiddenSpecialsOf(color)];
      specials = [...this._session.visibleSpecialsOf(color)];
    } else {
      grid = this._session.board.serialize();
    }

    return {
      roomId: this.roomId,
      blackName: this._black.name,
      whiteName: this._white.name,
      ownColor: color as unknown as PlayerColor,
      initialState: { size: BOARD_SIZE, grid },
      baseTimeSec: this._settings.timerBaseSec,
      incrementSec: this._settings.timerIncrementSec,
      byoPeriodSec: this._settings.byoPeriodSec,
      byoCount: this._settings.byoCount,
      komi: this._settings.komi,
      pieceLimit: this._settings.pieceLimit,
      fogEnabled: this._settings.fogEnabled,
      specialForces: this._settings.specialForces,
      currentTurn: this._session.toMove,
      timers: this._timer.snapshot(),
      scores: {
        black: this._scoreSide(scores.black, true),
        white: this._scoreSide(scores.white, false),
      },
      stonesPlaced: {
        black: this._session.stonesPlaced.get(Color.BLACK) ?? 0,
        white: this._session.stonesPlaced.get(Color.WHITE) ?? 0,
      },
      stonesOnBoard: {
        black: this._session.stonesOnBoardOf(Color.BLACK),
        white: this._session.stonesOnBoardOf(Color.WHITE),
      },
      replenishTotal: {
        black: this._session.replenishOf(Color.BLACK),
        white: this._session.replenishOf(Color.WHITE),
      },
      ply: this._session.ply,
      passCounts: {
        black: this._session.passCounts.get(Color.BLACK) ?? 0,
        white: this._session.passCounts.get(Color.WHITE) ?? 0,
      },
      lastMove: this._lastPlaced(),
      fogCells,
      specialUses: specUses,
      specialOwn,
      specials,
    };
  }

  // 最后一手实际落点（虚手或空局返回 undefined）
  private _lastPlaced(): { row: number; col: number } | undefined {
    const hist = this._session.moveHistory;
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (m.r >= 0 && m.col >= 0) return { row: m.r, col: m.col };
    }
    return undefined;
  }

  // ====== 广播 ======

  // 迷雾/特种对局：按接收方视角过滤棋盘（隐藏对方隐藏棋子）并下发视角相关数据
  private _viewPayload(color: Color, base: Omit<GameUpdatePayload, "board" | "fogCells">): GameUpdatePayload {
    const fogActive = this._session.isFogActive();
    // 迷雾活跃时：迷雾负责隐藏所有视野外棋子（含隐子），特种数据照常下发
    if (fogActive) {
      return {
        ...base,
        outcome: this._sanitizeSpecialOutcome(base.outcome, color),
        board: {
          size: BOARD_SIZE,
          grid: Array.from(this._session.visibleGridOf(color)),
        },
        fogCells: [...this._session.fogCellsOf(color)],
        specialForces: this._settings.specialForces || undefined,
        specialUses: this._settings.specialForces
          ? {
              black: this._session.specialUses.get(Color.BLACK) ?? 0,
              white: this._session.specialUses.get(Color.WHITE) ?? 0,
            }
          : undefined,
        specialOwn: this._settings.specialForces
          ? [...this._session.ownHiddenSpecialsOf(color)]
          : undefined,
        specials: this._settings.specialForces
          ? [...this._session.visibleSpecialsOf(color)]
          : undefined,
      };
    }
    // 迷雾消散或无迷雾：特种部队负责隐藏对方未暴露隐子
    if (this._settings.specialForces) {
      return {
        ...base,
        outcome: this._sanitizeSpecialOutcome(base.outcome, color),
        board: {
          size: BOARD_SIZE,
          grid: Array.from(this._session.specialVisibleGrid(color)),
        },
        fogCells: undefined,
        specialForces: true,
        specialUses: {
          black: this._session.specialUses.get(Color.BLACK) ?? 0,
          white: this._session.specialUses.get(Color.WHITE) ?? 0,
        },
        specialOwn: [...this._session.ownHiddenSpecialsOf(color)],
        specials: [...this._session.visibleSpecialsOf(color)],
      };
    }
    return { ...base, board: this._serializeBoard(), fogCells: undefined };
  }

  // 特种部署对部署方以外的视角：隐藏部署落点（placed/specialDeployAt），避免暴露隐子位置
  private _sanitizeSpecialOutcome(outcome: MoveOutcome, receiver: Color): MoveOutcome {
    if (!outcome.special || receiver === outcome.moverColor) {
      return outcome;
    }
    const cleaned: MoveOutcome = { ...outcome };
    delete cleaned.specialDeployAt;
    delete cleaned.placed;
    return cleaned;
  }

  private _broadcastUpdate(outcome: MoveOutcome): void {
    const scores = this._session.scores();
    const base: Omit<GameUpdatePayload, "board" | "fogCells"> = {
      outcome,
      currentTurn: this._session.toMove,
      timers: this._timer.snapshot(),
      scores: {
        black: this._scoreSide(scores.black, true),
        white: this._scoreSide(scores.white, false),
      },
      stonesPlaced: {
        black: this._session.stonesPlaced.get(Color.BLACK) ?? 0,
        white: this._session.stonesPlaced.get(Color.WHITE) ?? 0,
      },
      stonesOnBoard: {
        black: this._session.stonesOnBoardOf(Color.BLACK),
        white: this._session.stonesOnBoardOf(Color.WHITE),
      },
      replenishTotal: {
        black: this._session.replenishOf(Color.BLACK),
        white: this._session.replenishOf(Color.WHITE),
      },
      fogEnabled: this._settings.fogEnabled,
    };
    const payloadBlack = this._viewPayload(Color.BLACK, base);
    const payloadWhite = this._viewPayload(Color.WHITE, base);
    this._io.to(this._black.socketId).emit(ServerEvent.GAME_UPDATE, payloadBlack);
    this._io.to(this._white.socketId).emit(ServerEvent.GAME_UPDATE, payloadWhite);
  }

  private _broadcastTime(snap: TimerSnapshot): void {
    const payload: TimeUpdatePayload = { black: snap.black, white: snap.white };
    this._io.to(this._black.socketId).emit(ServerEvent.TIME_UPDATE, payload);
    this._io.to(this._white.socketId).emit(ServerEvent.TIME_UPDATE, payload);
  }

  private _emitError(socketId: string, message: string): void {
    this._io.to(socketId).emit(ServerEvent.ERROR, { message });
  }

  // ====== 工具 ======

  private _serializeBoard(): SerializedBoard {
    return {
      size: BOARD_SIZE,
      grid: this._session.board.serialize(),
    };
  }

  // 由 ScoreBreakdown 构造 ScoreSide（盘中实时分数：total - komi）
  private _scoreSide(breakdown: ScoreBreakdown, isBlack: boolean): ScoreSide {
    const total =
      breakdown.occupationTerritory +
      breakdown.occupationEfficiency +
      breakdown.defenseAnnihilate +
      breakdown.defenseSiege +
      breakdown.casualtyLoss +
      breakdown.casualtySpecial;
    const komi = isBlack ? this._session.komi : 0;
    return { breakdown, total, komi, final: total - komi };
  }
}
