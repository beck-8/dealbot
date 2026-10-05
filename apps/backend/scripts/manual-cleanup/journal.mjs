// A pending signed transaction must be resolved before another nonce is signed.
export async function settlePending({ client, state, save, log = console.log }) {
  const pending = state.pending;
  if (!pending) return;
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: pending.hash });
  } catch (error) {
    if (error.name !== "TransactionReceiptNotFoundError") throw error;
  }
  if (!receipt) {
    try {
      await client.sendRawTransaction({ serializedTransaction: pending.raw });
    } catch {
      log(`Broadcast outcome unknown; waiting for saved hash ${pending.hash}`);
    }
    receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations: 2, timeout: 180000 });
  }
  state.datasets[pending.id] ??= { transactions: [] };
  const entry = state.datasets[pending.id];
  entry.transactions.push({
    hash: pending.hash,
    action: pending.action,
    status: receipt.status,
    blockNumber: String(receipt.blockNumber),
  });
  state.pending = null;
  save();
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${pending.hash}`);
  log(`${pending.id}: ${pending.action} confirmed ${pending.hash}`);
}

export function createSubmissionQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}

export async function confirmTransaction({ client, state, pending, save, confirmations = 1, log = console.log }) {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: pending.hash });
  } catch (e) {
    if (e.name !== "TransactionReceiptNotFoundError") throw e;
  }
  if (!receipt || confirmations > 1)
    receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations, timeout: 180000 });
  state.datasets[pending.id] ??= { transactions: [] };
  const entry = state.datasets[pending.id];
  entry.transactions.push({
    hash: pending.hash,
    nonce: pending.nonce,
    action: pending.action,
    status: receipt.status,
    blockNumber: String(receipt.blockNumber),
  });
  state.pendingTransactions = state.pendingTransactions.filter((tx) => tx.hash !== pending.hash);
  save();
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${pending.hash}`);
  log(`${pending.id}: ${pending.action} confirmed nonce=${pending.nonce} block=${receipt.blockNumber} ${pending.hash}`);
}

export async function recoverTransactions(options) {
  const { client, state, save, log = console.log } = options;
  const pending = [...state.pendingTransactions].sort((a, b) => (a.nonce ?? 0) - (b.nonce ?? 0));
  for (const tx of pending) {
    try {
      await client.getTransactionReceipt({ hash: tx.hash });
    } catch (e) {
      if (e.name !== "TransactionReceiptNotFoundError") throw e;
      if (state.account && tx.nonce !== undefined && client.getTransactionCount) {
        const minedNonce = await client.getTransactionCount({ address: state.account, blockTag: "latest" });
        if (minedNonce > tx.nonce) {
          throw new Error(
            `NonceConflict: nonce ${tx.nonce} has already been consumed but saved hash ${tx.hash} has no receipt. Reconcile the replacement transaction before resuming; use a dedicated cleanup wallet.`,
          );
        }
      }
      try {
        await client.sendRawTransaction({ serializedTransaction: tx.raw });
      } catch {
        log(`Recovery broadcast response unknown; waiting for ${tx.hash}`);
      }
    }
  }
  const results = await Promise.allSettled(pending.map((tx) => confirmTransaction({ ...options, pending: tx })));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  save();
}
