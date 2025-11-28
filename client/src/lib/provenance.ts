// Provenance Tracking - Flow of Funds Path Finding
// Traces UTXO origins and connections between addresses

import { db, type Record, type TransactionParticipant, type BlockchainTransaction } from './database';
import { decryptRecords, isEncryptionReady } from './encryptionFacade';

// A node in the address graph
export interface AddressNode {
  address: string;
  recordId?: number;
  label?: string;
  owner?: string;
  syncDepth?: number;
  isLabeled: boolean;
}

// An edge representing a transaction between addresses
export interface TransactionEdge {
  txid: string;
  fromAddress: string;
  toAddress: string;
  amount: number; // in satoshis
  blockTime: number;
  blockHeight: number;
}

// A path from one address to another through transactions
export interface FlowPath {
  fromAddress: string;
  toAddress: string;
  hops: TransactionEdge[];
  totalSteps: number;
}

// Result of tracing connections
export interface ConnectionResult {
  sourceAddress: string;
  targetAddress: string;
  paths: FlowPath[];
  directConnection: boolean;
  shortestPath: number | null;
}

// Get all transaction participants for an address
async function getAddressParticipants(address: string): Promise<TransactionParticipant[]> {
  return db.transactionParticipants
    .where('address')
    .equals(address)
    .toArray();
}

// Get transaction details
async function getTransaction(txid: string): Promise<BlockchainTransaction | undefined> {
  return db.blockchainTransactions
    .where('txid')
    .equals(txid)
    .first();
}

// Get all participants for a transaction
async function getTransactionParticipants(txid: string): Promise<TransactionParticipant[]> {
  return db.transactionParticipants
    .where('txid')
    .equals(txid)
    .toArray();
}

// Build address node with label info
async function buildAddressNode(address: string, records: Record[]): Promise<AddressNode> {
  const record = records.find(r => r.inputString === address);
  
  return {
    address,
    recordId: record?.id,
    label: record?.label,
    owner: record?.owner,
    syncDepth: record?.syncDepth,
    isLabeled: !!record?.label && record.label !== '' && record.owner !== 'Pending Review',
  };
}

// Find all addresses that received funds FROM a given address (forward tracing)
export async function findOutgoingConnections(
  address: string,
  maxDepth: number = 3
): Promise<Map<string, TransactionEdge[]>> {
  const connections = new Map<string, TransactionEdge[]>();
  const visitedAddresses = new Set<string>();
  const visitedTxids = new Set<string>(); // Prevent processing same tx multiple times
  const queue: Array<{ address: string; depth: number }> = [{ address, depth: 0 }];
  const sourceAddress = address; // Keep track of the original source

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    if (visitedAddresses.has(current.address)) continue;
    visitedAddresses.add(current.address);

    // Find all transactions where this address was an input
    const participants = await getAddressParticipants(current.address);
    const inputTxids = [...new Set(participants
      .filter(p => p.role === 'input')
      .map(p => p.txid))]; // Dedupe txids

    for (const txid of inputTxids) {
      // Skip if we've already processed this transaction
      if (visitedTxids.has(txid)) continue;
      visitedTxids.add(txid);
      
      const tx = await getTransaction(txid);
      if (!tx) continue;

      // Find outputs of this transaction
      const allParticipants = await getTransactionParticipants(txid);
      const outputs = allParticipants.filter(p => p.role === 'output');

      for (const output of outputs) {
        // Skip self-loops and loops back to source
        if (output.address === current.address) continue;
        if (output.address === sourceAddress) continue;
        
        const edge: TransactionEdge = {
          txid,
          fromAddress: current.address,
          toAddress: output.address,
          amount: output.amount,
          blockTime: tx.blockTime,
          blockHeight: tx.blockHeight,
        };

        const existing = connections.get(output.address) || [];
        // Avoid duplicate edges for the same txid
        if (!existing.some(e => e.txid === txid && e.toAddress === output.address)) {
          existing.push(edge);
          connections.set(output.address, existing);
        }

        // Add to queue for further exploration only if not visited
        if (!visitedAddresses.has(output.address)) {
          queue.push({ address: output.address, depth: current.depth + 1 });
        }
      }
    }
  }

  return connections;
}

// Find all addresses that sent funds TO a given address (backward tracing - origin search)
export async function findIncomingConnections(
  address: string,
  maxDepth: number = 3
): Promise<Map<string, TransactionEdge[]>> {
  const connections = new Map<string, TransactionEdge[]>();
  const visitedAddresses = new Set<string>();
  const visitedTxids = new Set<string>(); // Prevent processing same tx multiple times
  const queue: Array<{ address: string; depth: number }> = [{ address, depth: 0 }];
  const targetAddress = address; // Keep track of the original target

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    if (visitedAddresses.has(current.address)) continue;
    visitedAddresses.add(current.address);

    // Find all transactions where this address was an output (received funds)
    const participants = await getAddressParticipants(current.address);
    const outputTxids = [...new Set(participants
      .filter(p => p.role === 'output')
      .map(p => p.txid))]; // Dedupe txids

    for (const txid of outputTxids) {
      // Skip if we've already processed this transaction
      if (visitedTxids.has(txid)) continue;
      visitedTxids.add(txid);
      
      const tx = await getTransaction(txid);
      if (!tx) continue;

      // Find inputs of this transaction (where the funds came from)
      const allParticipants = await getTransactionParticipants(txid);
      const inputs = allParticipants.filter(p => p.role === 'input');

      for (const input of inputs) {
        // Skip self-loops and loops back to target
        if (input.address === current.address) continue;
        if (input.address === targetAddress) continue;
        
        const edge: TransactionEdge = {
          txid,
          fromAddress: input.address,
          toAddress: current.address,
          amount: input.amount,
          blockTime: tx.blockTime,
          blockHeight: tx.blockHeight,
        };

        const existing = connections.get(input.address) || [];
        // Avoid duplicate edges for the same txid
        if (!existing.some(e => e.txid === txid && e.fromAddress === input.address)) {
          existing.push(edge);
          connections.set(input.address, existing);
        }

        // Add to queue for further exploration only if not visited
        if (!visitedAddresses.has(input.address)) {
          queue.push({ address: input.address, depth: current.depth + 1 });
        }
      }
    }
  }

  return connections;
}

// Find path between two specific addresses using BFS
export async function findPathBetweenAddresses(
  sourceAddress: string,
  targetAddress: string,
  maxDepth: number = 5
): Promise<FlowPath | null> {
  const visitedAddresses = new Set<string>();
  const visitedTxids = new Set<string>(); // Track processed transactions to avoid duplicates
  const queue: Array<{ address: string; path: TransactionEdge[] }> = [
    { address: sourceAddress, path: [] }
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    
    if (current.path.length >= maxDepth) continue;
    if (visitedAddresses.has(current.address)) continue;
    visitedAddresses.add(current.address);

    // Find outgoing transactions
    const participants = await getAddressParticipants(current.address);
    const inputTxids = [...new Set(participants
      .filter(p => p.role === 'input')
      .map(p => p.txid))]; // Dedupe

    for (const txid of inputTxids) {
      // Skip if already processed this tx in this path search
      if (visitedTxids.has(txid)) continue;
      visitedTxids.add(txid);
      
      const tx = await getTransaction(txid);
      if (!tx) continue;

      const allParticipants = await getTransactionParticipants(txid);
      const outputs = allParticipants.filter(p => p.role === 'output');

      for (const output of outputs) {
        // Skip self-loops and loops back to source
        if (output.address === current.address) continue;
        if (output.address === sourceAddress) continue;

        const edge: TransactionEdge = {
          txid,
          fromAddress: current.address,
          toAddress: output.address,
          amount: output.amount,
          blockTime: tx.blockTime,
          blockHeight: tx.blockHeight,
        };

        const newPath = [...current.path, edge];

        // Found target!
        if (output.address === targetAddress) {
          return {
            fromAddress: sourceAddress,
            toAddress: targetAddress,
            hops: newPath,
            totalSteps: newPath.length,
          };
        }

        // Continue searching only if not already visited
        if (!visitedAddresses.has(output.address)) {
          queue.push({ address: output.address, path: newPath });
        }
      }
    }
  }

  return null;
}

// Find all connections between labeled addresses in the database
export async function findLabeledConnections(
  maxDepth: number = 3
): Promise<ConnectionResult[]> {
  const results: ConnectionResult[] = [];

  // Get all records and decrypt
  const allRawRecords = await db.records.toArray();
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }

  // Filter to labeled address records (with actual labels, not "Pending Review")
  const labeledAddresses = allRecords.filter(r => 
    r.type === 'address' && 
    r.label && 
    r.label !== '' && 
    r.owner !== 'Pending Review'
  );

  console.log(`[Provenance] Found ${labeledAddresses.length} labeled addresses`);

  // For each pair of labeled addresses, check if they're connected
  for (let i = 0; i < labeledAddresses.length; i++) {
    const source = labeledAddresses[i];
    
    // Get outgoing connections from this address
    const outgoing = await findOutgoingConnections(source.inputString, maxDepth);
    
    // Check if any other labeled addresses are reachable
    for (let j = 0; j < labeledAddresses.length; j++) {
      if (i === j) continue;
      
      const target = labeledAddresses[j];
      const edges = outgoing.get(target.inputString);
      
      if (edges && edges.length > 0) {
        // Found a connection - now find the actual path
        const path = await findPathBetweenAddresses(
          source.inputString, 
          target.inputString, 
          maxDepth
        );

        results.push({
          sourceAddress: source.inputString,
          targetAddress: target.inputString,
          paths: path ? [path] : [],
          directConnection: edges.some(e => e.fromAddress === source.inputString),
          shortestPath: path?.totalSteps || null,
        });
      }
    }
  }

  return results;
}

// Get the provenance chain for an address (where did the funds originally come from)
export async function getProvenanceChain(
  address: string,
  maxDepth: number = 5
): Promise<AddressNode[]> {
  const chain: AddressNode[] = [];
  
  // Get all records for labeling
  const allRawRecords = await db.records.toArray();
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }

  // Trace backwards
  const incoming = await findIncomingConnections(address, maxDepth);
  
  const addresses = Array.from(incoming.keys());
  for (const addr of addresses) {
    const node = await buildAddressNode(addr, allRecords);
    chain.push(node);
  }

  // Sort by whether they're labeled (labeled first) then by syncDepth
  chain.sort((a, b) => {
    if (a.isLabeled && !b.isLabeled) return -1;
    if (!a.isLabeled && b.isLabeled) return 1;
    return (a.syncDepth ?? 999) - (b.syncDepth ?? 999);
  });

  return chain;
}

// Get summary statistics for provenance tracking
export async function getProvenanceStats(): Promise<{
  labeledAddresses: number;
  syncedAddresses: number;
  transactionsStored: number;
  potentialConnections: number;
}> {
  const allRawRecords = await db.records.toArray();
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }

  const addressRecords = allRecords.filter(r => r.type === 'address');
  const labeledAddresses = addressRecords.filter(r => 
    r.label && r.label !== '' && r.owner !== 'Pending Review'
  ).length;

  const syncedAddresses = await db.addressSyncState.count();
  const transactionsStored = await db.blockchainTransactions.count();
  
  // Potential connections = pairs of labeled addresses
  const potentialConnections = labeledAddresses > 1 
    ? (labeledAddresses * (labeledAddresses - 1)) / 2 
    : 0;

  return {
    labeledAddresses,
    syncedAddresses,
    transactionsStored,
    potentialConnections,
  };
}
