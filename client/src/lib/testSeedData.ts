import { db } from './database';
import { createRecord } from './dataFacade';
import { getParticipantsByTxid } from './dataFacade';
import { clearAllRecords } from './data/record-crud';

/**
 * Test data seeding utility for demonstrating KYUTXO features.
 * Uses real Bitcoin addresses with known transaction history for realistic testing.
 * 
 * These addresses are from the Bitcoin testnet faucet and early Bitcoin history,
 * publicly known addresses used for demonstration purposes only.
 */

// Sample addresses with known transaction relationships
// These are publicly known addresses with transaction history
const TEST_DATA = {
  // Owner 1: "Demo User" - a mock individual with multiple wallets
  owner1: {
    name: "Demo User",
    wallets: [
      {
        name: "Primary Cold Storage",
        seedName: "Cold Seed 1",
        addresses: [
          // Real mainnet addresses with known transaction history
          // These are famous/notable Bitcoin addresses (not personal)
          {
            address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // Genesis block coinbase
            label: "Genesis Block Address",
            notes: "Satoshi's genesis block coinbase output - demonstration only",
            amount: 5000000000, // 50 BTC in sats
            date: "2009-01-03",
            tags: ["historical", "genesis"],
            categories: ["Mining Reward"],
            importance: "verified" as const,
          },
          {
            address: "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S", // Early mining address
            label: "Early Mining Wallet",
            notes: "Well-known early Bitcoin mining address",
            amount: 5000000000,
            date: "2009-01-12",
            tags: ["mining", "historical"],
            categories: ["Mining Reward"],
            importance: "manual" as const,
          },
        ]
      },
      {
        name: "Trading Wallet",
        seedName: "Hot Wallet Seed",
        addresses: [
          {
            address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", // Common demo address
            label: "Exchange Deposit",
            notes: "Demo exchange deposit address",
            amount: 100000000, // 1 BTC
            date: "2021-06-15",
            tags: ["exchange", "trading"],
            categories: ["Exchange"],
            importance: "wallet-import" as const,
          },
        ]
      }
    ]
  },
  // Owner 2: "Business Account" - a business entity
  owner2: {
    name: "Business Account",
    wallets: [
      {
        name: "Merchant Wallet",
        seedName: "Business Seed",
        addresses: [
          {
            address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // Bech32 example
            label: "Customer Payments",
            notes: "Native SegWit address for customer payments",
            amount: 50000000, // 0.5 BTC
            date: "2023-01-20",
            tags: ["business", "payments"],
            categories: ["Payment Received"],
            importance: "xpub-derived" as const,
          },
          {
            address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // Another bech32
            label: "Supplier Payment",
            notes: "Payment to supplier for inventory",
            amount: 25000000, // 0.25 BTC
            date: "2023-02-15",
            tags: ["business", "expense"],
            categories: ["Business Expense"],
            importance: "manual" as const,
          },
        ]
      }
    ]
  }
};

// Transaction relationships between addresses for lineage testing
// These represent known transaction flows
const MOCK_TRANSACTIONS = [
  {
    txid: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b", // Genesis block tx
    blockHeight: 0,
    blockTime: 1231006505, // 2009-01-03
    fee: 0,
    feeRate: 0,
    inputs: [], // Coinbase
    outputs: [
      { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", amount: 5000000000, vout: 0 }
    ]
  },
  {
    txid: "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16", // First Bitcoin tx
    blockHeight: 170,
    blockTime: 1231731025, // 2009-01-12
    fee: 0,
    feeRate: 0,
    inputs: [
      { address: "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S", amount: 5000000000, vout: 0 }
    ],
    outputs: [
      { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amount: 1000000000, vout: 0 },
      { address: "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S", amount: 4000000000, vout: 1 } // Change
    ]
  },
  {
    txid: "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456", // Mock modern tx
    blockHeight: 750000,
    blockTime: 1671811200, // 2022-12-24
    fee: 5000,
    feeRate: 25,
    inputs: [
      { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amount: 100000000, vout: 0 }
    ],
    outputs: [
      { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: 50000000, vout: 0 },
      { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amount: 49995000, vout: 1 } // Change
    ]
  },
  {
    txid: "b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567a", // Business payment
    blockHeight: 770000,
    blockTime: 1674403200, // 2023-01-22
    fee: 3000,
    feeRate: 15,
    inputs: [
      { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: 50000000, vout: 0 }
    ],
    outputs: [
      { address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", amount: 25000000, vout: 0 },
      { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: 24997000, vout: 1 } // Change
    ]
  }
];

/**
 * Seed test data into the database for demonstration.
 * Clears existing data first, then inserts test records.
 */
export async function seedTestData(options: { clearExisting?: boolean } = {}): Promise<{
  recordCount: number;
  transactionCount: number;
  lineageCount: number;
}> {
  const { clearExisting = false } = options;
  
  // Optionally clear existing data
  if (clearExisting) {
    await db.transaction('rw', [
      db.records,
      db.owners,
      db.walletNames,
      db.seedNames,
      db.blockchainTransactions,
      db.transactionParticipants,
      db.utxoLineage,
      db.custodySegments
    ], async () => {
      await clearAllRecords({ skipNotification: true });
      await db.owners.clear();
      await db.walletNames.clear();
      await db.seedNames.clear();
      await db.blockchainTransactions.clear();
      await db.transactionParticipants.clear();
      await db.utxoLineage.clear();
      await db.custodySegments.clear();
    });
  }
  
  const now = Date.now();
  const recordIds: number[] = [];
  const addressToRecordId: Map<string, number> = new Map();
  
  // Create vocabulary entries first
  for (const owner of [TEST_DATA.owner1, TEST_DATA.owner2]) {
    // Add owner
    await db.owners.add({ name: owner.name, createdAt: now });
    
    for (const wallet of owner.wallets) {
      // Add wallet name
      const existingWallet = await db.walletNames.where('name').equals(wallet.name).first();
      if (!existingWallet) {
        await db.walletNames.add({ name: wallet.name, createdAt: now });
      }
      
      // Add seed name
      const existingSeed = await db.seedNames.where('name').equals(wallet.seedName).first();
      if (!existingSeed) {
        await db.seedNames.add({ name: wallet.seedName, createdAt: now });
      }
      
      // Add records
      for (const addr of wallet.addresses) {
        // Check if address already exists
        const existing = await db.records.where('inputString').equals(addr.address).first();
        if (existing) {
          addressToRecordId.set(addr.address, existing.id!);
          continue;
        }
        
        const id = await createRecord({
          type: 'address',
          inputString: addr.address,
          label: addr.label,
          notes: addr.notes,
          amount: addr.amount,
          date: addr.date,
          tags: addr.tags,
          categories: addr.categories,
          owner: owner.name,
          walletName: wallet.name,
          seedName: wallet.seedName,
          source: 'manual',
          addressImportance: addr.importance,
        }, { skipVocabularySync: true });
        recordIds.push(id);
        addressToRecordId.set(addr.address, id);
      }
    }
  }
  
  // Add tags and categories
  const allTags = new Set<string>();
  const allCategories = new Set<string>();
  
  for (const owner of [TEST_DATA.owner1, TEST_DATA.owner2]) {
    for (const wallet of owner.wallets) {
      for (const addr of wallet.addresses) {
        addr.tags.forEach(t => allTags.add(t));
        addr.categories.forEach(c => allCategories.add(c));
      }
    }
  }
  
  for (const tag of Array.from(allTags)) {
    const existing = await db.tags.where('name').equals(tag).first();
    if (!existing) {
      await db.tags.add({ name: tag, createdAt: now });
    }
  }
  
  for (const cat of Array.from(allCategories)) {
    const existing = await db.categories.where('name').equals(cat).first();
    if (!existing) {
      await db.categories.add({ name: cat, createdAt: now });
    }
  }
  
  // Insert mock blockchain transactions
  for (const tx of MOCK_TRANSACTIONS) {
    const existingTx = await db.blockchainTransactions.where('txid').equals(tx.txid).first();
    if (!existingTx) {
      await db.blockchainTransactions.add({
        txid: tx.txid,
        blockHeight: tx.blockHeight,
        blockTime: tx.blockTime,
        fee: tx.fee,
        feeRate: tx.feeRate,
        syncedAt: now
      });
    }
    
    // Add inputs
    const existingTxParticipants = await getParticipantsByTxid(tx.txid);
    for (const input of tx.inputs) {
      const existingParticipant = existingTxParticipants.find(
        p => p.role === 'input' && p.address === input.address
      );
      
      if (!existingParticipant) {
        const p = {
          txid: tx.txid,
          role: 'input' as const,
          address: input.address,
          amount: input.amount,
          vout: input.vout,
          recordId: addressToRecordId.get(input.address)
        };
        await db.transactionParticipants.add(p);
      }
    }
    
    // Add outputs
    for (const output of tx.outputs) {
      const existingParticipant = existingTxParticipants.find(
        p => p.role === 'output' && p.address === output.address && p.vout === output.vout
      );
      
      if (!existingParticipant) {
        const p = {
          txid: tx.txid,
          role: 'output' as const,
          address: output.address,
          amount: output.amount,
          vout: output.vout,
          recordId: addressToRecordId.get(output.address)
        };
        await db.transactionParticipants.add(p);
      }
    }
  }
  
  // Build lineage from the transactions
  const lineageCount = await buildTestLineage(addressToRecordId);
  
  return {
    recordCount: recordIds.length,
    transactionCount: MOCK_TRANSACTIONS.length,
    lineageCount
  };
}

/**
 * Build UTXO lineage from the mock transaction data.
 * Creates UtxoLineage records tracking UTXO flows.
 */
async function buildTestLineage(addressToRecordId: Map<string, number>): Promise<number> {
  const now = Date.now();
  let lineageCount = 0;
  
  // Track outputs that can be spent
  const utxoSet = new Map<string, {
    txid: string;
    vout: number;
    address: string;
    amount: number;
    blockTime: number;
    blockHeight: number;
  }>();
  
  // Process transactions in order to build UTXO set and lineage
  for (const tx of MOCK_TRANSACTIONS) {
    // First, consume inputs (mark UTXOs as spent)
    for (const input of tx.inputs) {
      // Find the UTXO being spent (simplified - in reality would need prevTxid+prevVout)
      const utxoKey = `${input.address}:${input.vout}`;
      
      // Look for any UTXO at this address
      for (const [key, utxo] of Array.from(utxoSet.entries())) {
        if (utxo.address === input.address) {
          // This UTXO is being spent - create lineage records for each output
          for (const output of tx.outputs) {
            const isOwned = addressToRecordId.has(utxo.address);
            const isDestOwned = addressToRecordId.has(output.address);
            
            // Determine if this is change (same owner, going back to same owner)
            const isChange = output.address === utxo.address || 
              (isOwned && isDestOwned && output.address !== tx.outputs[0]?.address);
            
            const existing = await db.utxoLineage
              .where('[spentTxid+spentVout]')
              .equals([utxo.txid, utxo.vout])
              .filter(l => l.createdTxid === tx.txid && l.createdVout === output.vout)
              .first();
            
            if (!existing) {
              await db.utxoLineage.add({
                spentTxid: utxo.txid,
                spentVout: utxo.vout,
                spentAddress: utxo.address,
                spentAmount: utxo.amount,
                consumingTxid: tx.txid,
                createdTxid: tx.txid,
                createdVout: output.vout,
                createdAddress: output.address,
                createdAmount: output.amount,
                spentOwned: isOwned,
                createdOwned: isDestOwned,
                isChange: isChange,
                confidence: isOwned && isDestOwned ? 'high' : isOwned || isDestOwned ? 'medium' : 'low',
                blockTime: tx.blockTime,
                blockHeight: tx.blockHeight,
                createdAt: now,
              });
              lineageCount++;
            }
          }
          
          // Remove spent UTXO
          utxoSet.delete(key);
          break;
        }
      }
    }
    
    // Add new UTXOs from outputs
    for (const output of tx.outputs) {
      const key = `${tx.txid}:${output.vout}`;
      utxoSet.set(key, {
        txid: tx.txid,
        vout: output.vout,
        address: output.address,
        amount: output.amount,
        blockTime: tx.blockTime,
        blockHeight: tx.blockHeight
      });
    }
  }
  
  // Build custody segments from the lineage
  await buildTestCustodySegments(addressToRecordId);
  
  return lineageCount;
}

/**
 * Build custody segments from the lineage records.
 */
async function buildTestCustodySegments(addressToRecordId: Map<string, number>): Promise<void> {
  const now = Date.now();
  
  // Get all lineage records for owned addresses
  const lineageRecords = await db.utxoLineage.toArray();
  
  // Group by spending chains
  const processedOrigins = new Set<string>();
  
  for (const lineage of lineageRecords) {
    // Only create segments for owned addresses
    if (!lineage.spentOwned && !lineage.createdOwned) continue;
    
    // Check if this origin has been processed
    const originKey = `${lineage.spentTxid}:${lineage.spentVout}`;
    if (processedOrigins.has(originKey)) continue;
    processedOrigins.add(originKey);
    
    // Look up owner and wallet info from the record
    const recordId = addressToRecordId.get(lineage.spentAddress);
    let owner: string | undefined;
    let walletName: string | undefined;
    let seedName: string | undefined;
    
    if (recordId) {
      const record = await db.records.get(recordId);
      if (record) {
        owner = record.owner;
        walletName = record.walletName;
        seedName = record.seedName;
      }
    }
    
    // Find the chain of lineage for this origin
    const chain: typeof lineageRecords = [lineage];
    let current = lineage;
    
    while (true) {
      const next = lineageRecords.find(l => 
        l.spentTxid === current.createdTxid && 
        l.spentVout === current.createdVout &&
        l.createdOwned // Follow only owned outputs
      );
      if (!next) break;
      chain.push(next);
      current = next;
    }
    
    // Create custody segment
    const segmentId = crypto.randomUUID();
    const evidenceTxids = Array.from(new Set(chain.flatMap(l => [l.spentTxid, l.createdTxid])));
    
    const lastInChain = chain[chain.length - 1];
    
    // Determine status
    let status: 'active' | 'spent' | 'split' = 'active';
    if (!lastInChain.createdOwned) {
      status = 'spent';
    } else if (chain.some(l => l.isChange)) {
      status = 'split';
    }
    
    // Generate narrative
    const narrative = `Custody began on ${new Date(lineage.blockTime * 1000).toLocaleDateString()} ` +
      `with ${(lineage.spentAmount / 100000000).toFixed(8)} BTC at ${lineage.spentAddress.slice(0, 12)}... ` +
      `Through ${chain.length} hop(s), currently ${status === 'active' ? 'held' : status} ` +
      `at ${lastInChain.createdAddress.slice(0, 12)}...`;
    
    const existing = await db.custodySegments
      .where('[originTxid+originVout]')
      .equals([lineage.spentTxid, lineage.spentVout])
      .first();
    
    if (!existing) {
      await db.custodySegments.add({
        segmentId,
        originTxid: lineage.spentTxid,
        originVout: lineage.spentVout,
        originAddress: lineage.spentAddress,
        originDate: lineage.blockTime, // Unix seconds
        originAmount: lineage.spentAmount,
        currentTxid: lastInChain.createdTxid,
        currentVout: lastInChain.createdVout,
        currentAddress: lastInChain.createdAddress,
        currentAmount: lastInChain.createdAmount,
        status: status === 'active' ? 'active' : status === 'spent' ? 'spent' : 'split',
        hopCount: chain.length - 1,
        evidenceTxids,
        narrative,
        owner,
        walletName,
        seedName,
        createdAt: now,
        updatedAt: now,
      });
      
      // Link lineage records to segment
      for (const l of chain) {
        await db.utxoLineage.update(l.id!, { segmentId });
      }
    }
  }
}

/**
 * Clear all test data (records, transactions, lineage)
 */
export async function clearTestData(): Promise<void> {
  await db.transaction('rw', [
    db.records,
    db.owners,
    db.walletNames,
    db.seedNames,
    db.tags,
    db.categories,
    db.blockchainTransactions,
    db.transactionParticipants,
    db.utxoLineage,
    db.custodySegments,
    db.lineageSnapshots
  ], async () => {
    await clearAllRecords({ skipNotification: true });
    await db.owners.clear();
    await db.walletNames.clear();
    await db.seedNames.clear();
    await db.tags.clear();
    await db.categories.clear();
    await db.blockchainTransactions.clear();
    await db.transactionParticipants.clear();
    await db.utxoLineage.clear();
    await db.custodySegments.clear();
    await db.lineageSnapshots.clear();
  });
}

/**
 * Get summary of current test data in database
 */
export async function getTestDataSummary(): Promise<{
  records: number;
  transactions: number;
  participants: number;
  lineage: number;
  segments: number;
}> {
  return {
    records: await db.records.count(),
    transactions: await db.blockchainTransactions.count(),
    participants: await db.transactionParticipants.count(),
    lineage: await db.utxoLineage.count(),
    segments: await db.custodySegments.count(),
  };
}
