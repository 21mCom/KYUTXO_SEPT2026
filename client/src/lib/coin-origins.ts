import { db, type BlockchainTransaction, type Record as VaultRecord, type TransactionMetadata, type TransactionParticipant } from "./database";
import { getAllRecords } from "./data/record-crud";
import { getAllTransactionParticipants, getAllTransactions } from "./data/transaction-crud";
import {
  calculateCoinOrigins,
  filterCoinOrigins,
  filterCoinOriginsByOwner,
  pageCoinOriginsLedger,
  type CoinOriginsInput,
  type CoinOriginsLedger,
  type CoinOriginsPage,
  type CoinOriginsPageOptions,
} from "./coin-origins-core";

export * from "./coin-origins-core";

function snapshotInput(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
  metadata: TransactionMetadata[] = [],
): CoinOriginsInput {
  const metadataByTxid = new Map(metadata.map((row) => [row.txid, row]));
  return {
    transactions: transactions.map((tx) => {
      const meta = metadataByTxid.get(tx.txid);
      return {
        txid: tx.txid,
        blockHeight: tx.blockHeight,
        blockTime: tx.blockTime,
        fee: tx.fee,
        acquisitionMethod: meta?.acquisitionMethod,
        costBasisUsd: meta?.costBasisUsd,
      };
    }),
    participants: participants.map((p) => ({
      id: p.id,
      txid: p.txid,
      role: p.role,
      address: p.address,
      amount: p.amount,
      vout: p.vout,
      prevTxid: p.prevTxid,
      prevVout: p.prevVout,
    })),
    addresses: records
      .filter((record) => record.type === "address" && !!record.inputString)
      .map((record) => ({
        inputString: record.inputString,
        type: record.type,
        addressImportance: record.addressImportance,
        walletName: record.walletName,
        owner: record.owner,
        seedName: record.seedName,
        label: record.label,
      })),
  };
}

export async function loadCoinOrigins(walletName?: string, owners?: string[]): Promise<CoinOriginsLedger> {
  const [records, transactions, participants, metadata] = await Promise.all([
    getAllRecords(),
    getAllTransactions(),
    getAllTransactionParticipants(),
    db.transactionMetadata.toArray(),
  ]);
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants, metadata));
  return filterCoinOriginsByOwner(filterCoinOrigins(ledger, { walletName }), owners);
}

export async function loadCoinOriginsPage(
  opts: CoinOriginsPageOptions & { owners?: string[] } = {},
): Promise<{ ledger: CoinOriginsLedger; page: CoinOriginsPage }> {
  const ledger = await loadCoinOrigins(opts.walletName, opts.owners);
  // The fallback has no persisted derived checkpoint; this key is local to the
  // immutable ledger returned by this load and keeps detail/list paging paired.
  const checkpointKey = `fallback:${ledger.outpoints.length}:${ledger.lots.length}:${ledger.hops.length}`;
  return { ledger, page: pageCoinOriginsLedger(ledger, checkpointKey, opts) };
}

export function calculateCoinOriginsFromRows(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
  walletName?: string,
  metadata: TransactionMetadata[] = [],
  owners?: string[],
): CoinOriginsLedger {
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants, metadata));
  return filterCoinOriginsByOwner(filterCoinOrigins(ledger, { walletName }), owners);
}
