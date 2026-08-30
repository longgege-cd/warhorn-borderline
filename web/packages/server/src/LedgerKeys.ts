// 分类账签名密钥：RSA-2048 密钥对，持久化到 data/keys.json。
// 私钥必须持久化：重启后需同一私钥才能继续对新区块签名、使旧链验签一致。
// 若 data/keys.json 丢失（服务器数据丢失场景），将进入"待恢复"状态，从玩家本地账本恢复。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@warhorn/shared";
import type { LedgerBlock } from "@warhorn/shared";

interface KeyPairFile {
  publicKey: string; // PEM (SPKI)
  privateKey: string; // PEM (PKCS8)
}

export interface Signer {
  publicKey: string;
  privateKey: string;
  /** 对区块内容计算 hash 并用私钥签名，返回 { hash, signature } */
  signBlock(
    b: Pick<LedgerBlock, "index" | "timestamp" | "prevHash" | "result" | "players">
  ): Promise<{ hash: string; signature: string }>;
}

/** 区块被签名内容 = index|timestamp|prevHash|payload（与 shared/ledger.ts blockData 严格一致） */
function blockData(b: Pick<LedgerBlock, "index" | "timestamp" | "prevHash" | "result" | "players">): Uint8Array {
  const payload = JSON.stringify(b.result ?? b.players ?? null);
  return new TextEncoder().encode(`${b.index}|${b.timestamp}|${b.prevHash}|${payload}`);
}

const defaultKeyPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "data", "keys.json");

/** 加载或生成并持久化 RSA 密钥对。返回 signer；data/keys.json 缺失时返回 null（待恢复）。 */
export function loadOrCreateSigner(keyPath: string = defaultKeyPath()): Signer | null {
  let keys: KeyPairFile;
  if (existsSync(keyPath)) {
    try {
      keys = JSON.parse(readFileSync(keyPath, "utf8")) as KeyPairFile;
    } catch {
      // 密钥文件损坏 → 视为丢失，走待恢复路径
      return null;
    }
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    keys = { publicKey, privateKey };
    try {
      writeFileSync(keyPath, JSON.stringify(keys, null, 2), "utf8");
    } catch (err) {
      console.warn("[ledger] 写密钥失败（RSA 每次重启会变，旧账本需恢复）", err);
    }
  }

  // 校验密钥对格式可用
  try {
    createPublicKey(keys.publicKey);
    createPrivateKey(keys.privateKey);
  } catch {
    return null;
  }

  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    async signBlock(b) {
      const data = blockData(b);
      const hash = await sha256Hex(data);
      const sig = sign("RSA-SHA256", Buffer.from(hash, "utf8"), keys.privateKey);
      return { hash, signature: sig.toString("base64") };
    },
  };
}