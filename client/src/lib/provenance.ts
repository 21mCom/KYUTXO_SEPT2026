// Provenance Tracking - Flow of Funds Path Finding
// Traces UTXO origins and connections between addresses

import { db, type Record, type TransactionParticipant, type BlockchainTransaction, type AddressImportance } from './database';
import { decryptRecords, isEncryptionReady } from './encryptionFacade';

// Importance tier levels (higher number = higher importance)
export const IMPORTANCE_TIERS: { [key in AddressImportance]: number } = {
  'verified': 6,
  'manual': 5,
  'wallet-import': 4,
  'xpub-derived': 3,
  'blockchain-discovered': 2,
  'pending-review': 1,
};

// Filter options for provenance exploration
export interface ProvenanceFilter {
  minImportance?: AddressImportance; // Minimum tier to include
  includeTiers?: AddressImportance[]; // Specific tiers to include (if set, overrides minImportance)
  excludePendingReview?: boolean; // Exclude pending review addresses
}

// A node in the address graph - enhanced with importance tier
export interface AddressNode {
  address: string;
  recordId?: number;
  label?: string;
  owner?: string;
  syncDepth?: number;
  isLabeled: boolean;
  addressImportance?: AddressImportance;
  walletName?: string;
  source?: string;
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

// Build address node with label info and importance tier
async function buildAddressNode(address: string, records: Record[]): Promise<AddressNode> {
  const record = records.find(r => r.inputString === address);
  
  return {
    address,
    recordId: record?.id,
    label: record?.label,
    owner: record?.owner,
    syncDepth: record?.syncDepth,
    isLabeled: !!record?.label && record.label !== '' && record.owner !== 'Pending Review',
    addressImportance: record?.addressImportance,
    walletName: record?.walletName,
    source: record?.source,
  };
}

// Check if an address meets the filter criteria
function meetsFilterCriteria(
  record: Record | undefined,
  filter?: ProvenanceFilter
): boolean {
  if (!filter) return true;
  
  // Treat unknown addresses (no record) as pending-review for filtering purposes
  // This ensures tier filtering properly excludes unknown/untracked addresses
  const importance: AddressImportance = record?.addressImportance || 'pending-review';
  
  // Exclude pending review if specified
  if (filter.excludePendingReview && importance === 'pending-review') {
    return false;
  }
  
  // If specific tiers are listed, use those
  if (filter.includeTiers && filter.includeTiers.length > 0) {
    return filter.includeTiers.includes(importance);
  }
  
  // If minimum importance is set, check tier level
  if (filter.minImportance) {
    const minLevel = IMPORTANCE_TIERS[filter.minImportance];
    const recordLevel = IMPORTANCE_TIERS[importance];
    return recordLevel >= minLevel;
  }
  
  return true;
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

// Enhanced connection node with transaction details for visualization
export interface ConnectionNode extends AddressNode {
  edges: TransactionEdge[];  // Transactions connecting to/from this node
  direction: 'incoming' | 'outgoing';
  hopDistance: number;  // Distance from the center address
}

// Result of exploring an address bidirectionally
export interface AddressExplorationResult {
  centerAddress: string;
  centerNode: AddressNode | null;
  incoming: ConnectionNode[];  // Addresses that sent funds to center
  outgoing: ConnectionNode[];  // Addresses that received funds from center
  totalIncoming: number;
  totalOutgoing: number;
  filteredOut: number;  // Count of addresses excluded by filter
}

// Unified address exploration - explore all connections from a single address
// with bidirectional view (incoming AND outgoing) and tier filtering
export async function exploreAddress(
  address: string,
  maxDepth: number = 3,
  filter?: ProvenanceFilter
): Promise<AddressExplorationResult> {
  // Get all records for labeling and filtering
  const allRawRecords = await db.records.toArray();
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }
  
  // Build lookup map for quick record access
  const recordLookup = new Map<string, Record>();
  allRecords.forEach(r => {
    if (r.type === 'address' && r.inputString) {
      recordLookup.set(r.inputString, r);
    }
  });
  
  // Build center node
  const centerNode = await buildAddressNode(address, allRecords);
  
  // Find incoming connections (who sent to this address)
  const incomingMap = await findIncomingConnections(address, maxDepth);
  
  // Find outgoing connections (who received from this address)
  const outgoingMap = await findOutgoingConnections(address, maxDepth);
  
  // Process incoming connections with filter
  const incoming: ConnectionNode[] = [];
  let filteredOut = 0;
  
  const incomingAddresses = Array.from(incomingMap.keys());
  for (const addr of incomingAddresses) {
    const edges = incomingMap.get(addr)!;
    const record = recordLookup.get(addr);
    if (!meetsFilterCriteria(record, filter)) {
      filteredOut++;
      continue;
    }
    
    const node = await buildAddressNode(addr, allRecords);
    
    // Calculate hop distance (minimum edges to reach center)
    const minHops = edges.reduce((min: number, _edge: TransactionEdge) => {
      // Count hops in the edge chain
      const hops = edges.filter((e: TransactionEdge) => e.toAddress === address || edges.some((e2: TransactionEdge) => e2.toAddress === e.fromAddress)).length;
      return Math.min(min, hops);
    }, maxDepth);
    
    incoming.push({
      ...node,
      edges,
      direction: 'incoming',
      hopDistance: minHops > 0 ? minHops : 1,
    });
  }
  
  // Process outgoing connections with filter
  const outgoing: ConnectionNode[] = [];
  
  const outgoingAddresses = Array.from(outgoingMap.keys());
  for (const addr of outgoingAddresses) {
    const edges = outgoingMap.get(addr)!;
    const record = recordLookup.get(addr);
    if (!meetsFilterCriteria(record, filter)) {
      filteredOut++;
      continue;
    }
    
    const node = await buildAddressNode(addr, allRecords);
    
    // Calculate hop distance
    const minHops = edges.reduce((min: number, _edge: TransactionEdge) => {
      const hops = edges.filter((e: TransactionEdge) => e.fromAddress === address || edges.some((e2: TransactionEdge) => e2.fromAddress === e.toAddress)).length;
      return Math.min(min, hops);
    }, maxDepth);
    
    outgoing.push({
      ...node,
      edges,
      direction: 'outgoing',
      hopDistance: minHops > 0 ? minHops : 1,
    });
  }
  
  // Sort by importance tier (higher first), then by labeled status, then by hop distance
  const sortNodes = (a: ConnectionNode, b: ConnectionNode) => {
    // First by importance tier (higher is better)
    const aImportance = IMPORTANCE_TIERS[a.addressImportance || 'pending-review'];
    const bImportance = IMPORTANCE_TIERS[b.addressImportance || 'pending-review'];
    if (bImportance !== aImportance) return bImportance - aImportance;
    
    // Then by labeled status
    if (a.isLabeled && !b.isLabeled) return -1;
    if (!a.isLabeled && b.isLabeled) return 1;
    
    // Then by hop distance (closer is better)
    return a.hopDistance - b.hopDistance;
  };
  
  incoming.sort(sortNodes);
  outgoing.sort(sortNodes);
  
  return {
    centerAddress: address,
    centerNode,
    incoming,
    outgoing,
    totalIncoming: incomingMap.size,
    totalOutgoing: outgoingMap.size,
    filteredOut,
  };
}

// Upgrade an address from blockchain-discovered to verified status
export async function upgradeAddressImportance(
  recordId: number,
  newImportance: AddressImportance = 'verified'
): Promise<boolean> {
  try {
    const record = await db.records.get(recordId);
    if (!record) {
      console.error(`[Provenance] Record ${recordId} not found`);
      return false;
    }
    
    const oldImportance = record.addressImportance || 'pending-review';
    
    // Only allow upgrading to higher tiers
    if (IMPORTANCE_TIERS[newImportance] <= IMPORTANCE_TIERS[oldImportance]) {
      console.warn(`[Provenance] Cannot downgrade importance from ${oldImportance} to ${newImportance}`);
      return false;
    }
    
    const now = Date.now();
    
    // Update the record
    await db.records.update(recordId, {
      addressImportance: newImportance,
      updatedAt: now,
    });
    
    // Create audit log entry in RecordOrigin
    await db.recordOrigins.add({
      recordId,
      originType: 'manual', // Manual action to upgrade
      createdAt: now,
      // Store the upgrade action details
      notes: `Upgraded from ${oldImportance} to ${newImportance}`,
      source: `importance-upgrade:${oldImportance}->${newImportance}`,
    });
    
    console.log(`[Provenance] Upgraded record ${recordId} from ${oldImportance} to ${newImportance}`);
    return true;
  } catch (error) {
    console.error('[Provenance] Failed to upgrade address importance:', error);
    return false;
  }
}

// Get importance tier display info
export function getImportanceTierInfo(importance: AddressImportance | undefined): {
  label: string;
  shortLabel: string;
  color: string;
  description: string;
} {
  switch (importance) {
    case 'verified':
      return {
        label: 'Verified',
        shortLabel: 'V',
        color: 'text-green-600 dark:text-green-400',
        description: 'Manually verified and confirmed address',
      };
    case 'manual':
      return {
        label: 'Manual Entry',
        shortLabel: 'M',
        color: 'text-blue-600 dark:text-blue-400',
        description: 'Manually entered address',
      };
    case 'wallet-import':
      return {
        label: 'Wallet Data Sync',
        shortLabel: 'W',
        color: 'text-purple-600 dark:text-purple-400',
        description: 'Imported from wallet software data',
      };
    case 'xpub-derived':
      return {
        label: 'XPUB Derived',
        shortLabel: 'X',
        color: 'text-orange-600 dark:text-orange-400',
        description: 'Derived from extended public key',
      };
    case 'blockchain-discovered':
      return {
        label: 'Blockchain',
        shortLabel: 'B',
        color: 'text-muted-foreground',
        description: 'Auto-discovered from blockchain sync',
      };
    case 'pending-review':
    default:
      return {
        label: 'Pending Review',
        shortLabel: 'P',
        color: 'text-muted-foreground/60',
        description: 'Awaiting user review',
      };
  }
}
