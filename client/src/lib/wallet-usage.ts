// Pure per-wallet address-usage aggregation shared by the Wallet Overview
// Dexie scan and its parity tests. The native read-engine mirrors these exact
// semantics in SQL (getWalletUsageSummaries in engine/engine-core.ts, gated by
// CURATED_ADDRESS_SQL) — keep the two in sync.

import { isUserCuratedImportance } from "./db-types";
import type { Record as DbRecord } from "./database";

export interface WalletUsageStats {
  walletName: string;
  receiveTotal: number;
  receiveUsed: number;
  changeTotal: number;
  changeUsed: number;
  unknownTotal: number;
  unknownUsed: number;
}

export type WalletUsageRecord = Pick<
  DbRecord,
  | "walletName"
  | "addressImportance"
  | "chainType"
  | "derivationPath"
  | "firstSeenBlockTime"
  | "discoveredInTxid"
>;

export function parseChainType(
  record: Pick<DbRecord, "chainType" | "derivationPath">,
): "receive" | "change" | "unknown" {
  // First check explicit chainType field
  if (record.chainType === "receive") return "receive";
  if (record.chainType === "change") return "change";

  // Try to parse from derivation path (e.g., m/84'/0'/0'/0/5 = receive, m/84'/0'/0'/1/5 = change)
  if (record.derivationPath) {
    const parts = record.derivationPath.split("/");
    // Look for the chain index (usually 4th component after account)
    // Standard: m/purpose'/coin'/account'/chain/index
    if (parts.length >= 5) {
      const chainIndex = parts[parts.length - 2]; // Second to last is chain
      if (chainIndex === "0") return "receive";
      if (chainIndex === "1") return "change";
    }
  }

  // If no derivation info, treat as receive (user's preference)
  return "receive";
}

/**
 * Fold one address record into the per-wallet usage map.
 *
 * Records that are not user-curated (`blockchain-discovered` /
 * `pending-review` — auto-created by sync for counterparty addresses, which
 * inherit the parent wallet's `walletName`) are skipped so they never inflate
 * a wallet's totals; legacy rows with no importance tier count as curated.
 * This matches the engine's CURATED_ADDRESS_SQL predicate exactly.
 *
 * PRODUCT DECISION (curated-only): a wallet whose addresses are ALL
 * discovered/pending-review intentionally gets NO row in Wallet Overview —
 * such "wallets" are just sync-inherited labels on counterparty addresses,
 * not user wallets, and listing them would pollute the usage stats. Those
 * rows stay reachable via Records filters (walletName / importance).
 */
export function addRecordToWalletUsage(
  walletMap: Map<string, WalletUsageStats>,
  record: WalletUsageRecord,
): void {
  if (!record.walletName) return;
  if (!isUserCuratedImportance(record.addressImportance)) return;

  const walletName = record.walletName;
  const chainType = parseChainType(record);
  // An address is "used" if it shows blockchain activity.
  const isUsed = !!(record.firstSeenBlockTime || record.discoveredInTxid);

  let stats = walletMap.get(walletName);
  if (!stats) {
    stats = {
      walletName,
      receiveTotal: 0,
      receiveUsed: 0,
      changeTotal: 0,
      changeUsed: 0,
      unknownTotal: 0,
      unknownUsed: 0,
    };
    walletMap.set(walletName, stats);
  }

  if (chainType === "receive") {
    stats.receiveTotal++;
    if (isUsed) stats.receiveUsed++;
  } else if (chainType === "change") {
    stats.changeTotal++;
    if (isUsed) stats.changeUsed++;
  } else {
    stats.unknownTotal++;
    if (isUsed) stats.unknownUsed++;
  }
}
