import type { ApiTransaction, AddressHistoryDates } from "./types";

/**
 * Compute an address's lifetime history from its full transaction list:
 * first/last-seen block times plus total Received and Sent.
 *
 * Spends are detected by matching each input's prevout reference (txid:vout)
 * against the set of outputs that paid TO this address — every funding output
 * appears in the address history. This works even when inputs carry no prevout
 * address (e.g. Electrum verbose txs), where matching on input addresses alone
 * reports 0 sent. Totals are confirmed-only, matching Esplora's chain_stats.
 */
export function computeHistoryFromTxs(
  address: string,
  txs: ApiTransaction[],
): AddressHistoryDates {
  const ownedOutpoints = new Map<string, number>();
  let receivedSats = 0;
  let firstSeenTime: number | undefined;
  let lastSeenTime: number | undefined;

  for (const tx of txs) {
    if (!tx.status.confirmed) continue;
    if (tx.status.block_time) {
      const t = tx.status.block_time;
      if (lastSeenTime === undefined || t > lastSeenTime) lastSeenTime = t;
      if (firstSeenTime === undefined || t < firstSeenTime) firstSeenTime = t;
    }
    for (const out of tx.vout) {
      if (out.scriptpubkey_address === address) {
        receivedSats += out.value;
        ownedOutpoints.set(`${tx.txid}:${out.n}`, out.value);
      }
    }
  }

  let sentSats = 0;
  for (const tx of txs) {
    if (!tx.status.confirmed) continue;
    for (const inp of tx.vin) {
      if (!inp.txid) continue;
      const owned = ownedOutpoints.get(`${inp.txid}:${inp.vout}`);
      if (owned !== undefined) sentSats += owned;
    }
  }

  return { firstSeenTime, lastSeenTime, receivedSats, sentSats };
}
