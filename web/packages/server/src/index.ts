// 服务器入口：Express + Socket.io 初始化、CORS、监听 3000 端口
// 事件路由：lobby:join / match:* / practice:* / move:* / resign / disconnect
//
// 架构：
//   - Lobby：玩家在线状态
//   - MatchQueue：匹配配对与确认
//   - Map<roomId, GameRoom>：活跃对局
// 组件间通过回调解耦，避免循环依赖

// 支持 .env 文件配置：加载 packages/server/.env（显式路径，与运行目录无关）
// dotenv 默认不覆盖已存在的环境变量 → 真实环境变量优先级高于 .env 文件
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

// 服务版本：读取 server 自身 package.json，避免硬编码（首页据此核对部署是否最新）
const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

import express from "express";
import http from "node:http";
import cors from "cors";
import { Server } from "socket.io";
import { Color } from "@warhorn/engine";
import {
  ClientEvent,
  ServerEvent,
  PlayerColor,
  type IdentityKind,
  type PlayerStatus,
  type AccountRecord,
  type FinalResult,
  type Ledger,
  verifyLedger,
  rebuildPlayers,
} from "@warhorn/shared";
import { Lobby } from "./Lobby.js";
import { MatchQueue, type WaitingEntry } from "./MatchQueue.js";
import { GameRoom } from "./GameRoom.js";
import { Store, GAME_RECORD_LIMIT, type SavedState, type GameMetrics } from "./Store.js";
import { AuthManager } from "./Auth.js";
import { Leaderboard } from "./Leaderboard.js";
import { loadOrCreateSigner } from "./LedgerKeys.js";
import { loadConfig } from "./Config.js";
import { computeStats } from "./Stats.js";

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const MAX_NAME_LENGTH = 20;

// 运行配置（可调平衡参数，环境变量覆盖，见 Config.ts）
const config = loadConfig();
console.log(
  `[config] komi=${config.komi} pieceLimit=${config.pieceLimit} ` +
    `timer=${config.timerBaseSec}s+${config.timerIncrementSec}s deploy=${config.deployTimerSec}s`
);

// ====== HTTP 服务器 ======

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// 单服务部署：若存在前端构建产物（client/dist），由后端一并托管静态资源
// 开发环境（未构建前端）时 `/` 仍返回 JSON 服务信息。
const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
const indexHtml = resolve(clientDist, "index.html");

if (existsSync(indexHtml)) {
  app.use(express.static(clientDist));
  app.get("/", (_req, res) => res.sendFile(indexHtml));
  // SPA 回退：非 API 的 GET 请求统一返回 index.html（刷新页面不 404）
  app.use((req, res, next) => {
    if (
      req.method === "GET" &&
      !req.path.startsWith("/api") &&
      !req.path.startsWith("/admin") &&
      !req.path.startsWith("/socket.io")
    ) {
      return res.sendFile(indexHtml);
    }
    next();
  });
} else {
  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "warhorn-server", version: SERVER_VERSION });
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 版本接口：前端首页据此显示并核对所部署版本是否最新
app.get("/api/version", (_req, res) => {
  res.json({ ok: true, version: SERVER_VERSION });
});

// 平衡调参统计接口：对 games.json 做聚合分析
// 可选鉴权：设置了 WARHORN_ADMIN_TOKEN 时需携带 x-admin-token 请求头
app.get("/admin/stats", (req, res) => {
  if (config.adminToken && req.get("x-admin-token") !== config.adminToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json(computeStats(store.loadGames()));
});

// 游戏设置接口：大厅展示当前生效的平衡参数（不含 adminToken）
app.get("/api/config", (_req, res) => {
  res.json({
    komi: config.komi,
    pieceLimit: config.pieceLimit,
    timerBaseSec: config.timerBaseSec,
    timerIncrementSec: config.timerIncrementSec,
    byoPeriodSec: config.byoPeriodSec,
    byoCount: config.byoCount,
    deployTimerSec: config.deployTimerSec,
  });
});

// 对局回放列表：返回最近 N 局的战绩元数据（不含棋谱，减小体积）
// 用法: GET /api/games?limit=10
app.get("/api/games", (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(Math.min(limitRaw, 50)) : 10;
  const games = store.loadGames();
  const meta = games.slice(-limit).reverse().map(({ moves: _moves, ...rest }) => rest);
  res.json({ games: meta });
});

// 单局回放详情：返回完整对局记录（含逐手棋谱 moves）
app.get("/api/games/:id", (req, res) => {
  const game = store.loadGames().find((g) => g.id === req.params.id);
  if (!game) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ game });
});

// 天梯接口：返回 Elo 排名 Top N 与指定玩家的名次
// 用法: /api/leaderboard?limit=10&name=X
// 天梯降级（待恢复）时返回空列表
app.get("/api/leaderboard", (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!leaderboard) {
    res.json({ top: [], me: null, degraded: true });
    return;
  }
  res.json({
    top: leaderboard.getTop(limit),
    me: leaderboard.get(name),
  });
});

// 天梯全链接口：客户端拉取用于本地冗余存档 + 验签
// 用法: GET /api/leaderboard/ledger → { ledger: Ledger | null }
app.get("/api/leaderboard/ledger", (_req, res) => {
  res.json({ ledger: leaderboard ? leaderboard.asLedger() : null });
});

// 天梯恢复接口：玩家上报本地账本，服务器做多数仲裁（最长有效链）采纳
// 用法: POST /api/leaderboard/recover  body: { ledger: Ledger }
// 仅在服务器"待恢复"或候选链更长时采纳；校验失败一律拒绝。
app.post("/api/leaderboard/recover", async (req, res) => {
  const candidate = (req.body as { ledger?: Ledger })?.ledger;
  if (!candidate || !Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    res.status(400).json({ error: "empty ledger" });
    return;
  }
  const v = await verifyLedger(candidate);
  if (!v.ok) {
    res.status(400).json({ error: `invalid ledger: ${v.reason}` });
    return;
  }
  // 公钥必须与服务器当前签名密钥匹配，才能在恢复后继续为新区块签名
  if (signer && candidate.publicKey !== signer.publicKey) {
    res.status(400).json({ error: "public key mismatch" });
    return;
  }
  // 多数仲裁：只有待恢复，或候选链比当前严格更长时，才采纳为权威
  const curLen = leaderboard?.blockCount ?? 0;
  if (!(awaitingRecovery || candidate.blocks.length > curLen)) {
    res.status(200).json({ ok: false, reason: "not longer than current" });
    return;
  }
  const restored = await Leaderboard.fromLedger(candidate, signer);
  if (!restored) {
    res.status(400).json({ error: "invalid ledger chain" });
    return;
  }
  leaderboard = restored;
  awaitingRecovery = false;
  store.saveLedger(leaderboard.asLedger());
  // 广播恢复后的全链，让其余在线玩家校正本地副本
  io.emit(ServerEvent.LEDGER_UPDATE, leaderboard.asLedger());
  console.warn(
    `[ledger] 已从玩家上报恢复账本：${restored.blockCount} 块（多数仲裁取最长有效链）`
  );
  res.json({ ok: true, blocks: restored.blockCount });
});

// async 路由包装：把 rejected promise 交给 express 错误中间件（避免原生 500 空响应体）
type AsyncHandler = (
  req: Parameters<express.RequestHandler>[0],
  res: Parameters<express.RequestHandler>[1]
) => void | Promise<void>;
const asyncHandler = (fn: AsyncHandler): express.RequestHandler => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

const httpServer = http.createServer(app);

// ====== 账户系统 HTTP 接口 ======
// 注册：校验邮箱格式/昵称唯一/邮箱唯一 → 签发会话 token
app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };
  const emailStr = typeof body.email === "string" ? body.email : "";
  const passStr = typeof body.password === "string" ? body.password : "";
  const nameStr = typeof body.name === "string" ? body.name : "";
  const r = await auth.register(emailStr, passStr, nameStr);
  if (!r.ok) {
    res.status(400).json({ ok: false, error: r.error, code: r.code });
    return;
  }
  res.json({ ok: true, name: r.data!.name, token: r.data!.token, account: r.data!.account });
}));

// 登录：校验密码 → 签发会话 token
app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const emailStr = typeof body.email === "string" ? body.email : "";
  const passStr = typeof body.password === "string" ? body.password : "";
  const r = await auth.login(emailStr, passStr);
  if (!r.ok) {
    res.status(400).json({ ok: false, error: r.error, code: r.code });
    return;
  }
  res.json({ ok: true, name: r.data!.name, token: r.data!.token, account: r.data!.account });
}));

// 恢复：玩家凭本地备份重新登记（防服务器数据丢失）。校验通过后签发 token。
app.post("/api/auth/recover", asyncHandler(async (req, res) => {
  const acc = (req.body ?? {}) as { account?: unknown };
  const r = await auth.recover(acc.account as AccountRecord);
  if (!r.ok) {
    res.status(400).json({ ok: false, error: r.error, code: r.code });
    return;
  }
  res.json({ ok: true, name: r.data!.name, token: r.data!.token, account: r.data!.account });
}));

// ====== Socket.io 服务器 ======

const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

// ====== 核心组件 ======

const lobby = new Lobby(io);
const rooms = new Map<string, GameRoom>();
const store = new Store();
// 账户系统：集中存储 accounts.json + 客户端本地备份（防丢失）。
// 正式身份凭会话 token 判定 kind=user；无 token/无效 → guest（不入天梯）。
const auth = new AuthManager(store);
console.log(`[auth] 正式账户: ${auth.count} 个`);
// ====== 天梯分类账（哈希链 + 服务器RSA签名，分布式冗余防丢/防篡改）======
// 签名密钥落 data/keys.json，账本链落 data/ledger.json。
// 服务器账本丢失时从玩家本地账本（POST /api/leaderboard/recover）多数取回。
const signer = loadOrCreateSigner();
const storedLedger = store.loadLedger();
// 正常：有密钥 + 有效账本且公钥匹配 → 续链运行
// 迁移：有密钥但无账本 → 明确空账本创世（新天梯）
// 待恢复：无密钥，或账本公钥与密钥不符 → 置 null，等待玩家上报恢复
let leaderboard: Leaderboard | null = null;
let awaitingRecovery = false;
if (signer) {
  if (storedLedger && storedLedger.publicKey === signer.publicKey) {
    leaderboard = await Leaderboard.fromLedger(storedLedger, signer);
  }
  if (!leaderboard) {
    // 迁移：旧 leaderboard.json 玩家作为创世快照并入，避免历史排名丢失
    leaderboard = await Leaderboard.create(signer, store.loadLeaderboard() ?? []);
    store.saveLedger(leaderboard.asLedger());
  }
} else {
  awaitingRecovery = true;
  console.warn(
    "[ledger] 签名密钥缺失，天梯进入待恢复状态。等待在线玩家上报本地账本…"
  );
}
if (leaderboard) {
  console.log(
    `[ledger] 天梯账本就绪：${leaderboard.blockCount} 块（${leaderboard.getTop(5).length} 名玩家）`
  );
}

// ====== 持久化 ======

// 收集当前活跃状态（结构摘要，不含棋盘/落子历史 → 文件有界）
function collectState(): SavedState {
  return {
    savedAt: Date.now(),
    players: lobby.getPlayersSnapshot(),
    queue: matchQueue.getQueueSnapshot().map((e) => e.socketId),
    pending: matchQueue.getPendingSnapshot(),
    rooms: [...rooms.values()].map((r) => ({
      id: r.roomId,
      blackId: r.blackInfo.socketId,
      blackName: r.blackInfo.name,
      whiteId: r.whiteInfo.socketId,
      whiteName: r.whiteInfo.name,
      ended: r.ended,
    })),
  };
}

// 调度活跃状态落盘（防抖合并，500ms 内多次变化只写一次）
function persist(): void {
  store.scheduleStateSave(collectState());
}

// 对局结束：清理房间 + 双方回大厅 + 记录战绩（含平衡采集）
async function handleGameOver(
  roomId: string,
  playerSocketIds: string[],
  result: FinalResult,
  metrics: GameMetrics
): Promise<void> {
  const room = rooms.get(roomId);
  let blackName = "";
  let whiteName = "";
  let blackKind: IdentityKind = "guest";
  let whiteKind: IdentityKind = "guest";
  if (room) {
    blackName = room.blackInfo.name;
    whiteName = room.whiteInfo.name;
    blackKind = room.blackInfo.kind;
    whiteKind = room.whiteInfo.kind;
    room.cleanup();
    rooms.delete(roomId);
  }
  // 记录对局战绩 + 平衡指标（固定上限，防膨胀）
  store.appendGame({
    id: roomId,
    black: blackName,
    white: whiteName,
    winner: result.winner,
    winnerColor: result.winnerColor,
    reason: result.reason,
    ply: result.ply,
    finalBlack: result.black.final,
    finalWhite: result.white.final,
    endedAt: Date.now(),
    // 参数快照（本局实际使用的规则参数）
    komi: config.komi,
    pieceLimit: config.pieceLimit,
    timerBaseSec: config.timerBaseSec,
    timerIncrementSec: config.timerIncrementSec,
    // 终局采集指标
    endCategory: metrics.endCategory,
    durationSec: metrics.durationSec,
    scoreDiff: metrics.scoreDiff,
    stonesBlack: metrics.stonesBlack,
    stonesWhite: metrics.stonesWhite,
    passBlack: metrics.passBlack,
    passWhite: metrics.passWhite,
    captureBlack: metrics.captureBlack,
    captureWhite: metrics.captureWhite,
    breakdownBlack: metrics.breakdownBlack,
    breakdownWhite: metrics.breakdownWhite,
    moves: metrics.moves,
    fogEnabled: metrics.fogEnabled,
    specialForces: metrics.specialForces,
  });
  for (const sid of playerSocketIds) {
    lobby.setStatus(sid, "lobby");
  }
  // 更新天梯分类账（每局一个签名块）并持久化 + 广播全链给所有在线玩家。
  // 仅双方均为正式身份(user)计入天梯；任一方为 guest（临时身份）不记账。
  try {
    if (leaderboard && blackKind === "user" && whiteKind === "user") {
      await leaderboard.applyResult(blackName, whiteName, result.winnerColor, Date.now());
      store.saveLedger(leaderboard.asLedger());
      io.emit(ServerEvent.LEDGER_UPDATE, leaderboard.asLedger());
    }
  } catch (err) {
    console.warn("[ledger] 追加区块失败", err instanceof Error ? err.message : err);
  }
  lobby.broadcastUpdate();
  persist();
}

const matchQueue = new MatchQueue(io, {
  // 双方确认 → 创建游戏房间（黑白由 MatchQueue 随机分配）
  createRoom: (
    a: WaitingEntry,
    b: WaitingEntry,
    colorA: PlayerColor,
    _colorB: PlayerColor,
    roomId: string,
    fogEnabled: boolean,
    specialForces: boolean
  ) => {
    const black = colorA === PlayerColor.BLACK ? a : b;
    const white = colorA === PlayerColor.BLACK ? b : a;
    const room = new GameRoom(
      roomId,
      io,
      { onGameOver: handleGameOver },
      { socketId: black.socketId, name: black.name, kind: black.kind },
      { socketId: white.socketId, name: white.name, kind: white.kind },
      // 参数快照：使用当前服务器配置（公测可调）+ 本局双方同意的迷雾开关
      {
        komi: config.komi,
        pieceLimit: config.pieceLimit,
        timerBaseSec: config.timerBaseSec,
        timerIncrementSec: config.timerIncrementSec,
        byoPeriodSec: config.byoPeriodSec,
        byoCount: config.byoCount,
        deployTimerSec: config.deployTimerSec,
        fogEnabled,
        specialForces,
      }
    );
    rooms.set(roomId, room);
    lobby.setStatus(black.socketId, "playing", roomId);
    lobby.setStatus(white.socketId, "playing", roomId);
    room.start();
    persist();
  },
  setPlayerStatus: (socketId: string, status: PlayerStatus) => {
    lobby.setStatus(socketId, status);
    lobby.broadcastUpdate();
    persist();
  },
});

// 根据 socketId 查找其所在房间
function findRoomBySocket(socketId: string): GameRoom | undefined {
  for (const room of rooms.values()) {
    if (room.hasSocket(socketId)) return room;
  }
  return undefined;
}

function emitError(socketId: string, message: string, code?: string): void {
  io.to(socketId).emit(ServerEvent.ERROR, { message, code });
}

// ====== 事件路由 ======

io.on("connection", (socket) => {
  // 身份加入大厅：
  //   - 正式身份:payload { name, token } → 服务器验 token，命中则为 user（名称以账户为准，可入天梯）
  //   - 临时身份:payload "{name}" 或 { name }（无 token）→ guest，免密直玩（不入天梯）
  socket.on(ClientEvent.LOBBY_JOIN, (payload: unknown) => {
    const rawName =
      typeof payload === "string"
        ? payload
        : typeof payload === "object" && payload !== null &&
          typeof (payload as { name?: unknown }).name === "string"
          ? (payload as { name: string }).name
          : "";
    const token =
      typeof payload === "object" && payload !== null
        ? (payload as { token?: unknown }).token
        : undefined;
    let name = rawName.trim();
    let kind: IdentityKind = "guest";
    // 服务器验 token 判定正式身份（名称以服务器账户为准，防伪造昵称仿冒正式用户）
    const formalName = auth.verifyToken(token);
    if (formalName !== null) {
      kind = "user";
      name = formalName;
    }
    if (!name) {
      emitError(socket.id, "名字不能为空");
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      emitError(socket.id, `名字过长（最多 ${MAX_NAME_LENGTH} 字）`);
      return;
    }
    if (lobby.getPlayer(socket.id)) {
      // 已在大厅，仅更新名字与身份
      const p = lobby.getPlayer(socket.id)!;
      p.name = name;
      p.kind = kind;
      return;
    }
    lobby.addPlayer(socket.id, name, kind);
    persist();
  });

  socket.on(ClientEvent.MATCH_REQUEST, (payload: unknown) => {
    const player = lobby.getPlayer(socket.id);
    if (!player) {
      emitError(socket.id, "请先加入大厅");
      return;
    }
    if (player.status !== "lobby") {
      emitError(socket.id, "当前状态无法匹配");
      return;
    }
    // 可选：战争迷雾偏好（payload 兼容 { fog: boolean } 或空）
    const fog =
      typeof payload === "object" &&
      payload !== null &&
      (payload as { fog?: unknown }).fog === true;
    // 可选：特种部队偏好（payload 兼容 { special: boolean }，与迷雾互斥）
    const special =
      typeof payload === "object" &&
      payload !== null &&
      (payload as { special?: unknown }).special === true;
    lobby.setStatus(socket.id, "matching");
    matchQueue.enqueue(socket.id, player.name, player.kind, fog, special);
    lobby.broadcastUpdate();
    persist();
  });

  socket.on(ClientEvent.MATCH_CONFIRM, () => {
    matchQueue.confirm(socket.id);
  });

  socket.on(ClientEvent.MATCH_CANCEL, () => {
    matchQueue.cancel(socket.id);
    lobby.broadcastUpdate();
    persist();
  });

  socket.on(ClientEvent.MATCH_DECLINE, () => {
    matchQueue.decline(socket.id);
  });

  // 练习模式：本地棋盘，服务器仅更新状态
  socket.on(ClientEvent.PRACTICE_START, () => {
    const player = lobby.getPlayer(socket.id);
    if (!player || player.status !== "lobby") {
      emitError(socket.id, "当前状态无法进入练习");
      return;
    }
    lobby.setStatus(socket.id, "practice");
    lobby.broadcastUpdate();
    persist();
  });

  socket.on(ClientEvent.PRACTICE_END, () => {
    const player = lobby.getPlayer(socket.id);
    if (!player || player.status !== "practice") return;
    lobby.setStatus(socket.id, "lobby");
    lobby.broadcastUpdate();
    persist();
  });

  // 落子（权威引擎验证）
  socket.on(ClientEvent.MOVE_PLACE, (data: unknown) => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      emitError(socket.id, "未在对局中");
      return;
    }
    if (
      data === null ||
      typeof data !== "object" ||
      typeof (data as { row?: unknown }).row !== "number" ||
      typeof (data as { col?: unknown }).col !== "number"
    ) {
      emitError(socket.id, "非法落子参数");
      return;
    }
    const { row, col } = data as { row: number; col: number };
    room.handlePlace(socket.id, row, col);
  });

  // 特种部队部署
  socket.on(ClientEvent.MOVE_SPECIAL, (data: unknown) => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      emitError(socket.id, "未在对局中");
      return;
    }
    if (
      data === null ||
      typeof data !== "object" ||
      typeof (data as { row?: unknown }).row !== "number" ||
      typeof (data as { col?: unknown }).col !== "number"
    ) {
      emitError(socket.id, "非法部署参数");
      return;
    }
    const { row, col } = data as { row: number; col: number };
    room.handleSpecial(socket.id, row, col);
  });

  // 虚手
  socket.on(ClientEvent.MOVE_PASS, () => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      emitError(socket.id, "未在对局中");
      return;
    }
    room.handlePass(socket.id);
  });

  // 认输
  socket.on(ClientEvent.RESIGN, () => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      emitError(socket.id, "未在对局中");
      return;
    }
    room.handleResign(socket.id);
  });

  // 断线重连/刷新页恢复：校验身份后改绑 socket 并下发全盘快照
  socket.on(ClientEvent.RESUME_GAME, (payload: unknown) => {
    const raw =
      payload !== null && typeof payload === "object"
        ? (payload as { roomId?: unknown; name?: unknown; color?: unknown })
        : {};
    if (
      typeof raw.roomId !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.color !== "number"
    ) {
      emitError(socket.id, "非法重连参数");
      return;
    }
    const room = rooms.get(raw.roomId);
    if (!room || room.ended) {
      emitError(socket.id, "对局已结束，无法重连");
      return;
    }
    const color = raw.color as number;
    if (!room.matchPlayer(raw.name, color as Color)) {
      emitError(socket.id, "身份校验失败");
      return;
    }
    // 重连后上线：重新登记大厅玩家记录（保留原名），标记为对局中
    if (!lobby.getPlayer(socket.id)) {
      lobby.addPlayer(socket.id, raw.name, "guest");
    }
    const rec = lobby.getPlayer(socket.id);
    if (rec) rec.name = raw.name;
    lobby.setStatus(socket.id, "playing", room.roomId);
    if (!room.resumeGame(color as Color, socket.id)) {
      emitError(socket.id, "对局已结束，无法重连");
      return;
    }
    lobby.broadcastUpdate();
    persist();
  });

  // 断线：匹配中断 + 对局进入重连等待窗口（超时未重连才判负）
  socket.on("disconnect", () => {
    // 1. 先从大厅移除（避免 onGameOver 把断线方误设为 lobby 造成状态闪烁）
    lobby.removePlayer(socket.id);
    // 2. 取消匹配中/队列中的位置（对方作为受害者重新入队）
    matchQueue.handleDisconnect(socket.id);
    // 3. 若在对局中 → 进入重连等待窗口（房间保留，计时暂停）
    const room = findRoomBySocket(socket.id);
    if (room) {
      room.handleDisconnect(socket.id);
    }
    persist();
  });
});

// ====== 启动 ======

// 启动时审计上次持久化状态（socket 会话已失效，不做恢复，仅记录）
const saved = store.loadState();
if (saved) {
  console.log(
    `[store] 上次状态: ${saved.players.length} 玩家, ${saved.pending.length} 等待确认, ${saved.rooms.length} 房间 (保存于 ${new Date(saved.savedAt).toLocaleString()})`
  );
}
const gameCount = store.loadGames().length;
if (gameCount > 0) {
  console.log(`[store] 已有对局记录: ${gameCount} 局（上限 ${GAME_RECORD_LIMIT} 局）`);
}

// 优雅退出：立即落盘未写入的活跃状态
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[warhorn-server] 收到 ${sig}，保存状态并退出`);
    store.flushStateSync();
    process.exit(0);
  });
}

// 统一 JSON 错误响应：放在所有路由之后，捕获 json 解析失败 & 未捕获同步/异步异常，
// 保证任何错误都返回可读 JSON，而非空或 HTML body（客户端 fetch 解析为 “Unexpected end of JSON input”）
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    const status =
      (err as { statusCode?: number })?.statusCode ??
      (err as { status?: number })?.status ??
      500;
    console.error("[api] 未捕获错误:", err instanceof Error ? err.stack : err);
    res.status(typeof status === "number" && status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: status === 400 ? "请求格式不正确" : "服务器内部错误，请稍后重试",
    });
  }
);

httpServer.listen(PORT, () => {
  console.log(`[warhorn-server] listening on http://localhost:${PORT}`);
});

export { app, io };
