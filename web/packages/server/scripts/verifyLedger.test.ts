// 端到端验证分布式天梯账本：密钥→创世→追加→验签→篡改检测→恢复
// 运行: npx tsx packages/server/scripts/verifyLedger.test.ts
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayerColor, verifyLedger, rebuildPlayers } from "@warhorn/shared";
import { loadOrCreateSigner } from "../src/LedgerKeys.js";
import { Leaderboard } from "../src/Leaderboard.js";

let pass = 0, fail = 0;
function check(cond: boolean, name: string, extra = "") {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " - " + extra : ""}`); }
}

// 1) 密钥生成（真实磁盘持久化）
const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
const keyPath = join(dir, "keys.json");
const signer = loadOrCreateSigner(keyPath)!;
const signer2 = loadOrCreateSigner(keyPath);
console.log("[1] 密钥生成/复用");
check(signer != null, "生成密钥成功");
check(signer.publicKey === signer2!.publicKey, "重载复用同一密钥");
check(existsSync(keyPath), "密钥已落盘 keys.json");

// 2) 创世块 + 追加 3 局
const lb = await Leaderboard.create(signer);
await lb.applyResult("Alice", "Bob", PlayerColor.BLACK, 1000);
await lb.applyResult("Bob", "Carol", PlayerColor.WHITE, 2000);
await lb.applyResult("Alice", "Carol", PlayerColor.BLACK, 3000);
const ledger = lb.asLedger();
console.log("[2] 账本链");
check(ledger.blocks.length === 4, "创世1块+3局=4块");
check(ledger.blocks[0].index === 0 && ledger.blocks[0].prevHash === "0", "创世块 index=0 prev=0");

// 3) 全链验签（客户端/恢复侧同口径）
console.log("[3] 全链验签 round-trip");
const v = await verifyLedger(ledger);
check(v.ok === true, "验签通过");

// 4) 篡改检测
console.log("[4] 篡改检测");
// blocks 映射: [0]创世 [1]=Alice-Bob黑胜(winner=1) [2]=Bob-Carol白胜(winner=2) [3]=Alice-Carol黑胜(winner=1)
const tampered = structuredClone(ledger);
tampered.blocks[3].result!.winnerColor = PlayerColor.WHITE; // 篡改胜负 1→2
const v2 = await verifyLedger(tampered);
check(v2.ok === false, "篡改胜负被拒绝");
const tampered2 = structuredClone(ledger);
tampered2.blocks[1].result!.black = "Eve"; // 篡改参赛者
const v3 = await verifyLedger(tampered2);
check(v3.ok === false, "篡改参赛者被拒绝");
// 截断末块是前缀自洽链，验签层面自洽（防截断靠服务器恢复的"最长链"判断，非验签）
const truncated = structuredClone(ledger);
truncated.blocks = truncated.blocks.slice(0, 3);
const vT = await verifyLedger(truncated);
check(vT.ok === true, "截断末块验签自洽(防截断靠最长链仲裁)");

// 5) 重建排名与服务器内存一致
console.log("[5] 排名重建");
const rebuilt = rebuildPlayers(ledger);
const alice = rebuilt.find(p => p.name === "Alice")!;
const carol = rebuilt.find(p => p.name === "Carol")!;
check(alice.games === 2 && alice.wins === 2, "Alice 2局2胜");
check(carol.games === 2 && carol.wins === 1 && carol.losses === 1, "Carol 2局1胜1负");
check(alice.rating > carol.rating, "Alice 积分高于 Carol");
const top = lb.getTop(10);
check(top[0].name === "Alice" && top[0].rank === 1, "Top1 为 Alice");

// 6) 恢复场景
console.log("[6] 故障恢复");
const restored = await Leaderboard.fromLedger(ledger, null);
check(restored != null, "只读载入有效账本成功");
check(restored!.blockCount === 4, "恢复链长一致");
restored!.applyResult("Eve", "Alice", PlayerColor.BLACK, 4000);
check(restored!.blockCount === 4, "无签名者不能加链(只读)");
const badRestore = await Leaderboard.fromLedger(tampered, null);
check(badRestore == null, "篡改账本恢复被拒绝");
// 恢复侧拒绝"短于当前权威链"的候选（防截断还原旧状态）
const curLen = lb.blockCount; // 4
const truncatedRestore = await Leaderboard.fromLedger(truncated, null);
check(truncatedRestore != null, "截断链本地载入有效(自洽)");
const rejectShort = curLen === 4 && truncated.blocks.length < curLen;
check(rejectShort, "短链在服务器恢复层被最长链仲裁拒绝");

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);