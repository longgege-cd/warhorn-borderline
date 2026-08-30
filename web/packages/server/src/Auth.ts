// 账户系统：临时身份(guest，免密直玩，不入天梯) + 正式身份(user，注册邮箱+昵称，计入天梯)
//
// 分布式存储防丢失策略（隐私优先，不做全网广播）：
//   - 服务器集中存储 accounts.json（权威唯一）
//   - 客户端注册/登录成功后把自身账户存 IndexedDB 备份
//   - 服务器数据丢失时，玩家凭本地备份调 POST /api/auth/recover 重新登记
// 因隐私考虑，账户不广播全网；密码不提供找回，忘记需重新注册。
//
// 密码：node:crypto scrypt，salt 随机、内嵌 hash，可独立校验与恢复。

import { randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AccountRecord } from "@warhorn/shared";
import type { Store } from "./Store.js";

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

const KEYLEN = 32;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_NICKNAME_LENGTH = 20;

export interface AuthResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string; // 客户端可据此触发本地恢复
}

// 会话结果：正式昵称 + 会话 token + 账户记录（供客户端本地备份，防丢失）
export interface AuthSession {
  name: string;
  token: string;
  account: AccountRecord;
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const buf = await scrypt(password, saltHex, KEYLEN);
  return `${saltHex}.${buf.toString("hex")}`;
}

async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(".");
  if (!saltHex || !hashHex) return false;
  const buf = await scrypt(password, saltHex, KEYLEN);
  const storedBuf = Buffer.from(hashHex, "hex");
  if (buf.length !== storedBuf.length) return false;
  return timingSafeEqual(buf, storedBuf);
}

export class AuthManager {
  private readonly _store: Store;
  // email -> account
  private readonly _byEmail: Map<string, AccountRecord> = new Map();
  // name -> email
  private readonly _byName: Map<string, string> = new Map();
  // sessionToken -> email
  private readonly _tokens: Map<string, string> = new Map();

  constructor(store: Store) {
    this._store = store;
    for (const acc of store.loadAccounts()) {
      this._byEmail.set(acc.email, acc);
      this._byName.set(acc.name, acc.email);
    }
  }

  get count(): number {
    return this._byEmail.size;
  }

  /** 注册：校验邮箱格式/昵称长度/邮箱与昵称不可重名 */
  async register(
    email: string,
    password: string,
    nickname: string
  ): Promise<AuthResult<AuthSession>> {
    const em = email.trim().toLowerCase();
    const nm = nickname.trim();
    if (!EMAIL_RE.test(em)) {
      return { ok: false, error: "邮箱格式不正确", code: "bad_email" };
    }
    if (!nm || nm.length > MAX_NICKNAME_LENGTH) {
      return { ok: false, error: `昵称需 1-${MAX_NICKNAME_LENGTH} 字`, code: "bad_name" };
    }
    if (password.length < 4) {
      return { ok: false, error: "密码至少 4 位", code: "bad_password" };
    }
    if (this._byEmail.has(em)) {
      return { ok: false, error: "该邮箱已注册，请直接登录", code: "email_taken" };
    }
    if (this._byName.has(nm)) {
      return { ok: false, error: "该昵称已被占用，请换一个", code: "name_taken" };
    }

    const salt = randomBytes(16).toString("hex");
    const passHash = await hashPassword(password, salt);
    const account: AccountRecord = {
      email: em,
      name: nm,
      passHash,
      createdAt: Date.now(),
    };
    this._byEmail.set(em, account);
    this._byName.set(nm, em);
    this._persist();
    const token = this._issueToken(em);
    return { ok: true, data: { name: nm, token, account } };
  }

  /** 登录：校验密码，成功签发会话令牌 */
  async login(
    email: string,
    password: string
  ): Promise<AuthResult<AuthSession>> {
    const em = email.trim().toLowerCase();
    const account = this._byEmail.get(em);
    if (!account) {
      return { ok: false, error: "账号不存在", code: "not_found" };
    }
    const ok = await verifyPassword(account.passHash, password);
    if (!ok) {
      return { ok: false, error: "密码不正确", code: "bad_password" };
    }
    const token = this._issueToken(em);
    return { ok: true, data: { name: account.name, token, account } };
  }

  /** 恢复：玩家本地备份重新登记（防服务器数据丢失）。仅在邮箱/昵称未被其他账户占用时采纳。 */
  async recover(
    account: AccountRecord
  ): Promise<AuthResult<AuthSession>> {
    const em = account.email.trim().toLowerCase();
    const nm = account.name.trim();
    if (!EMAIL_RE.test(em) || !nm) {
      return { ok: false, error: "账户信息无效", code: "bad_account" };
    }
    if (!account.passHash.includes(".")) {
      return { ok: false, error: "账户信息无效", code: "bad_account" };
    }
    const existing = this._byEmail.get(em);
    if (existing) {
      // 邮箱已存在：仅当密码哈希一致才视为本人（可继续登录），否则冲突
      if (existing.passHash !== account.passHash) {
        return { ok: false, error: "该邮箱已被占用", code: "email_taken" };
      }
    } else {
      const nameOwner = this._byName.get(nm);
      if (nameOwner && nameOwner !== em) {
        return { ok: false, error: "该昵称已被占用", code: "name_taken" };
      }
      this._byEmail.set(em, account);
      this._byName.set(nm, em);
      this._persist();
    }
    const token = this._issueToken(em);
    const finalAcc = this._byEmail.get(em)!;
    return { ok: true, data: { name: finalAcc.name, token, account: finalAcc } };
  }

  /** 校验会话令牌 → 返回正式账户昵称（无则 null，视为 guest） */
  verifyToken(token: unknown): string | null {
    if (typeof token !== "string" || !token) return null;
    const email = this._tokens.get(token);
    if (!email) return null;
    const acc = this._byEmail.get(email);
    return acc ? acc.name : null;
  }

  // ====== 内部 ======

  private _issueToken(email: string): string {
    const token = randomUUID() + randomUUID();
    this._tokens.set(token, email);
    return token;
  }

  private _persist(): void {
    this._store.saveAccounts([...this._byEmail.values()]);
  }
}