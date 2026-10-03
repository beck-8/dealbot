#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getDataSetCall } from "@filoz/synapse-core/warm-storage";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadManifest } from "./common.mjs";
import { confirmTransaction, createSubmissionQueue, recoverTransactions } from "./journal.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    network: { type: "string" },
    "include-abandoned": { type: "boolean", default: false },
    concurrency: { type: "string", default: "1" },
    confirmations: { type: "string", default: "1" },
    execute: { type: "boolean", default: false },
    input: { type: "string", default: path.join(dir, "candidates.calibration.json") },
    state: { type: "string" },
    limit: { type: "string", default: "5" },
    "batch-size": { type: "string", default: "50" },
    "delay-ms": { type: "string", default: "1500" },
    "max-gas": { type: "string", default: "3000000000" },
    "wallet-address": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node cleanup.mjs [--limit 5] [--batch-size 50] [--delay-ms 1500] [--input JSON] [--state JSON] [--execute]\nDefault: read-only simulation and gas estimate. Execute: MANUAL_CLEANUP_PRIVATE_KEY required. Optional: MANUAL_CLEANUP_RPC_URL.",
  );
  process.exit(0);
}
function positive(value, name, min = 1) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name}`);
  return n;
}
const concurrency = positive(values.concurrency, "concurrency");
if (concurrency > 12) throw new Error("Maximum concurrency is 12");
const confirmations = positive(values.confirmations, "confirmations");
const limit = positive(values.limit, "limit");
const batchSize = positive(values["batch-size"], "batch-size");
const delay = positive(values["delay-ms"], "delay-ms", 0);
const maxGas = BigInt(positive(values["max-gas"], "max-gas"));
const manifest = loadManifest(values.input, values.network);
const { chain, network, payer, candidates } = manifest;
if (values.execute && network === "mainnet" && values.network !== "mainnet")
  throw new Error("Mainnet execution requires --network mainnet");
const manifestHash = keccak256(Buffer.from(JSON.stringify(manifest.legacy ? candidates : manifest.value)));
const key = process.env.MANUAL_CLEANUP_PRIVATE_KEY;
if (values.execute && !key) throw new Error("MANUAL_CLEANUP_PRIVATE_KEY is required for --execute");
const account = key ? privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`) : undefined;
delete process.env.MANUAL_CLEANUP_PRIVATE_KEY;
if (values["wallet-address"] && !/^0x[0-9a-fA-F]{40}$/.test(values["wallet-address"]))
  throw new Error("Invalid wallet address");
if (account && values["wallet-address"] && account.address.toLowerCase() !== values["wallet-address"].toLowerCase())
  throw new Error("Private key does not match wallet address");
const caller = account ?? values["wallet-address"] ?? "0x000000000000000000000000000000000000dEaD";
const transport = http(process.env.MANUAL_CLEANUP_RPC_URL ?? chain.rpcUrls.default.http[0], {
  timeout: 30000,
  retryCount: 0,
});
const client = createPublicClient({ chain, transport });
const wallet = account ? createWalletClient({ chain, transport, account }) : undefined;
const pdp = chain.contracts.pdp;
const pause = (ms = delay) => new Promise((r) => setTimeout(r, ms));
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x), 2);
function revertName(e) {
  return e?.walk?.((x) => x instanceof ContractFunctionRevertedError)?.data?.errorName;
}
function message(e) {
  return revertName(e) ?? e.shortMessage ?? e.message ?? e.name ?? "Unknown error";
}
let nextRpcAt = 0;
async function read(fn) {
  for (let i = 0; ; i++) {
    const slot = Math.max(Date.now(), nextRpcAt);
    nextRpcAt = slot + delay;
    await pause(Math.max(0, slot - Date.now()));
    try {
      return await fn();
    } catch (e) {
      if (revertName(e) || e.name === "TransactionReceiptNotFoundError" || i >= 4) throw e;
      console.log(`RPC retry ${i + 1}: ${message(e)}`);
      await pause(Math.min(30000, 2000 * 2 ** i));
    }
  }
}
if ((await read(() => client.getChainId())) !== chain.id) throw new Error("RPC network mismatch");
const statePath = path.resolve(
  values.state ??
    (manifest.legacy ? path.join(dir, ".runtime/state.json") : path.join(path.dirname(values.input), "state.json")),
);
let lock;
let walletLock;
const walletLockPath = account
  ? path.join(dir, ".runtime", `wallet-${chain.id}-${account.address.toLowerCase()}.lock`)
  : null;
let stop = false;
process.on("SIGINT", () => {
  stop = true;
  console.log("Stopping after the current transaction; progress is saved.");
});
process.on("SIGTERM", () => {
  stop = true;
});
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {
      chainId: chain.id,
      payer,
      manifestHash,
      account: account?.address,
      datasets: {},
      pending: null,
    };
if (
  state.chainId !== chain.id ||
  state.payer !== payer ||
  state.manifestHash !== manifestHash ||
  (values.execute && state.account?.toLowerCase() !== account.address.toLowerCase())
)
  throw new Error("State belongs to a different manifest, network or signer");
function save() {
  if (!values.execute) return;
  fs.writeFileSync(`${statePath}.tmp`, json(state), { mode: 0o600 });
  fs.renameSync(`${statePath}.tmp`, statePath);
}
state.pendingTransactions ??= [];
if (state.pending) {
  state.pendingTransactions.push(state.pending);
  state.pending = null;
}
// Poll receipts directly: viem's replacement detection performs additional expensive RPC reads.
const receiptClient = {
  getTransactionReceipt: (args) => read(() => client.getTransactionReceipt(args)),
  sendRawTransaction: (args) => read(() => client.sendRawTransaction(args)),
  async waitForTransactionReceipt({ hash, confirmations: depth, timeout }) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const receipt = await read(() => client.getTransactionReceipt({ hash }));
        if (depth === 1 || (await read(() => client.getBlockNumber())) >= receipt.blockNumber + BigInt(depth - 1))
          return receipt;
      } catch (error) {
        if (error.name !== "TransactionReceiptNotFoundError") throw error;
      }
      await pause(4000);
    }
    throw new Error(`RPC receipt timeout for ${hash}`);
  },
};
const enqueue = createSubmissionQueue();
let nextNonce;
async function settlePending() {
  await recoverTransactions({ client: receiptClient, state, save, confirmations });
  nextNonce = await read(() => client.getTransactionCount({ address: account.address, blockTag: "pending" }));
}
async function submit(id, action, args, gas) {
  const pending = await enqueue(async () => {
    if (stop) return null;
    const paddedGas = (gas * 120n) / 100n;
    if (paddedGas > maxGas) throw new Error(`Gas ${paddedGas} exceeds max-gas ${maxGas}`);
    const data = encodeFunctionData({ abi: pdp.abi, functionName: action, args });
    const nonce = nextNonce;
    const request = await read(() =>
      wallet.prepareTransactionRequest({ to: pdp.address, data, gas: paddedGas, nonce }),
    );
    const raw = await wallet.signTransaction(request);
    const tx = { id, action, nonce, hash: keccak256(raw), raw };
    state.pendingTransactions.push(tx);
    save(); // Every nonce is journaled BEFORE broadcast.
    nextNonce++;
    try {
      await read(() => client.sendRawTransaction({ serializedTransaction: raw }));
    } catch (error) {
      if (!/already known|already in.*pool|nonce too low|nonce has already/i.test(error.message ?? "")) {
        stop = true;
        throw error;
      }
      console.log(`${id}: saved transaction already broadcast; waiting for ${tx.hash}`);
    }
    console.log(`${id}: ${action} submitted nonce=${nonce} ${tx.hash}`);
    return tx;
  });
  if (!pending) return;
  // Only signing/broadcasting is serialized; confirmations run concurrently.
  await confirmTransaction({ client: receiptClient, state, pending, save, confirmations });
}
async function simulate(action, args) {
  return read(() => client.simulateContract({ ...pdp, functionName: action, args, account: caller }));
}
async function estimate(action, args) {
  return read(() => client.estimateContractGas({ ...pdp, functionName: action, args, account: caller }));
}
let constants;
async function activityConstants() {
  constants ??= Promise.all([
    read(() => client.readContract({ ...pdp, functionName: "INACTIVITY_WINDOW" })),
    read(() => client.readContract({ ...pdp, functionName: "LEGACY_ACTIVITY_EPOCH" })),
  ]);
  return constants;
}
async function eligible(d) {
  const id = BigInt(d.dataSetId);
  const block = await read(() => client.getBlock());
  const info = await read(() => client.readContract(getDataSetCall({ chain, dataSetId: id })));
  if (
    info.payer.toLowerCase() !== payer ||
    String(info.pdpRailId) !== d.pdpRailId ||
    String(info.providerId) !== d.providerId ||
    (info.pdpEndEpoch > 0n && block.number < info.pdpEndEpoch)
  )
    return false;
  const last = await read(() => client.readContract({ ...pdp, functionName: "getDataSetLastProvenEpoch", args: [id] }));
  const [window, legacy] = await activityConstants();
  const effective = last || legacy;
  if (block.number <= effective + window) return false;
  if (info.pdpEndEpoch === 0n) return values["include-abandoned"] && d.category === "abandoned_deletable";
  try {
    const rail = await read(() =>
      client.readContract({ ...chain.contracts.filecoinPay, functionName: "getRail", args: [info.pdpRailId] }),
    );
    return rail.endEpoch > 0n && rail.settledUpTo >= rail.endEpoch;
  } catch (e) {
    if (revertName(e) === "RailInactiveOrSettled") return true;
    throw e;
  }
}
async function cleanup(id) {
  for (let n = 0; n < 10000 && !stop; n++) {
    try {
      await simulate("cleanupPieces", [BigInt(id), 1n]);
    } catch (e) {
      if (revertName(e) === "DataSetNotInCleanupMode") {
        if (await read(() => client.readContract({ ...pdp, functionName: "dataSetLive", args: [BigInt(id)] })))
          throw new Error(`Acceptance failed: ${id} is still live`);
        state.datasets[id] ??= { transactions: [] };
        state.datasets[id].status = "complete";
        save();
        console.log(`${id}: cleanup complete`);
        return;
      }
      throw e;
    }
    let batch = batchSize;
    let gas;
    while (true) {
      try {
        gas = await estimate("cleanupPieces", [BigInt(id), BigInt(batch)]);
      } catch (error) {
        if (batch === 1 || !/out of gas|SysErrOutOfGas/i.test(error.message ?? "")) throw error;
        batch = Math.max(1, Math.floor(batch / 2));
        continue;
      }
      if ((gas * 120n) / 100n <= maxGas || batch === 1) break;
      batch = Math.max(1, Math.floor(batch / 2));
    }
    if (!values.execute) {
      console.log(`${id}: already in cleanup mode; next batch gas=${gas}`);
      return;
    }
    await submit(id, "cleanupPieces", [BigInt(id), BigInt(batch)], gas);
  }
  if (!stop) throw new Error(`Cleanup batch limit reached for ${id}; resume required`);
}
try {
  if (values.execute) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(walletLockPath), { recursive: true });
    walletLock = fs.openSync(walletLockPath, "wx", 0o600);
    fs.writeSync(walletLock, String(process.pid));
    lock = fs.openSync(`${statePath}.lock`, "wx", 0o600);
    fs.writeSync(lock, String(process.pid));
    save();
    await settlePending();
  }
  const balance = await read(() => client.getBalance({ address: account?.address ?? caller }));
  console.log(`Caller balance=${balance} attoFIL`);
  console.log(
    `${values.execute ? "EXECUTE" : "DRY RUN"} ${network}; caller=${account?.address ?? caller}; limit=${limit}; concurrency=${concurrency}; confirmations=${confirmations}; candidates=${candidates.length}`,
  );
  const pendingIds = Object.entries(state.datasets)
    .filter(([, v]) => v.status !== "complete")
    .map(([id]) => id);
  const ordered = [
    ...pendingIds.map((id) => candidates.find((d) => d.dataSetId === id)),
    ...candidates.filter((d) => !pendingIds.includes(d.dataSetId)),
  ];
  const work = ordered
    .filter(
      (d) =>
        state.datasets[d.dataSetId]?.status !== "complete" &&
        (d.category !== "abandoned_deletable" ||
          values["include-abandoned"] ||
          state.datasets[d.dataSetId]?.transactions.length),
    )
    .slice(0, limit);
  const failures = [];
  let cursor = 0;
  async function processDataSet(d) {
    const id = BigInt(d.dataSetId);
    try {
      // Deleted datasets disappear from FWSS; first check whether piece cleanup is pending.
      let inCleanup = false;
      try {
        await simulate("cleanupPieces", [id, BigInt(batchSize)]);
        inCleanup = true;
      } catch (e) {
        if (revertName(e) !== "DataSetNotInCleanupMode") throw e;
      }
      if (inCleanup) {
        await cleanup(d.dataSetId);
        return;
      }
      const live = await read(() => client.readContract({ ...pdp, functionName: "dataSetLive", args: [id] }));
      if (!live) {
        console.log(`${id}: already removed`);
        state.datasets[d.dataSetId] ??= { transactions: [] };
        state.datasets[d.dataSetId].status = "complete";
        save();
        return;
      }
      if (!(await eligible(d))) {
        state.datasets[d.dataSetId] ??= { transactions: [] };
        state.datasets[d.dataSetId].status = "skipped";
        save();
        console.log(`${id}: skipped; eligibility changed`);
        return;
      }
      const gas = await estimate("deleteDataSet", [id, "0x"]);
      console.log(`${id}: eligible; delete gas=${gas}; manifest leafCount=${d.leafCount}`);
      if (!values.execute || stop) return;
      await submit(d.dataSetId, "deleteDataSet", [id, "0x"], gas);
      await cleanup(d.dataSetId);
    } catch (e) {
      console.error(`${id}: ${message(e)}`);
      // Stop on any unexpected failure, especially an unresolved broadcast.
      stop = true;
      failures.push(e);
    }
  }
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!stop && cursor < work.length) {
        const d = work[cursor++];
        await processDataSet(d);
      }
    }),
  );
  if (failures.length) throw failures[0];
  if (values.execute) {
    const completed = Object.entries(state.datasets)
      .filter(([, v]) => v.status === "complete")
      .map(([id]) => id);
    fs.writeFileSync(`${statePath}.completed-ids.txt`, `${completed.join("\n")}${completed.length ? "\n" : ""}`);
    state.summary = {
      completed: completed.length,
      inFlight: state.pendingTransactions.length,
      updatedAt: new Date().toISOString(),
    };
    save();
    console.log(`Complete=${completed.length}; state=${statePath}`);
  }
} catch (e) {
  console.error(`Stopped: ${message(e)}. Resume with the same state file.`);
  process.exitCode = 1;
} finally {
  if (walletLock !== undefined) {
    fs.closeSync(walletLock);
    fs.unlinkSync(walletLockPath);
  }
  if (lock !== undefined) {
    fs.closeSync(lock);
    fs.unlinkSync(`${statePath}.lock`);
  }
}
