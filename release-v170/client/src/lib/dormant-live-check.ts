// Optional live re-check of a single dormant output against the user's
// configured node provider.
//
// The Dormant Coins scan itself is deliberately offline (local data only).
// This helper backs the explicit, per-row "Check node" action: it verifies
// one exact outpoint (txid:vout) against the node and reports whether it is
// still unspent, already spent, or could not be determined.
//
// Provider strategies:
// - Esplora-compatible providers expose /tx/:txid/outspend/:vout directly.
// - Electrum has no outspend endpoint; instead we list the address's current
//   unspent outpoints (listunspent) and look for the exact outpoint. The
//   funding tx is already in local history, so absence from the unspent set
//   means the output has been spent.

import type { BlockchainProvider } from "@/lib/providers/types";

export interface LiveOutpointResult {
  status: "unspent" | "spent";
  /** The spending transaction id, when the node reports it (Esplora only). */
  spentTxid?: string;
}

export interface LiveOutpointTarget {
  txid: string;
  vout: number;
  /** Address the output pays to — required for the Electrum strategy. */
  address: string;
}

/**
 * Check one exact outpoint against the node. Throws on any failure (node
 * unreachable, output unknown to the node, unsupported provider) — callers
 * surface those as "unknown" with the error message.
 */
export async function checkOutpointLive(
  provider: BlockchainProvider,
  target: LiveOutpointTarget,
  signal?: AbortSignal,
): Promise<LiveOutpointResult> {
  if (provider.getTxOutspend) {
    const outspend = await provider.getTxOutspend(target.txid, target.vout, signal);
    if (outspend === null) {
      throw new Error(
        "The node does not know this transaction/output — it may not be indexed or the local record is wrong.",
      );
    }
    return { status: outspend.spent ? "spent" : "unspent", spentTxid: outspend.spentTxid };
  }

  if (provider.getAddressUtxoOutpoints) {
    if (!target.address) {
      throw new Error("This output has no address, so it cannot be verified over Electrum.");
    }
    const utxos = await provider.getAddressUtxoOutpoints(target.address, signal);
    const stillUnspent = utxos.some((u) => u.txid === target.txid && u.vout === target.vout);
    return { status: stillUnspent ? "unspent" : "spent" };
  }

  throw new Error(
    `${provider.name} does not support checking a single output. Configure an Esplora or Electrum node in Node Connection settings.`,
  );
}
