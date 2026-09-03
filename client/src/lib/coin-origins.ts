import type { BlockchainTransaction, Record as VaultRecord, TransactionParticipant } from "./database";
import { getAllRecords } from "./data/record-crud";
import { getAllTransactionParticipants, getAllTransactions } from "./data/transaction-crud";
import {
  calculateCoinOrigins,
  filterCoinOriginsByWallet,
  type CoinOriginsInput,
  type CoinOriginsLedger,
} from "./coin-origins-core";

export * from "./coin-origins-core";

function snapshotInput(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
): CoinOriginsInput {
  return {
    transactions: transactions.map((tx) => ({
      txid: tx.txid,
      blockHeight: tx.blockHeight,
      blockTime: tx.blockTime,
      fee: tx.fee,
    })),
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

export async function loadCoinOrigins(walletName?: string): Promise<CoinOriginsLedger> {
  const [records, transactions, participants] = await Promise.all([
    getAllRecords(),
    getAllTransactions(),
    getAllTransactionParticipants(),
  ]);
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants));
  return filterCoinOriginsByWallet(ledger, walletName);
}

export function calculateCoinOriginsFromRows(
  records: VaultRecord[],
  transactions: BlockchainTransaction[],
  participants: TransactionParticipant[],
  walletName?: string,
): CoinOriginsLedger {
  const ledger = calculateCoinOrigins(snapshotInput(records, transactions, participants));
  return filterCoinOriginsByWallet(ledger, walletName);
}