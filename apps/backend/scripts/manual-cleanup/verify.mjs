#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { errorName, json, loadManifest, retryRpc } from "./common.mjs";

const { values: o } = parseArgs({
  options: {
    input: { type: "string" },
    state: { type: "string" },
    out: { type: "string" },
    "delay-ms": { type: "string", default: "200" },
    help: { type: "boolean" },
  },
});
if (o.help) {
  console.log("node verify.mjs --input manifest.json [--state state.json] [--out report.json]");
  process.exit(0);
}
if (!o.input) throw new Error("input required");
const { chain, network, payer, candidates } = loadManifest(o.input);
const client = createPublicClient({
  chain,
  transport: http(process.env.MANUAL_CLEANUP_RPC_URL ?? chain.rpcUrls.default.http[0], {
    timeout: 30000,
    retryCount: 0,
  }),
});
const delay = Number(o["delay-ms"]);
if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("Invalid delay");
const rpc = retryRpc({ delay });
if ((await rpc(() => client.getChainId())) !== chain.id) throw new Error("RPC network mismatch");
const state = o.state ? JSON.parse(fs.readFileSync(o.state, "utf8")) : null;
if (state && (state.chainId !== chain.id || state.payer !== payer)) throw new Error("State network/payer mismatch");
const results = [];
const pdp = chain.contracts.pdp;
for (const d of candidates) {
  const id = BigInt(d.dataSetId);
  let live,
    cleanupMode = false,
    status = "read_error",
    error;
  try {
    live = await rpc(() => client.readContract({ ...pdp, functionName: "dataSetLive", args: [id] }));
    try {
      await rpc(() =>
        client.simulateContract({
          ...pdp,
          functionName: "cleanupPieces",
          args: [id, 1n],
          account: "0x000000000000000000000000000000000000dEaD",
        }),
      );
      cleanupMode = true;
    } catch (e) {
      if (errorName(e) !== "DataSetNotInCleanupMode") throw e;
    }
    status = live ? "not_deleted" : "complete";
    if (cleanupMode) status = "cleanup_pending";
  } catch (e) {
    error = errorName(e) ?? e.shortMessage ?? e.message;
  }
  results.push({
    dataSetId: d.dataSetId,
    providerId: d.providerId,
    status,
    live,
    cleanupMode,
    error,
    transactions: state?.datasets?.[d.dataSetId]?.transactions ?? [],
  });
  if (results.length % 100 === 0) console.log(`Verified ${results.length}/${candidates.length}`);
}
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
const pending = state?.pendingTransactions ?? (state?.pending ? [state.pending] : []);
const report = {
  network,
  chainId: chain.id,
  payer,
  verifiedAt: new Date().toISOString(),
  counts,
  pendingTransactions: pending.map(({ raw, ...tx }) => tx),
  accepted: results.every((r) => r.status === "complete") && !pending.length,
  results,
};
const out = o.out ?? path.join(path.dirname(o.input), "verification.json");
fs.writeFileSync(out, json(report));
console.log(json({ out, counts, accepted: report.accepted, pendingTransactions: pending.length }));
if (!report.accepted) process.exitCode = 2;
