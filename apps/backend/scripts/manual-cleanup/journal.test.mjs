import assert from "node:assert/strict";
import { test } from "node:test";
import { settlePending } from "./journal.mjs";

const pending = { id: "123", action: "deleteDataSet", hash: "0xhash", raw: "0xsigned" };
const receipt = { status: "success", blockNumber: 10n };
const missing = Object.assign(new Error("missing"), { name: "TransactionReceiptNotFoundError" });
function setup(client) {
  const state = { pending: { ...pending }, datasets: {} };
  let saved = 0;
  return { state, run: () => settlePending({ client, state, save: () => saved++, log: () => {} }), saved: () => saved };
}
test("resume an already mined transaction without broadcasting it again", async () => {
  const s = setup({ getTransactionReceipt: async () => receipt });
  await s.run();
  assert.equal(s.state.pending, null);
  assert.equal(s.saved(), 1);
  assert.equal(s.state.datasets["123"].transactions[0].hash, pending.hash);
});
test("unknown broadcast response still resolves the exact saved hash", async () => {
  const s = setup({
    getTransactionReceipt: async () => {
      throw missing;
    },
    sendRawTransaction: async ({ serializedTransaction }) => {
      assert.equal(serializedTransaction, pending.raw);
      throw new Error("connection reset after broadcast");
    },
    waitForTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, pending.hash);
      return receipt;
    },
  });
  await s.run();
  assert.equal(s.state.pending, null);
  assert.equal(s.saved(), 1);
});
test("timeout retains pending transaction and does not advance journal", async () => {
  const s = setup({
    getTransactionReceipt: async () => {
      throw missing;
    },
    sendRawTransaction: async () => {},
    waitForTransactionReceipt: async () => {
      throw new Error("timeout");
    },
  });
  await assert.rejects(s.run(), /timeout/);
  assert.deepEqual(s.state.pending, pending);
  assert.equal(s.saved(), 0);
});
test("on-chain revert is recorded before stopping", async () => {
  const s = setup({ getTransactionReceipt: async () => ({ ...receipt, status: "reverted" }) });
  await assert.rejects(s.run(), /Transaction reverted/);
  assert.equal(s.state.pending, null);
  assert.equal(s.saved(), 1);
  assert.equal(s.state.datasets["123"].transactions[0].status, "reverted");
});

import { confirmTransaction, createSubmissionQueue, recoverTransactions } from "./journal.mjs";

test("concurrent workers allocate nonces in sequence with no overlapping submissions", async () => {
  const queue = createSubmissionQueue();
  let nonce = 10,
    running = 0;
  const jobs = Array.from({ length: 8 }, () =>
    queue(async () => {
      assert.equal(running++, 0);
      const assigned = nonce++;
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return assigned;
    }),
  );
  assert.deepEqual(await Promise.all(jobs), [10, 11, 12, 13, 14, 15, 16, 17]);
});
test("out-of-order confirmations remove only their own pending transaction", async () => {
  const a = { ...pending, hash: "0xa", nonce: 1 },
    b = { ...pending, id: "124", hash: "0xb", nonce: 2 };
  const state = { pendingTransactions: [a, b], datasets: {} };
  await confirmTransaction({
    client: { getTransactionReceipt: async () => receipt },
    state,
    pending: b,
    save: () => {},
    log: () => {},
  });
  assert.deepEqual(state.pendingTransactions, [a]);
  assert.equal(state.datasets["124"].transactions.length, 1);
});
test("multi-transaction resume rebroadcasts in nonce order and retains unresolved transactions", async () => {
  const a = { ...pending, hash: "0xa", nonce: 1 },
    b = { ...pending, id: "124", hash: "0xb", nonce: 2 };
  const state = { pendingTransactions: [b, a], datasets: {} };
  const broadcasts = [];
  await assert.rejects(
    recoverTransactions({
      client: {
        getTransactionReceipt: async () => {
          throw missing;
        },
        sendRawTransaction: async ({ serializedTransaction }) => {
          broadcasts.push(serializedTransaction);
        },
        waitForTransactionReceipt: async ({ hash }) => {
          if (hash === "0xb") throw new Error("timeout");
          return receipt;
        },
      },
      state,
      save: () => {},
      log: () => {},
    }),
    /timeout/,
  );
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(state.pendingTransactions, [b]);
});
