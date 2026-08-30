// 天梯分类账的密码学原语（纯 WebCrypto，Node 与浏览器通用）
// 提供：SHA-256 哈希、RSA-PKCS1 验签、整链完整性校验。
// 服务器用 node:crypto 生成/签名，本模块只负责"验证"，供服务器恢复方与客户端共用同一套校验。

import type { Ledger, LedgerBlock, LedgerPlayer } from "./index.js";

/** 区块被签名的内容 = index|timestamp|prevHash|payload，需与服务器签名侧严格一致 */
function blockData(b: Pick<LedgerBlock, "index" | "timestamp" | "prevHash" | "result" | "players">): Uint8Array {
  const payload = JSON.stringify(b.result ?? b.players ?? null);
  return new TextEncoder().encode(`${b.index}|${b.timestamp}|${b.prevHash}|${payload}`);
}

/** SHA-256 → hex */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  // Node(>=20) 与浏览器都有全局 WebCrypto；用 any 规避两端 lib 差异
  const subtle = (globalThis as unknown as { crypto: { subtle: any } }).crypto.subtle;
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** 计算出区块应有的 hash（供加链/校验） */
export async function computeBlockHash(b: LedgerBlock): Promise<string> {
  return sha256Hex(blockData(b));
}

// PEM 边界处理：从 SPKI PEM 提取 base64 DER
function b64FromPem(pem: string): string {
  return pem.replace(/-----[A-Z ]*-----/g, "").replace(/\s+/g, "");
}

/** base64 → bytes（两端通用，避免依赖 Buffer/atob 差异） */
function fromBase64(b64: string): Uint8Array {
  const g = globalThis as unknown as { atob: (s: string) => string };
  if (typeof g.atob === "function") {
    const bin = g.atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  // Node 兜底（无 atob 的旧环境）
  const { Buffer } = globalThis as any; // eslint-disable-line
  return new Uint8Array((Buffer as any).from(b64, "base64"));
}

/** 导入 RSA 公钥（PKCS1 v1.5 验签） */
async function importPublicKey(pubPem: string): Promise<unknown> {
  const subtle = (globalThis as unknown as { crypto: { subtle: any } }).crypto.subtle;
  const der = fromBase64(b64FromPem(pubPem));
  return subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/** 用服务器公钥验签单个区块的 hash */
export async function verifyBlockSignature(pubPem: string, b: LedgerBlock): Promise<boolean> {
  try {
    const subtle = (globalThis as unknown as { crypto: { subtle: any } }).crypto.subtle;
    const key = await importPublicKey(pubPem);
    const sig = fromBase64(b.signature);
    // 与服务器签名侧 sign("RSA-SHA256", Buffer.from(hash, "utf8")) 严格一致：
    // 被哈希的原始数据 = hash 字符串的 UTF-8 字节（而非 hex 解码后的 digest）。
    const hashBytes = new Uint8Array(new TextEncoder().encode(b.hash));
    return await subtle.verify("RSASSA-PKCS1-v1_5", key, sig, hashBytes);
  } catch {
    return false;
  }
}

export interface LedgerValidation {
  ok: boolean; // 是否整链有效
  reason?: string; // 失败原因
  tip?: string; // 指向无效区块的索引
}

/**
 * 整链校验：哈希链连续性 + 每个区块验签。
 * 任一中间被篡改都会导致 prevHash 断裂或签名失效。
 */
export async function verifyLedger(ledger: Ledger): Promise<LedgerValidation> {
  if (!ledger || !Array.isArray(ledger.blocks) || ledger.blocks.length === 0) {
    return { ok: false, reason: "空账本" };
  }
  let prev = "0"; // 创世块 prevHash 必须为 "0"
  for (const b of ledger.blocks) {
    if (b.prevHash !== prev) {
      return { ok: false, reason: "哈希链断裂", tip: String(b.index) };
    }
    const computed = await computeBlockHash(b);
    if (computed !== b.hash) {
      return { ok: false, reason: "区块数据被篡改", tip: String(b.index) };
    }
    if (!(await verifyBlockSignature(ledger.publicKey, b))) {
      return { ok: false, reason: "服务器签名无效", tip: String(b.index) };
    }
    prev = b.hash;
  }
  return { ok: true };
}

/** 从分类账重建当前玩家排名快照（创世全量 + 逐块重放 result） */
export function rebuildPlayers(ledger: Ledger): LedgerPlayer[] {
  if (!ledger?.blocks?.length) return [];
  const players = new Map<string, LedgerPlayer>();
  for (const b of ledger.blocks) {
    if (b.index === 0 && b.players) {
      for (const p of b.players) players.set(p.name, { ...p });
      continue;
    }
    if (!b.result) continue;
    applyElo(players, b.result.black, b.result.white, b.result.winnerColor, b.timestamp);
  }
  return [...players.values()];
}

/** 对单局应用 Elo 更新（创建方块/得分保持与服务器 applyResult 一致） */
function applyElo(
  players: Map<string, LedgerPlayer>,
  black: string,
  white: string,
  winnerColor: number,
  now: number
): void {
  const K = 32;
  const START = 1200;
  const a = entry(players, black, now, START);
  const b = entry(players, white, now, START);
  const ea = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
  const eb = 1 - ea;
  let sa: number;
  if (winnerColor === 1) { sa = 1; a.wins++; b.losses++; }
  else if (winnerColor === 2) { sa = 0; a.losses++; b.wins++; }
  else { sa = 0.5; a.draws++; b.draws++; }
  a.rating = Math.round(a.rating + K * (sa - ea));
  b.rating = Math.round(b.rating + K * ((1 - sa) - eb));
  a.games++; b.games++;
  a.updatedAt = now;
  b.updatedAt = now;
}

function entry(m: Map<string, LedgerPlayer>, name: string, now: number, start: number): LedgerPlayer {
  let e = m.get(name);
  if (!e) {
    e = { name, wins: 0, losses: 0, draws: 0, games: 0, rating: start, updatedAt: now };
    m.set(name, e);
  }
  return e;
}