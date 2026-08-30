// 正式账户本地冗余备份（IndexedDB）
// 注册/登录成功后客户端把自身账户(邮箱+昵称+密码哈希)存一份到本地浏览器。
// 服务器 accounts.json 丢失时，玩家可凭本地备份调 /api/auth/recover 重新登记，实现防丢失。
// 与天梯账本不同，账户属隐私不在全网广播；仅本机备份。可按邮箱多账户共存。

import type { AccountRecord } from "@warhorn/shared";

const DB_NAME = "warhorn-accounts";
const STORE = "accounts";
const KEY_PATH = "email"; // 以邮箱为主键，一邮箱一账户

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: KEY_PATH });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存/更新某邮箱的账户备份 */
export async function saveAccountLocal(account: AccountRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...account, savedAt: Date.now() });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** 读某邮箱的账户备份（无则 null） */
export async function loadAccountLocal(
  email: string
): Promise<AccountRecord | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(email);
    req.onsuccess = () => {
      const row = req.result as (AccountRecord & { savedAt?: number }) | undefined;
      db.close();
      resolve(
        row && row.passHash
          ? { email: row.email, name: row.name, passHash: row.passHash, createdAt: row.createdAt }
          : null
      );
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

/** 读所有本地账户备份（用于“恢复/列出”场景） */
export async function loadAllAccountsLocal(): Promise<AccountRecord[]> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as Array<AccountRecord & { savedAt?: number }>) ?? [];
      db.close();
      resolve(
        rows
          .filter((r) => r && r.email && r.name && r.passHash)
          .map((r) => ({ email: r.email, name: r.name, passHash: r.passHash, createdAt: r.createdAt }))
      );
    };
    req.onerror = () => {
      db.close();
      resolve([]);
    };
  });
}