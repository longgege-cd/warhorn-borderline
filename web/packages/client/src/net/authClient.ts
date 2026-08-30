// 账户系统 HTTP 客户端：注册 / 登录 / 恢复
// 成功后返回会话（昵称+token+账户记录），调用方负责把 account 存 IndexedDB 备份。

import type { AccountRecord } from "@warhorn/shared";
import { saveAccountLocal } from "./accountsBank.js";

export interface AuthSession {
  name: string;
  token: string;
  account: AccountRecord;
}

export interface AuthError {
  error: string;
  code?: string;
}

const serverUrl =
  import.meta.env.VITE_SERVER_URL ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 先读文本再尝试解析，避免空/非 JSON 体时抛晦涩的 “Unexpected end of JSON input”
  const text = await res.text();
  let json: T | AuthError | undefined;
  try {
    json = text ? (JSON.parse(text) as T | AuthError) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = json as AuthError | undefined;
    throw new Error(err?.error || `请求失败（${res.status}）`);
  }
  if (!json) {
    throw new Error("服务器返回异常，请稍后重试");
  }
  return json as T;
}

// 解析会话并把账户写入本地备份后返回
async function finish(session: AuthSession): Promise<AuthSession> {
  try {
    await saveAccountLocal(session.account); // 本地备份（防丢失）
  } catch (err) {
    console.warn("[auth] 本地账户备份失败", err);
  }
  return session;
}

export async function register(
  email: string,
  password: string,
  nickname: string
): Promise<AuthSession> {
  return finish(
    await post<AuthSession>("/api/auth/register", { email, password, name: nickname })
  );
}

export async function login(
  email: string,
  password: string
): Promise<AuthSession> {
  return finish(await post<AuthSession>("/api/auth/login", { email, password }));
}

export async function recover(account: AccountRecord): Promise<AuthSession> {
  return finish(await post<AuthSession>("/api/auth/recover", { account }));
}