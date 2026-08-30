// 共享类型：WebSocket 协议消息、玩家/房间数据结构
// 前后端共用，避免类型漂移

export type PlayerStatus = "lobby" | "matching" | "practice" | "playing";

// 身份类型：guest=临时身份（免密直玩，不入天梯）；user=正式身份（注册邮箱+昵称，计入天梯）
export type IdentityKind = "guest" | "user";

// 正式账户记录（服务器 accounts.json 与客户端本地备份共用）
// passHash 采用 scrypt，格式 "<salt_hex>.<hash_hex>"，自含盐可独立校验与恢复
export interface AccountRecord {
  email: string;
  name: string; // 正式昵称（唯一）
  passHash: string;
  createdAt: number;
}

export interface Player {
  id: string; // Socket.id
  name: string; // 展示名（临时昵称或正式昵称）
  status: PlayerStatus;
  kind: IdentityKind; // 身份类型：user 才计入天梯
  roomId?: string;
}

export type RoomStatus = "confirming" | "deployment" | "battle" | "ended";

export interface GameRoom {
  id: string;
  black: Player;
  white: Player;
  boardState: SerializedBoard;
  currentTurn: PlayerColor;
  timers: { black: number; white: number };
  moveCount: number;
  status: RoomStatus;
  confirmations: { black: boolean; white: boolean };
}

// 颜色常量（与 engine 一致，独立定义避免循环依赖）
export const PlayerColor = {
  EMPTY: 0,
  BLACK: 1,
  WHITE: 2,
} as const;
export type PlayerColor = (typeof PlayerColor)[keyof typeof PlayerColor];

// 逐手棋谱记录（对局回放/存档）
// kind: p=正常落子, v=虚手, s=特种部队部署, e=遭遇战弹子
export interface MoveRecord {
  c: PlayerColor; // 行棋方
  k: "p" | "v" | "s" | "e";
  r: number; // 落点行（虚手为 -1）
  col: number; // 落点列（虚手为 -1）
}

// 序列化棋盘（用于网络传输）
export interface SerializedBoard {
  size: number;
  grid: number[]; // 长度 size*size，值 = PlayerColor
}

// 落子结果
export interface MoveOutcome {
  ok: boolean;
  reason?: string;
  moverColor: PlayerColor;
  placed?: { row: number; col: number }; // 虚手时为 {row:-1,col:-1}
  passed?: boolean;
  captures?: Array<{ row: number; col: number }>;
  capturedColor?: PlayerColor;
  ply?: number;
  gameOver?: boolean;
  result?: FinalResult;
  undid?: boolean; // 悔棋
  // 战争迷雾（可选规则）
  encounter?: boolean; // 遭遇战：本手落点被对方隐藏棋子占据，触发弹子/吞子
  revealed?: Array<{ row: number; col: number }>; // 遭遇战/黎明现形的对方隐藏棋子
  dawn?: boolean; // 本手后第30手黎明，迷雾消散
  // 特种部队（可选规则）
  special?: boolean; // 本手为特种部队部署
  specialDeployAt?: { row: number; col: number }; // 部署位置（仅部署方可见，在线分视角下发）
}

// 分数明细
export interface ScoreBreakdown {
  occupationLive: number; // 遗留字段（v7.3 已取消活子分，恒为0）
  occupationTerritory: number; // 占领分：圈内空点+2/点，被围困棋子+1/子
  occupationEfficiency: number; // 效率奖励 2×(⌊有效围空点数/4⌋)
  defenseAnnihilate: number; // 歼灭分 +3/子（己方领土/边境）
  defenseSiege: number; // 围困分 +2/子（己方领土/边境）
  siegeReward: number; // 围困奖励 2×⌊被围困组群棋子数/3⌋，每个被围困组群独立计算
  casualtyLoss: number; // 普通战损 -1/子（负值）
  casualtySpecial: number; // 特种战损 -6/子（负值，MVP不用）
  specialReward: number; // 特种部队成功奖励（参与围困/围空→占领分总额+50%，终局一次性）
}

export interface ScoreSide {
  breakdown: ScoreBreakdown;
  total: number;
  komi: number;
  final: number;
}

export interface FinalResult {
  black: ScoreSide;
  white: ScoreSide;
  winner: string;
  winnerColor: PlayerColor;
  reason: string;
  ply: number;
}

// ====== WebSocket 事件类型 ======
export const ClientEvent = {
  LOBBY_JOIN: "lobby:join",
  MATCH_REQUEST: "match:request",
  MATCH_CANCEL: "match:cancel", // 匹配等待中主动取消匹配
  MATCH_CONFIRM: "match:confirm",
  MATCH_DECLINE: "match:decline",
  PRACTICE_START: "practice:start",
  PRACTICE_END: "practice:end",
  MOVE_PLACE: "move:place",
  MOVE_SPECIAL: "move:special", // 特种部队部署（可选规则）
  MOVE_PASS: "move:pass",
  RESIGN: "resign",
  RESUME_GAME: "game:resume", // 断线重连/刷新页恢复：携带 roomId+name+color
} as const;

export const ServerEvent = {
  LOBBY_UPDATE: "lobby:update",
  MATCH_FOUND: "match:found",
  MATCH_CANCELLED: "match:cancelled",
  GAME_START: "game:start",
  GAME_UPDATE: "game:update",
  GAME_OVER: "game:over",
  TIME_UPDATE: "time:update",
  ERROR: "error",
  LEDGER_UPDATE: "ledger:update", // 天梯分类账全链广播（分布式冗余）
  // 断线重连
  GAME_RECOVER: "game:recover", // 服务器向重连方推送当前全盘快照
  OPPONENT_DISCONNECTED: "game:opponent_disconnected", // 对手断线（进入等待窗口）
  GAME_RESUMED: "game:resumed", // 对手已重连
} as const;

export type ClientEventType = (typeof ClientEvent)[keyof typeof ClientEvent];
export type ServerEventType = (typeof ServerEvent)[keyof typeof ServerEvent];

// 服务器推送的负载
export interface LobbyUpdatePayload {
  onlineCount: number;
  matchingCount: number;
}

export interface MatchFoundPayload {
  roomId: string;
  opponentName: string;
  ownColor: PlayerColor;
  confirmTimeoutSec: number;
  fogEnabled: boolean; // 本局是否启用战争迷雾（双方都勾选时为 true）
  specialForces: boolean; // 本局是否启用特种部队（与迷雾互斥）
}

export interface GameStartPayload {
  roomId: string;
  blackName: string;
  whiteName: string;
  ownColor: PlayerColor;
  initialState: SerializedBoard;
  baseTimeSec: number;
  incrementSec: number; // 已弃用：读秒制裁去每手加时（恒为 0，兼容）
  byoPeriodSec: number; // 每次读秒秒数
  byoCount: number; // 读秒次数
  komi: number; // 本局贴目（黑方扣减）
  pieceLimit: number; // 本局每方兵力上限
  fogEnabled: boolean; // 本局是否启用战争迷雾（可选规则）
  specialForces: boolean; // 本局是否启用特种部队（可选规则，与迷雾互斥）
}

// 读秒制计时快照（围棋比赛：主时 + 读秒N次）
export interface ColorTimer {
  main: number; // 剩余主时间（秒）
  inByoyomi: boolean; // 是否在读秒
  byoRemaining: number; // 剩余读秒次数
  byoCur: number; // 当前读秒剩余（秒）
}

export type TimersState = { black: ColorTimer; white: ColorTimer };

export interface GameUpdatePayload {
  outcome: MoveOutcome;
  board: SerializedBoard; // 已按接收方视角过滤敌方隐藏棋子（迷雾下）
  currentTurn: PlayerColor;
  timers: TimersState;
  scores: { black: ScoreSide; white: ScoreSide };
  stonesPlaced: { black: number; white: number }; // 双方已用兵力（剩余 = pieceLimit - stonesPlaced）
  stonesOnBoard: { black: number; white: number }; // 当前棋盘上的子数（含特种隐子）
  replenishTotal: { black: number; white: number }; // 双方累计吃子补充兵力
  fogEnabled?: boolean; // 迷雾对局时下发（后续 updates）
  fogCells?: number[]; // 本方向迷雾覆盖的交叉点索引（迷雾下）
  // 特种部队（可选规则，分视角下发）
  specialForces?: boolean;
  specialUses?: { black: number; white: number }; // 双方已发动次数（每局上限2）
  specialOwn?: number[]; // 接收方自己的未暴露隐子索引（供己方高亮渲染）
  specials?: number[]; // 接收方视角可见的特种子索引（己方未现形 + 双方已现形；不含对方未现形隐子）
}

// 断线重连：客户端请求恢复对局
export interface ResumePayload {
  roomId: string;
  name: string; // 请求方自己昵称（与房间记录比对，身份校验）
  color: PlayerColor; // 请求方本局执色
}

// 服务器向重连方推送的当前全盘恢复快照（= 开局信息 + 实时对局状态）
export interface GameRecoverPayload extends GameStartPayload {
  currentTurn: PlayerColor;
  timers: TimersState;
  scores: { black: ScoreSide; white: ScoreSide };
  stonesPlaced: { black: number; white: number };
  stonesOnBoard: { black: number; white: number };
  replenishTotal: { black: number; white: number };
  ply: number; // 已行棋手数（用于布局/正式阶段判定）
  passCounts: { black: number; white: number }; // 双方累计虚手数
  lastMove?: { row: number; col: number }; // 最后一手落点（高亮，虚手为无）
  fogCells?: number[]; // 迷雾对局时：本方向迷雾覆盖区
  specialUses?: { black: number; white: number };
  specialOwn?: number[];
  specials?: number[];
}

// 对手断线 / 重连通知（携带对方执色）
export interface OpponentStatusPayload {
  color: PlayerColor;
}

export interface TimeUpdatePayload {
  black: ColorTimer;
  white: ColorTimer;
}

export interface GameOverPayload {
  winner: PlayerColor;
  reason: string;
  finalResult: FinalResult;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

// ====== 天梯分类账（哈希链 + 服务器RSA签名，分布式冗余防丢/防篡改）======
// 创世块(index=0)携带全量玩家快照 players；后续每块记录一局 result。
// 每块 hash = SHA256(index|timestamp|prevHash|payload)；服务器私钥签 hash；prevHash 串成链。
// 任何中间篡改都会使后续块的 prevHash 不匹配或某块验签失败 → 被拒。

/** 一局结果（分类账非创世块负载） */
export interface LedgerResult {
  black: string;
  white: string;
  winnerColor: PlayerColor;
}

/** 天梯玩家条目（与块内创世快照一致） */
export interface LedgerPlayer {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  rating: number; // Elo 积分
  updatedAt: number;
}

/** 分类账区块 */
export interface LedgerBlock {
  index: number;
  timestamp: number;
  prevHash: string; // 创世块为 "0"
  hash: string; // SHA-256 hex
  signature: string; // base64(RSA 私钥签 hash)
  result?: LedgerResult; // 非创世块负载
  players?: LedgerPlayer[]; // 创世块负载（全量快照）
}

/** 完整分类账（可独立自足，供验签与恢复） */
export interface Ledger {
  publicKey: string; // PEM（SPKI）
  blocks: LedgerBlock[];
}

/** 前端展示用的天梯排名行（含名次） */
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

// 服务器当前生效的游戏设置（大厅展示用，来自 GET /api/config）
export interface GameConfig {
  komi: number; // 贴目（黑方扣减）
  pieceLimit: number; // 每方兵力上限
  timerBaseSec: number; // 正式阶段基础时间（秒）
  timerIncrementSec: number; // 已弃用：读秒制裁去每手加时（恒为0）
  byoPeriodSec: number; // 每次读秒秒数
  byoCount: number; // 读秒次数
  deployTimerSec: number; // 布局阶段每方独立时间（秒）
}

// 分类账密码学原语（sha256 / 验签 / 整链校验 / 重建排名）
// 供服务器(client 端一样用)做验签与恢复；type-only 依赖避免循环。
export * from "./ledger.js";
