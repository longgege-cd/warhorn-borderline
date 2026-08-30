// 在线对局界面：通过 SocketClient 驱动，服务器为权威规则源
// 得分板按原项目 ScorePanel.gd 5模块结构实现

import {
  Color, BOARD_SIZE, DEPLOY_PHASE_MOVES, SPECIAL_MAX_USES, PASS_LIMIT_PER_GAME,
  TerritoryDetector, SiegeDetector, BoardModel,
} from "@warhorn/engine";
import type { Enclosure, Group } from "@warhorn/engine";
import type {
  MoveOutcome, FinalResult, ScoreSide, ScoreBreakdown,
  GameStartPayload, GameUpdatePayload,
  ColorTimer,
  TimersState,
  GameOverPayload, TimeUpdatePayload, GameRecoverPayload,
} from "@warhorn/shared";
import { BoardCanvas } from "../BoardCanvas.js";
import type { SocketClient } from "../net/SocketClient.js";
import { t, tpl, tThemeName } from "../i18n.js";
import { ScorePanel, type ScoreLogEntry } from "../components/ScorePanel.js";

export class OnlineGameScreen {
  readonly el: HTMLElement;
  private readonly client: SocketClient;
  private readonly ownColor: Color;
  private readonly blackName: string;
  private readonly whiteName: string;

  private board: BoardModel;
  private boardCanvas: BoardCanvas;

  private readonly komi: number;
  private readonly pieceLimit: number;
  private currentTurn: Color = Color.BLACK;
  private timers: TimersState = { black: this._emptyTimer(), white: this._emptyTimer() };
  private timerMax: number = 600;
  private stonesPlaced: { black: number; white: number } = { black: 0, white: 0 };
  private passCounts: { black: number; white: number } = { black: 0, white: 0 };
  private replen: { black: number; white: number } = { black: 0, white: 0 };
  private cachedScores: { black: ScoreSide; white: ScoreSide } | null = null;
  private lastMove: { row: number; col: number } | null = null;
  private currentPly: number = 0;
  private gameOver: boolean = false;

  // 战争迷雾（可选规则）：服务端按接收方视角下发棋盘与迷雾覆盖区
  private fogEnabled: boolean = false;
  private fogCells: Set<number> = new Set();

  // 特种部队（可选规则）：服务端分视角下发隐子状态与双方发动次数（与迷雾互斥）
  private specialForces: boolean = false;
  private specialUses: { black: number; white: number } = { black: 0, white: 0 };
  private specialMode: boolean = false;
  private specialBtn!: HTMLButtonElement;
  // 本视角可见的特种棋子索引（服务端下发；不含对方未现形隐子）
  private visibleSpecials: Set<number> = new Set();

  private logEntries: ScoreLogEntry[] = [];

  private blackPanel: ScorePanel;
  private whitePanel: ScorePanel;

  private statusEl!: HTMLElement;
  private deployBannerEl!: HTMLElement;
  private disconnectBannerEl!: HTMLElement;
  private passBtn!: HTMLButtonElement;
  private resignBtn!: HTMLButtonElement;
  private _unbinds: Array<() => void> = [];

  constructor(client: SocketClient, payload: GameStartPayload) {
    this.client = client;
    this.ownColor = payload.ownColor as Color;
    this.blackName = payload.blackName;
    this.whiteName = payload.whiteName;
    this.board = new BoardModel(payload.initialState.size);
    this.board.grid = new Uint8Array(payload.initialState.grid);
    this.timerMax = payload.baseTimeSec;
    // 按开局参数初始化读秒制计时（服务器每秒广播覆盖）
    this.timers = {
      black: this._mkTimer(payload.baseTimeSec, payload.byoPeriodSec, payload.byoCount),
      white: this._mkTimer(payload.baseTimeSec, payload.byoPeriodSec, payload.byoCount),
    };
    this.komi = payload.komi;
    this.pieceLimit = payload.pieceLimit;
    this.fogEnabled = payload.fogEnabled;
    this.specialForces = payload.specialForces;

    this.boardCanvas = new BoardCanvas({ cellSize: 30, padding: 26 });
    this.boardCanvas.setDeployPhase(true);
    this.boardCanvas.onInfluenceToggle = (shown) => {
      this._showToast(shown ? t("influence.on") : t("influence.off"));
    };
    this.boardCanvas.onThemeToggle = (name) => {
      this._showToast(tpl("theme.switched", tThemeName(name)));
    };
    this.blackPanel = new ScorePanel("black");
    this.whitePanel = new ScorePanel("white");
    this.el = this._build();
    this._bindBoard();
    this._bindSocketEvents();
    // 登记恢复档案：对局进行中若断线/刷新，重建本界面后据此恢复
    this.client.armResume({
      roomId: payload.roomId,
      name: this.client.getJoinedName() || payload.blackName || payload.whiteName,
      color: payload.ownColor,
      start: payload,
    });
    this._refresh();
  }

  destroy(): void {
    for (const unbind of this._unbinds) unbind();
    this._unbinds = [];
    this.boardCanvas.destroy();
    this.blackPanel.destroy();
    this.whitePanel.destroy();
  }

  private _build(): HTMLElement {
    const root = document.createElement("div");
    root.className = "screen game-screen";
    const topRole = this.ownColor === Color.BLACK ? t("black") : t("white");
    root.innerHTML = `
      <div class="side-panel side-left" id="panel-black"></div>
      <div class="game-main">
        <div class="game-topbar">
          <span class="topbar-title">${tpl("title.online", topRole)}</span>
          <span class="topbar-status" id="status"></span>
        </div>
        <div class="board-wrapper">
          <div class="board-container" id="board-container"></div>
          <div class="deploy-banner" id="deploy-banner">${t("deployBanner")}</div>
          <div class="disconnect-banner" id="disconnect-banner" hidden></div>
        </div>
        <div class="game-controls">
          <button class="btn" id="btn-pass">${t("pass")}</button>
          <button class="btn" id="btn-special" hidden>${t("special.toggle")}</button>
          <button class="btn btn-danger" id="btn-resign">${t("resign")}</button>
          <button class="btn" id="btn-lobby">${t("backLobbyBtn")}</button>
          <button class="btn" id="btn-sparkle">${t("fx.sparkleOff")}</button>
        </div>
      </div>
      <div class="side-panel side-right" id="panel-white"></div>
    `;
    root.querySelector("#board-container")!.appendChild(this.boardCanvas.canvas);
    root.querySelector("#panel-black")!.appendChild(this.blackPanel.el);
    root.querySelector("#panel-white")!.appendChild(this.whitePanel.el);

    this.statusEl = root.querySelector("#status")!;
    this.deployBannerEl = root.querySelector("#deploy-banner")!;
    this.disconnectBannerEl = root.querySelector("#disconnect-banner")!;
    this.passBtn = root.querySelector("#btn-pass")!;
    this.resignBtn = root.querySelector("#btn-resign")!;
    this.specialBtn = root.querySelector("#btn-special")!;

    root.querySelector("#btn-pass")!.addEventListener("click", () => this._onPass());
    root.querySelector("#btn-special")!.addEventListener("click", () => this._onSpecialToggle());
    root.querySelector("#btn-resign")!.addEventListener("click", () => this._onResign());
    root.querySelector("#btn-lobby")!.addEventListener("click", () => this._onBackToLobby());

    const sparkleBtn = root.querySelector("#btn-sparkle") as HTMLButtonElement;
    const syncSparkle = () => {
      const on = this.boardCanvas.isSparkleEnabled();
      sparkleBtn.classList.toggle("active", on);
      sparkleBtn.textContent = t(on ? "fx.sparkleOff" : "fx.sparkleOn");
    };
    syncSparkle();
    sparkleBtn.addEventListener("click", () => {
      this.boardCanvas.toggleSparkle();
      syncSparkle();
    });

    // 键盘快捷键：S = 切换特种部队部署模式（Esc 取消）
    root.tabIndex = 0;
    root.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "s" || e.key === "S") {
        if (!this.specialForces || this.specialBtn.hidden || this.specialBtn.disabled) return;
        e.preventDefault();
        this._onSpecialToggle();
      } else if (e.key === "Escape" && this.specialMode) {
        this.specialMode = false;
        this._refresh();
      }
    });

    return root;
  }

  private _bindBoard(): void {
    this.boardCanvas.onCellClick = (row, col) => this._onCellClick(row, col);
  }

  private _bindSocketEvents(): void {
    const prevUpdate = this.client.onGameUpdate;
    const prevOver = this.client.onGameOver;
    const prevTime = this.client.onTimeUpdate;
    const prevError = this.client.onError;
    const prevRecover = this.client.onGameRecover;
    const prevOppDis = this.client.onOpponentDisconnected;
    const prevResumed = this.client.onGameResumed;

    this.client.onGameUpdate = (p: GameUpdatePayload) => this._onGameUpdate(p);
    this.client.onGameOver = (p: GameOverPayload) => this._onGameOver(p);
    this.client.onTimeUpdate = (p: TimeUpdatePayload) => this._onTimeUpdate(p);
    this.client.onError = (p) => this._showToast(p.message);
    this.client.onGameRecover = (p: GameRecoverPayload) => this.applyRecover(p);
    this.client.onOpponentDisconnected = () => this._showDisconnectBanner(t("opponentDisconnected"));
    this.client.onGameResumed = () => {
      this._clearDisconnectBanner();
      this._showToast(t("opponentResumed"), 2000);
    };

    this._unbinds.push(() => {
      this.client.onGameUpdate = prevUpdate;
      this.client.onGameOver = prevOver;
      this.client.onTimeUpdate = prevTime;
      this.client.onError = prevError;
      this.client.onGameRecover = prevRecover;
      this.client.onOpponentDisconnected = prevOppDis;
      this.client.onGameResumed = prevResumed;
    });
  }

  private _isMyTurn(): boolean {
    return !this.gameOver && this.currentTurn === this.ownColor;
  }

  private _onCellClick(row: number, col: number): void {
    if (this.boardCanvas.isOpeningActive()) return; // 开局倒计时期间禁止下子
    if (!this._isMyTurn()) {
      if (!this.gameOver) this._showToast(t("waitOpponent"));
      return;
    }
    if (this.specialMode) {
      this.specialMode = false;
      this.client.placeSpecial(row, col);
      this._refresh();
    } else {
      this.client.placeMove(row, col);
    }
  }

  // 切换"部署特种"待命模式
  private _onSpecialToggle(): void {
    if (!this._isMyTurn()) {
      this._showToast(t("waitOpponentMove"));
      return;
    }
    this.specialMode = !this.specialMode;
    this._showToast(this.specialMode ? t("special.armed") : t("special.cancel"));
    this._refresh();
  }

  private _onPass(): void {
    if (!this._isMyTurn()) {
      if (!this.gameOver) this._showToast(t("waitOpponentMove"));
      return;
    }
    this.client.pass();
  }

  private _onResign(): void {
    if (this.gameOver) return;
    if (!confirm(t("resignConfirmOnline"))) return;
    this.client.resign();
  }

  private _onBackToLobby(): void {
    if (!this.gameOver) {
      if (!confirm(t("backLobby"))) return;
      this.client.resign();
    }
    // 主动离开/对局已结束后不再需要恢复档案，先清除，刷新后就不会误尝试恢复已结束对局
    this.client.disarmResume();
    window.location.reload();
  }

  private _emptyTimer(): ColorTimer {
    return { main: 0, inByoyomi: false, byoRemaining: 0, byoCur: 0 };
  }

  private _mkTimer(main: number, byoPeriod: number, byoCount: number): ColorTimer {
    return { main, inByoyomi: false, byoRemaining: byoCount, byoCur: byoPeriod };
  }

  private _onGameUpdate(p: GameUpdatePayload): void {
    // 更新前：计算旧状态（用于特效对比）。
    // 迷雾/特种视野下围空/围困不上屏也不播特效，跳过全盘 DFS 计算
    const prevEncs = this._viewHidesRegions() ? [] : TerritoryDetector.enclosures(this.board);
    const prevSieged: Set<number> = this._viewHidesRegions()
      ? new Set()
      : this._siegedSet(SiegeDetector.solveDeadAlive(this.board).sieged);

    this.board = BoardModel.deserialize(p.board.size, p.board.grid);
    this.currentTurn = p.currentTurn as Color;
    // 非己方回合时退出特种待命模式
    if (this.currentTurn !== this.ownColor) this.specialMode = false;
    this.timers = { black: p.timers.black, white: p.timers.white };
    this.cachedScores = p.scores;
    // 兵力计数采用服务器权威的净计数（已扣回补），避免本地自增漏掉兵力补充
    if (p.stonesPlaced) this.stonesPlaced = { ...p.stonesPlaced };
    if (p.replenishTotal) this.replen = { ...p.replenishTotal };
    if (p.fogEnabled !== undefined) this.fogEnabled = p.fogEnabled;
    this.fogCells = p.fogCells ? new Set(p.fogCells) : new Set();
    if (p.specialForces !== undefined) this.specialForces = p.specialForces;
    if (p.specialUses) this.specialUses = p.specialUses;
    this.visibleSpecials = p.specials ? new Set(p.specials) : new Set();

    const o = p.outcome;
    if (o.ply !== undefined) this.currentPly = o.ply;

    // 虚手提示
    if (o.passed) {
      const mover = (o.moverColor ?? this.currentTurn) as Color;
      const passSide = mover === Color.BLACK ? "black" : "white";
      this.passCounts[passSide] += 1;
      this._showToast(tpl("passed", t(mover === Color.BLACK ? "mover.black" : "mover.white")), 1500);
    }

    if (o.passed || !o.placed || o.placed.row < 0) {
      this.lastMove = null;
    } else {
      this.lastMove = { row: o.placed.row, col: o.placed.col };
    }

    if (!o.undid) {
      // 兵力计数已由服务器净计数统一下发（见 _onGameUpdate 顶部 stonesPlaced）
      // 特种部署提示
      if (o.special) {
        this._showToast(t("special.deployed"), 2000);
      }
      // 落子/布局落子脉冲特效
      if (!o.passed && o.placed && o.placed.row >= 0) {
        const isDeploy = o.ply !== undefined ? o.ply <= DEPLOY_PHASE_MOVES : this.currentPly <= DEPLOY_PHASE_MOVES;
        if (isDeploy) this.boardCanvas.playDeployPlace(o.placed, o.moverColor as Color);
        else this.boardCanvas.playMove(o.placed, o.moverColor as Color);
      }
      // 提子特效（上升渐大淡出 + 震波扩散）
      if (o.captures && o.captures.length > 0) {
        const capturedColor =
          o.moverColor === Color.BLACK ? Color.WHITE : Color.BLACK;
        this.boardCanvas.playCapture(o.captures, capturedColor);
      }
      // 围空/围困变化特效
      this._triggerBoardStateEffects(prevEncs, prevSieged);
      this._appendLogEntry(o, p.scores);
    }

    this._refresh(p.scores);

    // 布局→正式对局过渡：播放开局动画
    const wasDeploy = o.ply !== undefined ? o.ply <= DEPLOY_PHASE_MOVES : false;
    if (wasDeploy && this.currentPly >= DEPLOY_PHASE_MOVES) {
      this.boardCanvas.setDeployPhase(false);
      this.boardCanvas.playOpeningAnimation();
      this._showToast(t("battleStart"), 2000);
    }
  }

  private _siegedSet(groups: Group[]): Set<number> {
    const s = new Set<number>();
    for (const g of groups) {
      for (const st of g.stones) s.add(st.row * BOARD_SIZE + st.col);
    }
    return s;
  }

  // 对比围空/围困变化触发特效（参考原项目 GameScreen 逻辑）
  // 迷雾/特种视野下是否隐藏围空/围困（不上屏、不播特效、不参与对比）
  private _viewHidesRegions(): boolean {
    return this.fogEnabled || (this.specialForces && !this.fogEnabled);
  }

  private _triggerBoardStateEffects(prevEncs: Enclosure[], prevSieged: Set<number>): void {
    // 迷雾/特种视野下围空/围困特效不上屏，短路避免全盘 DFS
    if (this._viewHidesRegions()) return;
    const toPoints = (idxs: number[]) =>
      idxs.map((i) => ({ row: Math.floor(i / BOARD_SIZE), col: i % BOARD_SIZE }));
    const newEncs = TerritoryDetector.enclosures(this.board);
    for (const c of [Color.BLACK, Color.WHITE]) {
      const prevPts = new Set(
        prevEncs.filter((e) => e.color === c).flatMap((e) => e.points.map((p) => p.row * BOARD_SIZE + p.col))
      );
      const newPts = new Set(
        newEncs.filter((e) => e.color === c).flatMap((e) => e.points.map((p) => p.row * BOARD_SIZE + p.col))
      );
      const gained = [...newPts].filter((i) => !prevPts.has(i));
      const lost = [...prevPts].filter((i) => !newPts.has(i));
      if (gained.length > 0) this.boardCanvas.playTerritoryFormed(toPoints(gained), c);
      if (lost.length > 0) this.boardCanvas.playTerritoryLost(toPoints(lost), c);
    }
    const newSieged = this._siegedSet(SiegeDetector.solveDeadAlive(this.board).sieged);
    const siegeGained = [...newSieged].filter((i) => !prevSieged.has(i));
    const siegeLost = [...prevSieged].filter((i) => !newSieged.has(i));
    if (siegeGained.length > 0) this.boardCanvas.playSiege(toPoints(siegeGained));
    if (siegeLost.length > 0) this.boardCanvas.playSiegeBroken(toPoints(siegeLost));
  }

  private _onGameOver(p: GameOverPayload): void {
    this.gameOver = true;
    // 对局结束：清除恢复档案，避免误判为可恢复
    this.client.disarmResume();
    this._clearDisconnectBanner();
    this._refresh(p.finalResult ? { black: p.finalResult.black, white: p.finalResult.white } : undefined);
    this._showResultModal(p.finalResult, p.reason);
  }

  private _onTimeUpdate(p: TimeUpdatePayload): void {
    this.timers = { black: p.black, white: p.white };
    // 用缓存的 scores 刷新计时条显示
    this._refresh(this.cachedScores ?? undefined);
  }

  // 断线重连/刷新恢复：用服务器全盘快照重建对局状态
  applyRecover(p: GameRecoverPayload): void {
    this.board = BoardModel.deserialize(p.initialState.size, p.initialState.grid);
    this.currentTurn = p.currentTurn as Color;
    if (this.currentTurn !== this.ownColor) this.specialMode = false;
    this.timers = { black: p.timers.black, white: p.timers.white };
    this.cachedScores = p.scores;
    this.stonesPlaced = { ...p.stonesPlaced };
    if (p.replenishTotal) this.replen = { ...p.replenishTotal };
    this.fogEnabled = p.fogEnabled;
    this.fogCells = p.fogCells ? new Set(p.fogCells) : new Set();
    this.specialForces = p.specialForces;
    if (p.specialUses) this.specialUses = p.specialUses;
    this.visibleSpecials = p.specials ? new Set(p.specials) : new Set();
    this.currentPly = p.ply;
    this.passCounts = { ...p.passCounts };
    this.lastMove = p.lastMove ?? null;
    this.gameOver = false;
    this.logEntries = [];
    // 布局→正式阶段还原
    this.boardCanvas.setDeployPhase(p.ply < DEPLOY_PHASE_MOVES);
    this._clearDisconnectBanner();
    this._refresh(p.scores);
    this._showToast(t("resumed"), 2000);
  }

  // 对手断线提示（等待窗口期间常驻顶部）
  private _showDisconnectBanner(msg: string): void {
    this.disconnectBannerEl.textContent = msg;
    this.disconnectBannerEl.hidden = false;
  }

  private _clearDisconnectBanner(): void {
    this.disconnectBannerEl.hidden = true;
    this.disconnectBannerEl.textContent = "";
  }

  private _appendLogEntry(o: MoveOutcome, scores: { black: ScoreSide; white: ScoreSide }): void {
    const moverColor = (o.moverColor ?? this.currentTurn) as number;
    const mySide = moverColor === Color.BLACK ? "black" : "white";
    const myScore = scores[mySide].total;
    const prevEntry = [...this.logEntries].reverse().find((e) => e.color === moverColor);
    const scoreBefore = prevEntry ? prevEntry.scoreAfter : 0;

    const action: ScoreLogEntry["action"] = o.passed ? "pass" : "move";
    this.logEntries.push({
      ply: o.ply ?? this.currentPly,
      color: moverColor,
      action,
      pos: o.placed && o.placed.row >= 0 ? o.placed : undefined,
      captures: o.captures?.length ?? 0,
      scoreBefore,
      scoreAfter: myScore,
    });
  }

  private _refresh(scores?: { black: ScoreSide; white: ScoreSide }): void {
    // 战争迷雾：服务端已按接收方视角过滤敌方隐藏棋子；本地隐藏围空/围困渲染避免信息泄露
    const fogActive = this.fogEnabled;
    // 特种部队模式（与迷雾互斥）：棋盘已由服务端过滤，同样隐藏围空/围困避免泄露隐子布置
    const specialView = this.specialForces && !fogActive;
    const enclosures = fogActive || specialView ? [] : TerritoryDetector.enclosures(this.board);
    const sieged = fogActive || specialView ? [] : SiegeDetector.solveDeadAlive(this.board).sieged;
    this.boardCanvas.updateState(
      this.board.grid,
      this.lastMove,
      enclosures,
      sieged,
      this.currentTurn,
      fogActive ? this.fogCells : undefined,
      fogActive,
      this.specialForces ? this.visibleSpecials : undefined,
      scores?.black.total,
      scores?.white.total
    );

    if (scores) {
      const isActive = (c: Color) => this.currentTurn === c && !this.gameOver;
      this._updatePanel(this.blackPanel, "black", scores.black.total, scores.black.breakdown, isActive(Color.BLACK), scores.white.total);
      this._updatePanel(this.whitePanel, "white", scores.white.total, scores.white.breakdown, isActive(Color.WHITE), scores.black.total);
      this.blackPanel.setLogEntries(this.logEntries);
      this.whitePanel.setLogEntries(this.logEntries);
    }

    // 兵力比例：统计棋盘 grid 上现存的黑白棋子数（所见即棋盘上实际棋子数）
    let bk = 0, wk = 0;
    const pg = this.board.grid;
    for (let i = 0; i < pg.length; i++) {
      if (pg[i] === Color.BLACK) bk++;
      else if (pg[i] === Color.WHITE) wk++;
    }
    if (this.gameOver) {
      this.statusEl.textContent = t("gameEnded");
      this.deployBannerEl.style.display = "none";
    } else if (this.currentPly < DEPLOY_PHASE_MOVES) {
      const mover = t(this.currentTurn === Color.BLACK ? "mover.black" : "mover.white");
      const left = DEPLOY_PHASE_MOVES - this.currentPly;
      const me = this.currentTurn === this.ownColor ? t("youMark") : "";
      const deploySec = this.timers[this.currentTurn === Color.BLACK ? "black" : "white"].main;
      this.statusEl.textContent = tpl("deployLeft", mover, left);
      this.deployBannerEl.style.display = "block";
      this.deployBannerEl.textContent = tpl("deployTurn", mover, me, deploySec);
    } else if (this.specialMode) {
      this.statusEl.textContent = t("special.armed");
      this.deployBannerEl.style.display = "none";
    } else {
      const mover = t(this.currentTurn === Color.BLACK ? "mover.black" : "mover.white");
      const side = this.currentTurn === Color.BLACK ? "black" : "white";
      const exhausted = this.pieceLimit - this.stonesPlaced[side] <= 0;
      // 与本地状态栏同格式：棋子用尽→虚手不限；否则"X方落子 · 黑a : 白b · 虚手 n"
      this.statusEl.textContent = exhausted
        ? tpl("turnExhausted", mover)
        : tpl("turn", mover, bk, wk, PASS_LIMIT_PER_GAME - this.passCounts[side]);
      this.deployBannerEl.style.display = "none";
    }

    this.passBtn.disabled = !this._isMyTurn();
    this.resignBtn.disabled = this.gameOver;
    // 特种按钮：启用规则才显示
    this.specialBtn.hidden = !this.specialForces;
    if (this.specialForces) {
      const myKey = this.ownColor === Color.BLACK ? "black" : "white";
      const left = SPECIAL_MAX_USES - (this.specialUses[myKey] ?? 0);
      this.specialBtn.disabled = !this._isMyTurn();
      this.specialBtn.classList.toggle("btn-active", this.specialMode);
      this.specialBtn.textContent = this.specialMode
        ? `${t("special.cancel")} (${left})`
        : `${t("special.toggle")} (${left})`;
    }
  }

  private _updatePanel(panel: ScorePanel, side: "black" | "white", total: number, b: ScoreBreakdown, isActive: boolean, opponentTotal: number): void {
    const tsp = this.timers[side];
    panel.update({
      breakdown: b,
      total,
      opponentTotal,
      isActive,
      timerSec: tsp.main,
      timerMax: this.timerMax,
      inByoyomi: tsp.inByoyomi,
      byoRemaining: tsp.byoRemaining,
      byoCur: tsp.byoCur,
      isLowTime: tsp.main <= 10 && isActive,
      gameOver: this.gameOver,
      piecesLeft: Math.max(0, this.pieceLimit - this.stonesPlaced[side]),
      pieceLimit: this.pieceLimit,
      replenish: this.replen[side],
      roleName: side === "black" ? this.blackName : this.whiteName,
    });
  }

  // 终局原因本地化（engine 原因中文，英文环境映射已知值）
  private _localizeReason(r: string): string {
    if (r.includes("认输")) return tpl("reason.resign", t(r.includes("黑") ? "black" : "white"));
    if (r.includes("兵力用尽")) return t("reason.piecesExhausted");
    if (r.includes("均无法落子")) return t("reason.bothStuck");
    if (r.includes("超时")) return t("timeoutLoss");
    if (r.includes("虚手")) return t("passEnd");
    if (r.includes("结束")) return t("gameEnded");
    return r;
  }

  private _showResultModal(result: FinalResult, reason: string): void {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    const winnerClass = result.winnerColor === Color.BLACK ? "black-win" : "white-win";
    const winnerName = result.winnerColor === Color.BLACK ? t("black") : t("white");
    const iWon = result.winnerColor === this.ownColor;
    modal.innerHTML = `
      <div class="modal result-modal">
        <h2>${t("result.title")}</h2>
        <div class="winner ${winnerClass}">${tpl("win", winnerName)}${iWon ? t("youWin") : ""}</div>
        <div class="reason">${this._escape(this._localizeReason(reason))}</div>
        <table class="result-table">
          <thead>
            <tr><th>${t("result.item")}</th><th>${t("black")}</th><th>${t("white")}</th></tr>
          </thead>
          <tbody>
            <tr><td class="label">${t("result.territory")}</td><td>${result.black.breakdown.occupationTerritory}</td><td>${result.white.breakdown.occupationTerritory}</td></tr>
            <tr><td class="label">${t("result.annihilate")}</td><td>${result.black.breakdown.defenseAnnihilate}</td><td>${result.white.breakdown.defenseAnnihilate}</td></tr>
            <tr><td class="label">${t("result.siege")}</td><td>${result.black.breakdown.defenseSiege}</td><td>${result.white.breakdown.defenseSiege}</td></tr>
            <tr><td class="label">${t("result.casualty")}</td><td>${result.black.breakdown.casualtyLoss + result.black.breakdown.casualtySpecial}</td><td>${result.white.breakdown.casualtyLoss + result.white.breakdown.casualtySpecial}</td></tr>
            <tr><td class="label">${t("result.komi")}</td><td>-${result.black.komi}</td><td>0</td></tr>
            <tr><td class="label">${t("finalScore")}</td><td class="final">${result.black.final}</td><td class="final">${result.white.final}</td></tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn btn-primary" id="modal-lobby">${t("backLobbyBtn")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector("#modal-lobby")!.addEventListener("click", () => {
      modal.remove();
      window.location.reload();
    });
  }

  private _showToast(msg: string, duration: number = 2000): void {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  private _escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}
