import fs from "node:fs";
import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { ContractFunctionRevertedError } from "viem";
export const networks = { calibration, mainnet };
export const permittedCategories = [
  "finalized_deletable",
  "fully_settled_deletable",
  "abandoned_deletable",
  "cleanup_pending",
];
export const json = (value) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v), 2);
export const errorName = (e) => e?.walk?.((x) => x instanceof ContractFunctionRevertedError)?.data?.errorName;
export function loadManifest(filename, expectedNetwork) {
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  const legacy = Array.isArray(value);
  const network = legacy ? "calibration" : value.network;
  const chain = networks[network];
  if (!chain || (expectedNetwork && expectedNetwork !== network)) throw new Error("Manifest network mismatch");
  const candidates = legacy ? value : value.candidates;
  const payer = legacy ? "0x305025d07c1dee47f25a4990179eff2becddca0b" : value.payer;
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(payer ?? "") ||
    !Array.isArray(candidates) ||
    (!legacy && (value.version !== 1 || value.chainId !== chain.id))
  )
    throw new Error("Invalid manifest");
  const ids = new Set();
  for (const d of candidates) {
    if (
      !/^\d+$/.test(d.dataSetId) ||
      ids.has(d.dataSetId) ||
      d.payer?.toLowerCase() !== payer.toLowerCase() ||
      !permittedCategories.includes(d.category)
    )
      throw new Error("Invalid candidate manifest");
    ids.add(d.dataSetId);
  }
  return { value, legacy, network, chain, payer: payer.toLowerCase(), candidates };
}
export function classify(d, block, window, legacyEpoch, live, last, rail, railError) {
  if (!live) return "not_live";
  if (d.pdpEndEpoch > 0n && block < d.pdpEndEpoch) return "termination_lockup";
  const expired = block > (last || legacyEpoch) + window;
  if (!expired) return d.pdpEndEpoch > 0n ? "terminated_activity_window" : "active_activity_window";
  if (d.pdpEndEpoch === 0n) return "abandoned_deletable";
  if (railError === "RailInactiveOrSettled") return "finalized_deletable";
  if (rail && rail.endEpoch > 0n && rail.settledUpTo >= rail.endEpoch) return "fully_settled_deletable";
  return rail ? "terminated_unsettled" : "read_error";
}
export function retryRpc({ delay = 200, retries = 4, log = console.log } = {}) {
  let next = 0;
  return async (fn) => {
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), next);
      next = slot + delay;
      await new Promise((r) => setTimeout(r, Math.max(0, slot - Date.now())));
      try {
        return await fn();
      } catch (e) {
        if (errorName(e) || e.name === "TransactionReceiptNotFoundError" || attempt >= retries) throw e;
        log(`RPC retry ${attempt + 1}: ${e.shortMessage ?? e.name}`);
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
      }
    }
  };
}
