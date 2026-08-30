// Socket.io 客户端封装：连接服务器、发送事件、接收事件
// M2/M3 在线对战用，M1 本地对战不需要

import { io, type Socket } from "socket.io-client";
import {
  ClientEvent, ServerEvent,
  type LobbyUpdatePayload, type MatchFoundPayload,
  type GameStartPayload, type GameUpdatePayload,
  type GameOverPayload, type TimeUpdatePayload,
  type ErrorPayload, type GameConfig, type Ledger,
  type GameRecoverPayload, type OpponentStatusPayload,
  type PlayerColor,
} from "@warhorn/shared";

// 断线重连/刷新页恢复的本地档案键
const RESUME_KEY = "warhorn:resume";

// 本局已启动时的对局档案（用于断线/刷新后发起恢复）
export interface ResumeContext {
  roomId: string;
  name: string;
  color: PlayerColor;
  start: GameStartPayload; // 开局信息：刷新页后据此重建棋盘界面
}

// 天梯排名（与 server `/api/leaderboard` 返回结构对应）
export interface LeaderboardRow {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  rating: number;
  updatedAt: number;
  rank: number;
}
export interface LeaderboardPayload {
  top: LeaderboardRow[];
  me: LeaderboardRow | null;
}

export class SocketClient {
  private socket: Socket | null = null;
  private serverUrl: string;
  // 待恢复的对局档案（断线/刷新后自动发起 RESUME_GAME）；对局结束或离开时清空
  private resumeCtx: ResumeContext | null = null;
  // 最近一次加入大厅的昵称/令牌（重连后重新入厅 + 请求恢复）
  private joinInfo: { name: string; token?: string } | null = null;

  // 事件回调
  onLobbyUpdate?: (payload: LobbyUpdatePayload) => void;
  onMatchFound?: (payload: MatchFoundPayload) => void;
  onMatchCancelled?: () => void;
  onGameStart?: (payload: GameStartPayload) => void;
  onGameUpdate?: (payload: GameUpdatePayload) => void;
  onGameOver?: (payload: GameOverPayload) => void;
  onTimeUpdate?: (payload: TimeUpdatePayload) => void;
  onError?: (payload: ErrorPayload) => void;
  onDisconnect?: () => void;
  onLedgerUpdate?: (ledger: Ledger) => void; // 天梯全链广播
  onGameRecover?: (payload: GameRecoverPayload) => void; // 断线重连/刷新恢复：全盘快照
  onOpponentDisconnected?: (payload: OpponentStatusPayload) => void; // 对手断线（等待窗口）
  onGameResumed?: (payload: OpponentStatusPayload) => void; // 对手已重连

  constructor(serverUrl?: string) {
    // 联机服务器默认同源：开发时由 Vite 代理 /socket.io 到:3000，
    // 生产(Zeabur单服务托管)时静态与 socket.io 同域，直接连当前来源。
    this.serverUrl =
      serverUrl ??
      import.meta.env.VITE_SERVER_URL ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.serverUrl, {
        transports: ["websocket"],
        timeout: 5000,
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
      });
      // 事件只绑定一次；断线重连后监听器仍在，仅需重新入厅+恢复对局
      this._bindEvents();

      let first = true;
      this.socket.on("connect", () => {
        // 断线/刷新恢复：重新加入大厅，并请求恢复残留对局
        if (this.resumeCtx) {
          if (this.joinInfo) this.joinLobby(this.joinInfo.name, this.joinInfo.token);
          this.socket?.emit(ClientEvent.RESUME_GAME, {
            roomId: this.resumeCtx.roomId,
            name: this.resumeCtx.name,
            color: this.resumeCtx.color,
          });
        }
        if (first) {
          first = false;
          resolve();
        }
      });

      this.socket.on("connect_error", (err: Error) => {
        if (first) {
          first = false;
          reject(err);
        }
      });

      this.socket.on("disconnect", () => {
        this.onDisconnect?.();
      });
    });
  }

  // 调用 `armResume` 后：后续断线/刷新会自动请求恢复对局。
  // 同时写入 localStorage，支持刷新页面后恢复。
  // emitNow=true 用于刷新页恢复场景：连接已就绪、立即发起一次恢复。
  armResume(ctx: ResumeContext, emitNow = false): void {
    this.resumeCtx = ctx;
    this.resumeCtx.start = { ...ctx.start };
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(ctx));
    } catch {
      /* 忽略存储失败（隐私模式等），不影响本次会话内重连 */
    }
    if (emitNow && this.socket?.connected) {
      if (this.joinInfo) this.joinLobby(this.joinInfo.name, this.joinInfo.token);
      this.socket.emit(ClientEvent.RESUME_GAME, {
        roomId: ctx.roomId,
        name: ctx.name,
        color: ctx.color,
      });
    }
  }

  // 对局结束/离开时清除恢复档案
  disarmResume(): void {
    this.resumeCtx = null;
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      /* ignore */
    }
  }

  // 读取本地残留的恢复档案（刷新页恢复入口判定用）
  static readStoredResume(): ResumeContext | null {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const ctx = JSON.parse(raw) as ResumeContext;
      if (!ctx?.roomId || !ctx?.name || !ctx?.start) return null;
      return ctx;
    } catch {
      return null;
    }
  }

  getSocketId(): string {
    return this.socket?.id ?? "";
  }

  // 当前加入大厅的昵称（重连/刷新恢复时用于身份校验）
  getJoinedName(): string {
    return this.joinInfo?.name ?? "";
  }

  private _bindEvents(): void {
    if (!this.socket) return;

    this.socket.on(ServerEvent.LOBBY_UPDATE, (p: LobbyUpdatePayload) => this.onLobbyUpdate?.(p));
    this.socket.on(ServerEvent.MATCH_FOUND, (p: MatchFoundPayload) => this.onMatchFound?.(p));
    this.socket.on(ServerEvent.MATCH_CANCELLED, () => this.onMatchCancelled?.());
    this.socket.on(ServerEvent.GAME_START, (p: GameStartPayload) => this.onGameStart?.(p));
    this.socket.on(ServerEvent.GAME_UPDATE, (p: GameUpdatePayload) => this.onGameUpdate?.(p));
    this.socket.on(ServerEvent.GAME_OVER, (p: GameOverPayload) => this.onGameOver?.(p));
    this.socket.on(ServerEvent.TIME_UPDATE, (p: TimeUpdatePayload) => this.onTimeUpdate?.(p));
    this.socket.on(ServerEvent.ERROR, (p: ErrorPayload) => this.onError?.(p));
    this.socket.on(ServerEvent.LEDGER_UPDATE, (l: Ledger) => this.onLedgerUpdate?.(l));
    this.socket.on(ServerEvent.GAME_RECOVER, (p: GameRecoverPayload) => this.onGameRecover?.(p));
    this.socket.on(ServerEvent.OPPONENT_DISCONNECTED, (p: OpponentStatusPayload) => this.onOpponentDisconnected?.(p));
    this.socket.on(ServerEvent.GAME_RESUMED, (p: OpponentStatusPayload) => this.onGameResumed?.(p));
  }

  joinLobby(name: string, token?: string): void {
    this.joinInfo = { name, token };
    this.socket?.emit(ClientEvent.LOBBY_JOIN, { name, token });
  }

  // 获取服务器当前生效的游戏设置（大厅展示用，走 HTTP，不依赖 socket 连接）
  async fetchConfig(): Promise<GameConfig> {
    const res = await fetch(`${this.serverUrl}/api/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as GameConfig;
  }

  // 获取天梯排名（Top 列表 + 我的名次；走 HTTP）
  async fetchLeaderboard(limit = 10, name = ""): Promise<LeaderboardPayload> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (name) q.set("name", name);
    const res = await fetch(`${this.serverUrl}/api/leaderboard?${q.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as LeaderboardPayload;
  }

  // 拉取天梯全链（本地冗余存档 + 验签用）
  async fetchLedger(): Promise<{ ledger: Ledger | null }> {
    const res = await fetch(`${this.serverUrl}/api/leaderboard/ledger`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { ledger: Ledger | null };
  }

  // 上报本地账本，触发服务器多数仲裁恢复
  async recoverLedger(ledger: Ledger): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.serverUrl}/api/leaderboard/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledger }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean };
  }

  requestMatch(fog: boolean = false, special: boolean = false): void {
    this.socket?.emit(ClientEvent.MATCH_REQUEST, { fog, special });
  }

  cancelMatch(): void {
    this.socket?.emit(ClientEvent.MATCH_CANCEL);
  }

  confirmMatch(): void {
    this.socket?.emit(ClientEvent.MATCH_CONFIRM);
  }

  declineMatch(): void {
    this.socket?.emit(ClientEvent.MATCH_DECLINE);
  }

  startPractice(): void {
    this.socket?.emit(ClientEvent.PRACTICE_START);
  }

  endPractice(): void {
    this.socket?.emit(ClientEvent.PRACTICE_END);
  }

  placeMove(row: number, col: number): void {
    this.socket?.emit(ClientEvent.MOVE_PLACE, { row, col });
  }

  placeSpecial(row: number, col: number): void {
    this.socket?.emit(ClientEvent.MOVE_SPECIAL, { row, col });
  }

  pass(): void {
    this.socket?.emit(ClientEvent.MOVE_PASS);
  }

  resign(): void {
    this.socket?.emit(ClientEvent.RESIGN);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
