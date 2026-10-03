#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getClientDataSetsCall } from "@filoz/synapse-core/warm-storage";
import { createPublicClient, http } from "viem";
import { classify, errorName, json, loadManifest, networks, permittedCategories, retryRpc } from "./common.mjs";

const { values: o } = parseArgs({
  options: {
    network: { type: "string" },
    payer: { type: "string" },
    out: { type: "string" },
    "previous-manifest": { type: "string" },
    "delay-ms": { type: "string", default: "200" },
    help: { type: "boolean" },
  },
});
if (o.help) {
  console.log(
    "node scan.mjs --network calibration|mainnet --payer ADDRESS --out DIRECTORY [--previous-manifest FILE] [--delay-ms 200]\nRead-only. Enumerates the specified payer, simulates every candidate, exports manifest.json and inventory.json.",
  );
  process.exit(0);
}
const chain = networks[o.network];
if (!chain || !/^0x[0-9a-fA-F]{40}$/.test(o.payer ?? "") || !o.out)
  throw new Error("network, payer and out are required");
const delay = Number(o["delay-ms"]);
if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("Invalid delay");
const out = path.resolve(o.out);
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, "manifest.json")))
  throw new Error("Use a new output directory; existing manifests must remain immutable");
const client = createPublicClient({
  chain,
  transport: http(process.env.MANUAL_CLEANUP_RPC_URL ?? chain.rpcUrls.default.http[0], {
    timeout: 30000,
    retryCount: 0,
  }),
});
const rpc = retryRpc({ delay });
if ((await rpc(() => client.getChainId())) !== chain.id) throw new Error("Wrong RPC network");
const block = await rpc(() => client.getBlock());
const blockNumber = block.number;
const pdp = chain.contracts.pdp,
  pay = chain.contracts.filecoinPay;
const abi = [...pdp.abi, ...chain.contracts.fwss.abi, ...pay.abi];
const caller = "0x000000000000000000000000000000000000dEaD";
const window = await rpc(() => client.readContract({ ...pdp, functionName: "INACTIVITY_WINDOW", blockNumber }));
const legacy = await rpc(() => client.readContract({ ...pdp, functionName: "LEGACY_ACTIVITY_EPOCH", blockNumber }));
const snapshot = {
  blockNumber: String(blockNumber),
  utc: new Date(Number(block.timestamp) * 1000).toISOString(),
  inactivityWindow: String(window),
  legacyActivityEpoch: String(legacy),
  pdp: pdp.address,
  fwss: chain.contracts.fwss.address,
};
const all = [];
for (let offset = 0n; ; offset += 100n) {
  const page = await rpc(() =>
    client.readContract({ ...getClientDataSetsCall({ chain, address: o.payer, offset, limit: 100n }), blockNumber }),
  );
  all.push(...page);
  if (page.length < 100) break;
  console.log(`Listed ${all.length}`);
}
if (
  new Set(all.map((d) => String(d.dataSetId))).size !== all.length ||
  all.some((d) => d.payer.toLowerCase() !== o.payer.toLowerCase())
)
  throw new Error("Listing contains duplicates or another payer");
console.log(`Snapshot ${blockNumber}; listed ${all.length}`);
const inventory = [];
for (let i = 0; i < all.length; i += 20) {
  const chunk = all.slice(i, i + 20);
  const calls = chunk.flatMap((d) => [
    { ...pdp, functionName: "dataSetLive", args: [d.dataSetId] },
    { ...pdp, functionName: "getDataSetLastProvenEpoch", args: [d.dataSetId] },
    { ...pdp, functionName: "getDataSetLeafCount", args: [d.dataSetId] },
    { ...pay, functionName: "getRail", args: [d.pdpRailId] },
  ]);
  const results = await rpc(() => client.multicall({ contracts: calls, blockNumber, allowFailure: true }));
  for (let j = 0; j < chunk.length; j++) {
    const d = chunk[j];
    const [live, last, leaf, rail] = results.slice(j * 4, j * 4 + 4);
    const item = { ...d, category: "read_error", errors: [] };
    for (const r of [live, last, leaf])
      if (r.status === "failure") item.errors.push(errorName(r.error) ?? r.error.shortMessage ?? "RPC read failed");
    if (!item.errors.length) {
      const railError = rail.status === "failure" ? errorName(rail.error) : null;
      item.lastProvenEpoch = last.result;
      item.leafCount = leaf.result;
      item.railStatus = rail.status === "success" ? "exists" : railError;
      item.category = classify(
        d,
        blockNumber,
        window,
        legacy,
        live.result,
        last.result,
        rail.status === "success" ? rail.result : null,
        railError,
      );
      if (permittedCategories.includes(item.category)) {
        try {
          await rpc(() =>
            client.simulateContract({
              address: pdp.address,
              abi,
              functionName: "deleteDataSet",
              args: [d.dataSetId, "0x"],
              account: caller,
              blockNumber,
            }),
          );
          item.simulationSuccess = true;
        } catch (e) {
          item.simulationSuccess = false;
          item.simulationError = errorName(e) ?? e.shortMessage ?? e.name;
          item.category = errorName(e) ? "simulation_rejected" : "read_error";
        }
      }
    }
    inventory.push(item);
  }
  fs.writeFileSync(path.join(out, "inventory.json"), json(inventory));
  console.log(`Checked ${inventory.length}/${all.length}`);
}
// Previously deleted datasets disappear from FWSS. Recover only IDs from a prior trusted manifest for this payer/network.
if (o["previous-manifest"]) {
  const previous = loadManifest(o["previous-manifest"], o.network);
  if (previous.payer !== o.payer.toLowerCase()) throw new Error("Previous manifest payer mismatch");
  const listed = new Set(all.map((d) => String(d.dataSetId)));
  for (const d of previous.candidates) {
    if (listed.has(d.dataSetId)) continue;
    try {
      await rpc(() =>
        client.simulateContract({
          ...pdp,
          functionName: "cleanupPieces",
          args: [BigInt(d.dataSetId), 1n],
          account: caller,
          blockNumber,
        }),
      );
      inventory.push({ ...d, category: "cleanup_pending", simulationSuccess: true });
    } catch (e) {
      if (errorName(e) !== "DataSetNotInCleanupMode")
        inventory.push({ ...d, category: "read_error", simulationError: errorName(e) ?? e.shortMessage ?? e.name });
    }
  }
}
const candidates = inventory
  .filter((d) => permittedCategories.includes(d.category) && d.simulationSuccess)
  .sort((a, b) => Number(BigInt(a.dataSetId) - BigInt(b.dataSetId)));
const counts = {};
for (const d of inventory) counts[d.category] = (counts[d.category] ?? 0) + 1;
const manifest = {
  version: 1,
  network: o.network,
  chainId: chain.id,
  payer: o.payer.toLowerCase(),
  snapshot,
  simulationCaller: caller,
  scanComplete: !counts.read_error,
  candidates,
};
fs.writeFileSync(path.join(out, "inventory.json"), json(inventory));
fs.writeFileSync(path.join(out, "manifest.json"), json(manifest));
fs.writeFileSync(
  path.join(out, "summary.json"),
  json({ snapshot, listed: all.length, candidates: candidates.length, counts, scanComplete: manifest.scanComplete }),
);
const cols = [
  "dataSetId",
  "providerId",
  "serviceProvider",
  "pdpRailId",
  "pdpEndEpoch",
  "lastProvenEpoch",
  "leafCount",
  "category",
];
fs.writeFileSync(
  path.join(out, "candidates.csv"),
  `${[cols.join(","), ...candidates.map((d) => cols.map((k) => d[k] ?? "").join(","))].join("\n")}\n`,
);
console.log(json({ out, candidates: candidates.length, counts, scanComplete: manifest.scanComplete }));
if (!manifest.scanComplete) process.exitCode = 2;
