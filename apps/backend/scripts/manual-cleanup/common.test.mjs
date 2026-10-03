import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classify, loadManifest } from "./common.mjs";

const d = { pdpEndEpoch: 10n };
test("activity boundary is strict and zero last proof uses the legacy epoch", () => {
  assert.equal(classify(d, 110n, 100n, 10n, true, 0n, null, "RailInactiveOrSettled"), "terminated_activity_window");
  assert.equal(classify(d, 111n, 100n, 10n, true, 0n, null, "RailInactiveOrSettled"), "finalized_deletable");
});
test("fully settled existing rail is eligible, unsettled rail is excluded", () => {
  assert.equal(classify(d, 200n, 100n, 0n, true, 1n, { endEpoch: 20n, settledUpTo: 20n }), "fully_settled_deletable");
  assert.equal(classify(d, 200n, 100n, 0n, true, 1n, { endEpoch: 20n, settledUpTo: 19n }), "terminated_unsettled");
  assert.equal(classify(d, 200n, 100n, 0n, true, 1n, null, "UnknownError"), "read_error");
});
test("un-terminated inactivity candidates use abandonment, subject to exact simulation", () => {
  assert.equal(classify({ pdpEndEpoch: 0n }, 200n, 100n, 0n, true, 1n, null, null), "abandoned_deletable");
  assert.equal(classify({ pdpEndEpoch: 300n }, 200n, 100n, 0n, true, 1n, null, null), "termination_lockup");
});
test("manifests reject network mismatch, foreign payer and duplicate IDs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
  const file = path.join(dir, "manifest.json");
  const payer = "0x305025d07c1dee47f25a4990179eff2becddca0b";
  const value = {
    version: 1,
    network: "mainnet",
    chainId: 314,
    payer,
    candidates: [{ dataSetId: "1", payer, category: "abandoned_deletable" }],
  };
  try {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(loadManifest(file).chain.id, 314);
    assert.throws(() => loadManifest(file, "calibration"), /network mismatch/);
    value.candidates.push({ ...value.candidates[0] });
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadManifest(file), /Invalid candidate/);
    value.candidates = [{ ...value.candidates[0], payer: "0x000000000000000000000000000000000000dEaD" }];
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadManifest(file), /Invalid candidate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
