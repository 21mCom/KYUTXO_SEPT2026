import { useState, useEffect } from "react";
import { db } from "@/lib/database";
import { getDecryptedParticipantsByAddresses } from "@/lib/dataFacade";

export interface AddressStats {
  balanceSats: number;
  lastTxDate: number;
  txCount: number;
}

export function useAddressStats(
  records: Array<{ id?: number | string; type: string; inputString: string }>,
  enabled: boolean = true
): Map<string, AddressStats> {
  const [stats, setStats] = useState<Map<string, AddressStats>>(new Map());

  useEffect(() => {
    if (!enabled || records.length === 0) {
      setStats(new Map());
      return;
    }

    let cancelled = false;
    const loadStats = async () => {
      const addressRecords = records.filter(r => r.type === 'address' && r.inputString && r.id != null);
      const addressStrings = addressRecords.map(r => r.inputString);
      if (addressStrings.length === 0) {
        if (!cancelled) setStats(new Map());
        return;
      }

      const participants = await getDecryptedParticipantsByAddresses(addressStrings);

      const txids = Array.from(new Set(participants.map(p => p.txid)));
      const txMap = new Map<string, number>();
      if (txids.length > 0) {
        const txBatches: string[][] = [];
        for (let i = 0; i < txids.length; i += 500) {
          txBatches.push(txids.slice(i, i + 500));
        }
        for (const batch of txBatches) {
          const txs = await db.blockchainTransactions
            .where('txid')
            .anyOf(batch)
            .toArray();
          txs.forEach(tx => txMap.set(tx.txid, tx.blockTime));
        }
      }

      const result = new Map<string, AddressStats>();
      const addrAgg = new Map<string, { outputSats: number; inputSats: number; lastTxTime: number; txids: Set<string> }>();
      participants.forEach(p => {
        const agg = addrAgg.get(p.address) || { outputSats: 0, inputSats: 0, lastTxTime: 0, txids: new Set<string>() };
        const blockTime = txMap.get(p.txid) || 0;
        if (p.role === 'output') {
          agg.outputSats += p.amount;
        } else {
          agg.inputSats += p.amount;
        }
        if (blockTime > agg.lastTxTime) {
          agg.lastTxTime = blockTime;
        }
        agg.txids.add(p.txid);
        addrAgg.set(p.address, agg);
      });

      for (const record of addressRecords) {
        const id = String(record.id);
        const agg = addrAgg.get(record.inputString);
        if (agg) {
          result.set(id, {
            balanceSats: agg.outputSats - agg.inputSats,
            lastTxDate: agg.lastTxTime,
            txCount: agg.txids.size,
          });
        }
      }

      if (!cancelled) {
        setStats(result);
      }
    };

    loadStats();
    return () => { cancelled = true; };
  }, [records, enabled]);

  return stats;
}
