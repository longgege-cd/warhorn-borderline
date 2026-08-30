// 天梯分类账：以哈希链 + 服务器RSA签名存储整个积分历史。
// 每个区块不可篡改：创世块(index=0)携带全量玩家快照，后续每块记录一局结果。
// 排名始终由"创世快照 + 逐块重放"派生，保证与链一致；整链可分发、可验签、可恢复。
//
// 用法：
//   Leaderboard.create(signer, initialPlayers)          → 全新账本（创世）
//   Leaderboard.fromLedger(ledger, signer)              → 从持久化/远端账本载入（校验上下）
//   lb.applyResult(black, white, winnerColor, now)      → 追加一局（同步更新内存排名 + 追加签名块）
//   lb.asLedger()                                       → 全链（供广播/持久化）

import { PlayerColor } from "@warhorn/shared";
import { verifyLedger, rebuildPlayers } from "@warhorn/shared";
import type { Ledger, LedgerBlock, LedgerPlayer, LedgerResult } from "@warhorn/shared";
import type { Signer } from "./LedgerKeys.js";

const START_RATING = 1200;
const K = 32;
const GENESIS_PREV = "0";

/** 前端展示用排名行（名次 1 基） */
export interface RankedEntry {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  rating: number;
  updatedAt: number;
  rank: number;
}

export class Leaderboard {
  private blocks: LedgerBlock[];
  private players: Map<string, LedgerPlayer>;
  private readonly signer: Signer | null; // null = 只读（恢复/校验场景）

  /** 服务器公钥 */
  readonly publicKey: string;

  private constructor(signer: Signer | null, publicKey: string, blocks: LedgerBlock[]) {
    this.signer = signer;
    this.publicKey = publicKey;
    this.blocks = blocks;
    this.players = new Map(rebuildPlayers({ publicKey, blocks }).map((p) => [p.name, p]));
  }

  /** 全新账本：以初始玩家快照为创世块 */
  static async create(signer: Signer, initialPlayers: LedgerPlayer[] = []): Promise<Leaderboard> {
    const now = Date.now();
    const genesisInput = { index: 0, timestamp: now, prevHash: GENESIS_PREV, players: initialPlayers };
    const { hash, signature } = await signer.signBlock(genesisInput);
    const genesis: LedgerBlock = { ...genesisInput, hash, signature };
    return new Leaderboard(signer, signer.publicKey, [genesis]);
  }

  /** 从持久化/远端账本载入并校验。校验失败返回 null。signer 用于判断能否继续加链。 */
  static async fromLedger(ledger: Ledger, signer: Signer | null): Promise<Leaderboard | null> {
    const v = await verifyLedger(ledger);
    if (!v.ok) {
      console.warn(`[ledger] 账本校验失败: ${v.reason} (块 ${v.tip ?? "-"})`);
      return null;
    }
    return new Leaderboard(signer, ledger.publicKey, ledger.blocks);
  }

  /** 追加一局结果：更新内存排名 + 追加签名区块 */
  async applyResult(
    black: string,
    white: string,
    winnerColor: PlayerColor,
    now: number = Date.now()
  ): Promise<void> {
    if (!black || !white || black === white) return;
    // 1) 更新内存排名（与创世重放保持一致的 Elo 逻辑）
    this._applyElo(black, white, winnerColor, now);
    // 2) 追加区块（签名者缺失时仅内存更新，不落链）
    if (!this.signer) return;
    const prev = this.blocks[this.blocks.length - 1];
    const result: LedgerResult = { black, white, winnerColor };
    const input = { index: prev.index + 1, timestamp: now, prevHash: prev.hash, result };
    const { hash, signature } = await this.signer.signBlock(input);
    this.blocks.push({ ...input, hash, signature });
  }

  /** 取 Top N */
  getTop(limit: number): RankedEntry[] {
    const sorted = this._sorted();
    return sorted.slice(0, Math.max(1, limit)).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  /** 查询指定玩家名次（未上榜返回 null） */
  get(name: string): RankedEntry | null {
    if (!name) return null;
    const e = this.players.get(name);
    if (!e) return null;
    const rank = this._sorted().findIndex((p) => p.name === name);
    return { ...e, rank: rank + 1 };
  }

  /** 全链（广播/持久化用） */
  asLedger(): Ledger {
    return { publicKey: this.publicKey, blocks: this.blocks };
  }

  /** 链长（区块数） */
  get blockCount(): number {
    return this.blocks.length;
  }

  private _applyElo(black: string, white: string, winnerColor: PlayerColor, now: number): void {
    const a = this._entry(black, now);
    const b = this._entry(white, now);
    const ea = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
    const eb = 1 - ea;
    let sa: number;
    if (winnerColor === PlayerColor.BLACK) { sa = 1; a.wins++; b.losses++; }
    else if (winnerColor === PlayerColor.WHITE) { sa = 0; a.losses++; b.wins++; }
    else { sa = 0.5; a.draws++; b.draws++; }
    a.rating = Math.round(a.rating + K * (sa - ea));
    b.rating = Math.round(b.rating + K * ((1 - sa) - eb));
    a.games++; b.games++;
    a.updatedAt = now; b.updatedAt = now;
  }

  private _entry(name: string, now: number): LedgerPlayer {
    let e = this.players.get(name);
    if (!e) {
      e = { name, wins: 0, losses: 0, draws: 0, games: 0, rating: START_RATING, updatedAt: now };
      this.players.set(name, e);
    }
    return e;
  }

  private _sorted(): LedgerPlayer[] {
    return [...this.players.values()].sort(
      (x, y) => y.rating - x.rating || y.wins - x.wins || x.games - y.games
    );
  }
}