// 天梯账本本地冗余存档（IndexedDB）
// 服务器每次广播全链时，客户端持久化一份到本地浏览器存储。
// 服务器数据丢失时，玩家可凭这份本地副本（连同 full chain + 签名）上报恢复。
// 单个玩家篡改本地数据 → 验签/哈希断裂，拒绝采纳，实现防篡改。

import type { Ledger } from "@warhorn/shared";

const DB_NAME = "warhorn-ledger";
const STORE = "ledger";
const KEY = "main"; // 单键存最新全链

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存全链到本地（覆盖旧副本） */
export async function saveLedgerLocal(ledger: Ledger): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ledger, savedAt: Date.now() }, KEY);
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

/** 读本地全链副本（无则 null） */
export async function loadLedgerLocal(): Promise<Ledger | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const row = req.result as { ledger?: Ledger } | undefined;
      db.close();
      resolve(row?.ledger ?? null);
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}