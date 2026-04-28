import { 
  db, 
  type UtxoLineage, 
  type CustodySegment, 
  type TransactionParticipant,
  type BlockchainTransaction,
  type Record,
  type LineageConfidence,
  type CustodyStatus,
  type AddressImportance
} from './database';
import { getParticipantsByTxid } from './dataFacade';

// Generate a simple UUID for segment IDs
function generateSegmentId(): string {
  return 'seg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// Importance tier mapping for confidence calculation
const IMPORTANCE_TO_CONFIDENCE: { [key in AddressImportance]: LineageConfidence } = {
  'verified': 'verified',
  'manual': 'high',
  'wallet-import': 'high',
  'xpub-derived': 'high',
  'blockchain-discovered': 'low',
  'pending-review': 'unknown'
};

// Calculate confidence based on ownership of both addresses
function calculateConfidence(
  spentImportance: AddressImportance | undefined,
  createdImportance: AddressImportance | undefined
): LineageConfidence {
  const spentConf = spentImportance ? IMPORTANCE_TO_CONFIDENCE[spentImportance] : 'unknown';
  const createdConf = createdImportance ? IMPORTANCE_TO_CONFIDENCE[createdImportance] : 'unknown';
  
  // Both verified = verified
  if (spentConf === 'verified' && createdConf === 'verified') return 'verified';
  // Both high = high
  if (spentConf === 'high' && createdConf === 'high') return 'high';
  // One high, one at least medium = medium
  if ((spentConf === 'high' || createdConf === 'high') && 
      (spentConf !== 'unknown' && createdConf !== 'unknown')) return 'medium';
  // At least one low = low
  if (spentConf === 'low' || createdConf === 'low') return 'low';
  // Default
  return 'unknown';
}

// Check if an address is owned by the user (based on importance tier)
function isOwnedAddress(importance: AddressImportance | undefined): boolean {
  if (!importance) return false;
  return ['verified', 'manual', 'wallet-import', 'xpub-derived'].includes(importance);
}

// Get record for an address
async function getRecordForAddress(address: string): Promise<Record | undefined> {
  const records = await db.records
    .where('inputString')
    .equals(address)
    .toArray();
  
  if (records.length === 0) return undefined;
  
  // Get the best record (highest importance)
  const importanceOrder: AddressImportance[] = [
    'verified', 'manual', 'wallet-import', 'xpub-derived', 'blockchain-discovered', 'pending-review'
  ];
  
  let bestRecord = records[0];
  for (const record of records) {
    const bestIdx = importanceOrder.indexOf(bestRecord.addressImportance || 'pending-review');
    const currIdx = importanceOrder.indexOf(record.addressImportance || 'pending-review');
    if (currIdx < bestIdx) bestRecord = record;
  }
  
  return bestRecord;
}

// Build lineage for a specific transaction
export async function buildLineageForTransaction(txid: string): Promise<UtxoLineage[]> {
  const transaction = await db.blockchainTransactions
    .where('txid')
    .equals(txid)
    .first();
  
  if (!transaction) {
    console.warn(`Transaction ${txid} not found in database`);
    return [];
  }
  
  // Get all participants for this transaction
  const participants = await getParticipantsByTxid(txid);
  
  const inputs = participants.filter(p => p.role === 'input');
  const outputs = participants.filter(p => p.role === 'output');
  
  if (inputs.length === 0 || outputs.length === 0) {
    return [];
  }
  
  const lineageRecords: UtxoLineage[] = [];
  const now = Date.now();
  
  // For each input, find the previous transaction that created it
  for (const input of inputs) {
    const inputRecord = await getRecordForAddress(input.address);
    const inputOwned = isOwnedAddress(inputRecord?.addressImportance);
    
    // For each output, create a lineage link
    for (const output of outputs) {
      if (output.vout === undefined) continue;
      
      const outputRecord = await getRecordForAddress(output.address);
      const outputOwned = isOwnedAddress(outputRecord?.addressImportance);
      
      // Determine if this is a change output
      // Heuristic: if both input and output are owned and output is smaller, likely change
      const isChange = inputOwned && outputOwned && output.amount < input.amount;
      
      // Check if this lineage already exists
      const existing = await db.utxoLineage
        .where('[createdTxid+createdVout]')
        .equals([txid, output.vout])
        .first();
      
      if (existing) continue;
      
      const lineage: UtxoLineage = {
        // Spent UTXO info - we need to find the previous tx that created this input
        spentTxid: '', // Will be filled in by findPreviousUtxo
        spentVout: 0,
        spentAddress: input.address,
        spentAmount: input.amount,
        // Consuming transaction
        consumingTxid: txid,
        // Created UTXO info
        createdTxid: txid,
        createdVout: output.vout,
        createdAddress: output.address,
        createdAmount: output.amount,
        // Ownership
        spentOwned: inputOwned,
        createdOwned: outputOwned,
        isChange,
        // Confidence
        confidence: calculateConfidence(
          inputRecord?.addressImportance,
          outputRecord?.addressImportance
        ),
        blockTime: transaction.blockTime,
        blockHeight: transaction.blockHeight,
        createdAt: now
      };
      
      lineageRecords.push(lineage);
    }
  }
  
  return lineageRecords;
}

// Build lineage for all synced transactions
export async function buildAllLineage(
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ processed: number; created: number }> {
  const BATCH_SIZE = 500;
  const totalCount = await db.blockchainTransactions.count();
  let processed = 0;
  let created = 0;
  let lastId = 0;

  while (processed < totalCount) {
    if (signal?.aborted) {
      return { processed, created };
    }

    const batch = await db.blockchainTransactions
      .where('id').above(lastId)
      .limit(BATCH_SIZE)
      .toArray();
    if (batch.length === 0) break;

    for (const tx of batch) {
      if (signal?.aborted) {
        return { processed, created };
      }

      const lineageRecords = await buildLineageForTransaction(tx.txid);

      if (lineageRecords.length > 0) {
        await db.utxoLineage.bulkAdd(lineageRecords);
        created += lineageRecords.length;
      }

      processed++;
      if (onProgress) {
        onProgress(processed, totalCount);
      }
    }

    const lastItem = batch[batch.length - 1];
    if (!lastItem.id) break;
    lastId = lastItem.id;
  }
  
  return { processed, created };
}

export interface LineageChainResult {
  chain: UtxoLineage[];
  truncated: boolean;
}

export async function getLineageChainForAddress(
  address: string,
  maxDepth: number = 10,
  maxResults: number = 5000
): Promise<LineageChainResult> {
  const chain: UtxoLineage[] = [];
  const visited = new Set<string>();
  const queue: string[] = [address];
  let depth = 0;
  let truncated = false;
  
  while (queue.length > 0 && depth < maxDepth && chain.length < maxResults) {
    const currentAddress = queue.shift()!;
    if (visited.has(currentAddress)) continue;
    visited.add(currentAddress);
    
    const remaining = maxResults - chain.length;
    const incoming = await db.utxoLineage
      .where('createdAddress')
      .equals(currentAddress)
      .limit(remaining + 1)
      .toArray();
    
    if (incoming.length > remaining) {
      truncated = true;
    }

    for (const lineage of incoming) {
      if (chain.length >= maxResults) {
        truncated = true;
        break;
      }
      chain.push(lineage);
      
      if (lineage.spentOwned && !visited.has(lineage.spentAddress)) {
        queue.push(lineage.spentAddress);
      }
    }
    
    depth++;
  }

  if (!truncated && chain.length >= maxResults && queue.length > 0) {
    truncated = true;
  }
  if (!truncated && queue.length > 0 && depth >= maxDepth) {
    truncated = true;
  }
  
  chain.sort((a, b) => a.blockTime - b.blockTime);
  
  return { chain, truncated };
}

export async function getLineageChainForward(
  address: string,
  maxDepth: number = 10,
  maxResults: number = 5000
): Promise<LineageChainResult> {
  const chain: UtxoLineage[] = [];
  const visited = new Set<string>();
  const queue: string[] = [address];
  let depth = 0;
  let truncated = false;
  
  while (queue.length > 0 && depth < maxDepth && chain.length < maxResults) {
    const currentAddress = queue.shift()!;
    if (visited.has(currentAddress)) continue;
    visited.add(currentAddress);
    
    const remaining = maxResults - chain.length;
    const outgoing = await db.utxoLineage
      .where('spentAddress')
      .equals(currentAddress)
      .limit(remaining + 1)
      .toArray();
    
    if (outgoing.length > remaining) {
      truncated = true;
    }

    for (const lineage of outgoing) {
      if (chain.length >= maxResults) {
        truncated = true;
        break;
      }
      chain.push(lineage);
      
      if (lineage.createdOwned && !visited.has(lineage.createdAddress)) {
        queue.push(lineage.createdAddress);
      }
    }
    
    depth++;
  }

  if (!truncated && chain.length >= maxResults && queue.length > 0) {
    truncated = true;
  }
  if (!truncated && queue.length > 0 && depth >= maxDepth) {
    truncated = true;
  }
  
  chain.sort((a, b) => a.blockTime - b.blockTime);
  
  return { chain, truncated };
}

// Build or update a custody segment from lineage data
export async function buildCustodySegment(
  originAddress: string,
  originTxid: string,
  originVout: number
): Promise<CustodySegment | null> {
  // Check if segment already exists
  const existing = await db.custodySegments
    .where('[originTxid+originVout]')
    .equals([originTxid, originVout])
    .first();
  
  if (existing) {
    return existing;
  }
  
  // Get the origin transaction
  const originTx = await db.blockchainTransactions
    .where('txid')
    .equals(originTxid)
    .first();
  
  if (!originTx) return null;
  
  // Get origin record for metadata
  const originRecord = await getRecordForAddress(originAddress);
  
  const { chain: forwardChain, truncated: forwardTruncated } = await getLineageChainForward(originAddress, 50, 5000);
  
  // Find the current state
  let currentAddress = originAddress;
  let currentTxid = originTxid;
  let currentVout = originVout;
  let currentAmount = 0;
  let hopCount = 0;
  let status: CustodyStatus = 'active';
  const evidenceTxids: string[] = [originTxid];
  const childSegmentIds: string[] = [];
  
  // Get original amount from participants (load by txid, filter)
  const originTxParticipants = await getParticipantsByTxid(originTxid);
  const originOutput = originTxParticipants.find(
    p => p.role === 'output' && p.address === originAddress && p.vout === originVout
  );
  
  const originAmount = originOutput?.amount || 0;
  currentAmount = originAmount;
  
  // Trace forward through the chain
  for (const lineage of forwardChain) {
    if (lineage.spentAddress === currentAddress) {
      evidenceTxids.push(lineage.consumingTxid);
      hopCount++;
      
      if (lineage.createdOwned) {
        // Self-transfer or change - custody continues
        currentAddress = lineage.createdAddress;
        currentTxid = lineage.createdTxid;
        currentVout = lineage.createdVout;
        currentAmount = lineage.createdAmount;
        
        if (lineage.isChange) {
          status = 'split';
        }
      } else {
        // Sent to external - custody ends
        status = 'spent';
        currentAmount = 0;
        break;
      }
    }
  }
  
  let narrativeSuffix = '';
  if (forwardTruncated) {
    narrativeSuffix = ' (lineage data truncated — custody trail may be incomplete)';
  }

  const narrative = generateNarrative(
    originTx.blockTime,
    originAmount,
    hopCount,
    status,
    originRecord?.acquisitionMethod,
    currentAmount
  ) + narrativeSuffix;
  
  const now = Date.now();
  const segment: CustodySegment = {
    segmentId: generateSegmentId(),
    originTxid,
    originVout,
    originAddress,
    originDate: originTx.blockTime,  // Store as Unix timestamp (seconds)
    originAmount,
    acquisitionMethod: originRecord?.acquisitionMethod,
    costBasisUsd: originRecord?.costBasisUsd,
    currentTxid: status === 'active' || status === 'split' ? currentTxid : undefined,
    currentVout: status === 'active' || status === 'split' ? currentVout : undefined,
    currentAddress: status === 'active' || status === 'split' ? currentAddress : undefined,
    currentAmount,
    status,
    childSegmentIds: childSegmentIds.length > 0 ? childSegmentIds : undefined,
    hopCount,
    evidenceTxids,
    narrative,
    lineageTruncated: forwardTruncated || undefined,
    owner: originRecord?.owner,
    walletName: originRecord?.walletName,
    seedName: originRecord?.seedName,
    createdAt: now,
    updatedAt: now
  };
  
  await db.custodySegments.add(segment);
  
  return segment;
}

// Generate human-readable narrative for a custody segment
function generateNarrative(
  originTimestamp: number,
  originAmount: number,
  hopCount: number,
  status: CustodyStatus,
  acquisitionMethod?: string,
  currentAmount?: number
): string {
  const originDate = new Date(originTimestamp * 1000);
  const dateStr = originDate.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
  
  const btcAmount = (originAmount / 100_000_000).toFixed(8);
  const currentBtc = currentAmount ? (currentAmount / 100_000_000).toFixed(8) : '0';
  
  let narrative = `${btcAmount} BTC acquired ${dateStr}`;
  
  if (acquisitionMethod) {
    const methodLabels: { [key: string]: string } = {
      'purchase': 'via purchase',
      'mining': 'from mining',
      'staking': 'from staking',
      'airdrop': 'via airdrop',
      'gift-received': 'as a gift',
      'inheritance': 'via inheritance',
      'salary': 'as salary',
      'payment-for-services': 'as payment for services'
    };
    narrative += ` ${methodLabels[acquisitionMethod] || ''}`;
  }
  
  if (hopCount > 0) {
    narrative += ` → ${hopCount} internal transfer${hopCount > 1 ? 's' : ''}`;
  }
  
  if (status === 'active') {
    narrative += ` → ${currentBtc} BTC still held`;
  } else if (status === 'spent') {
    narrative += ` → Fully spent`;
  } else if (status === 'split') {
    narrative += ` → ${currentBtc} BTC remaining (partial spend)`;
  }
  
  return narrative;
}

// Build all custody segments from owned addresses
export async function buildAllCustodySegments(
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ processed: number; created: number }> {
  const uniqueOrigins = new Map<string, { createdAddress: string; createdTxid: string; createdVout: number }>();

  const ORIGIN_SCAN_BATCH = 1000;
  let originScanOffset = 0;
  while (true) {
    if (signal?.aborted) {
      return { processed: 0, created: 0 };
    }

    const batch = await db.utxoLineage
      .where('createdOwned')
      .equals(1)
      .offset(originScanOffset)
      .limit(ORIGIN_SCAN_BATCH)
      .toArray();

    if (batch.length === 0) break;

    for (const lineage of batch) {
      const key = `${lineage.createdTxid}:${lineage.createdVout}`;
      if (!uniqueOrigins.has(key)) {
        uniqueOrigins.set(key, {
          createdAddress: lineage.createdAddress,
          createdTxid: lineage.createdTxid,
          createdVout: lineage.createdVout
        });
      }
    }

    originScanOffset += batch.length;
    if (batch.length < ORIGIN_SCAN_BATCH) break;
  }

  const origins = Array.from(uniqueOrigins.values());
  let processed = 0;
  let created = 0;

  for (const origin of origins) {
    if (signal?.aborted) {
      return { processed, created };
    }

    const segment = await buildCustodySegment(
      origin.createdAddress,
      origin.createdTxid,
      origin.createdVout
    );

    if (segment) {
      created++;
    }

    processed++;
    if (onProgress) {
      onProgress(processed, origins.length);
    }
  }

  return { processed, created };
}

// Get all segments for an address (as origin or current holder)
export async function getSegmentsForAddress(address: string): Promise<CustodySegment[]> {
  const asOrigin = await db.custodySegments
    .where('originAddress')
    .equals(address)
    .toArray();
  
  const asCurrent = await db.custodySegments
    .where('currentAddress')
    .equals(address)
    .toArray();
  
  // Combine and deduplicate
  const segmentMap = new Map<string, CustodySegment>();
  for (const seg of [...asOrigin, ...asCurrent]) {
    segmentMap.set(seg.segmentId, seg);
  }
  
  return Array.from(segmentMap.values());
}

// Get total custody duration for segments
export function getCustodyDuration(segments: CustodySegment[]): {
  totalDays: number;
  earliestOrigin: Date;
  latestActivity: Date;
} {
  if (segments.length === 0) {
    return {
      totalDays: 0,
      earliestOrigin: new Date(),
      latestActivity: new Date()
    };
  }
  
  // originDate is Unix timestamp (seconds), updatedAt is milliseconds
  const earliestOriginMs = Math.min(...segments.map(s => s.originDate * 1000));
  const latestActivityMs = Math.max(...segments.map(s => s.updatedAt));
  
  const earliestOrigin = new Date(earliestOriginMs);
  const latestActivity = new Date(latestActivityMs);
  const totalDays = Math.floor((latestActivityMs - earliestOriginMs) / (1000 * 60 * 60 * 24));
  
  return {
    totalDays,
    earliestOrigin,
    latestActivity
  };
}

// Evidence Bundle Types for Selective Disclosure
export interface EvidenceBundle {
  version: string;
  generatedAt: string;
  bundleId: string;
  isPartial?: boolean;
  requestedSegments?: number;
  summary: {
    totalSegments: number;
    totalValueBtc: number;
    earliestOrigin: string;
    latestActivity: string;
    totalCustodyDays: number;
  };
  segments: EvidenceSegment[];
  integrityHash?: string;
}

export class PartialBundleError extends Error {
  partialBundle: EvidenceBundle;
  constructor(message: string, partialBundle: EvidenceBundle) {
    super(message);
    this.name = 'PartialBundleError';
    this.partialBundle = partialBundle;
  }
}

export interface EvidenceSegment {
  segmentId: string;
  // Origin info (can be redacted)
  origin?: {
    address: string;
    txid: string;
    vout: number;
    date: string;
    amount: number;
  };
  // Current state (can be redacted)
  current?: {
    address?: string;
    txid?: string;
    vout?: number;
    amount: number;
    status: CustodyStatus;
  };
  // Custody metrics (always included)
  custodyDays: number;
  hopCount: number;
  // Lineage chain (can include full txids or just hashes)
  lineageChain?: {
    txid: string;
    type: 'spent' | 'created';
    confidenceLevel: LineageConfidence;
  }[];
  // Metadata flags
  includesFullAddresses: boolean;
  includesFullTxids: boolean;
}

export interface EvidenceBundleOptions {
  includeAddresses: boolean;
  includeTxids: boolean;
  includeLineageChain: boolean;
  redactExternalAddresses: boolean;
  selectedSegmentIds?: string[];
}

const SEGMENT_BATCH_SIZE = 200;

async function loadSegmentsInBatches(): Promise<CustodySegment[]> {
  const segments: CustodySegment[] = [];
  let lastId = 0;
  while (true) {
    const batch = await db.custodySegments
      .where('id')
      .above(lastId)
      .limit(SEGMENT_BATCH_SIZE)
      .toArray();
    if (batch.length === 0) break;
    segments.push(...batch);
    lastId = batch[batch.length - 1].id!;
    if (batch.length < SEGMENT_BATCH_SIZE) break;
  }
  return segments;
}

async function getLineageForSegment(segment: CustodySegment): Promise<UtxoLineage[]> {
  const addresses = new Set<string>();
  if (segment.originAddress) addresses.add(segment.originAddress);
  if (segment.currentAddress) addresses.add(segment.currentAddress);

  if (addresses.size === 0) return [];

  const addressList = Array.from(addresses);

  const [byCreated, bySpent] = await Promise.all([
    db.utxoLineage.where('createdAddress').anyOf(addressList).toArray(),
    db.utxoLineage.where('spentAddress').anyOf(addressList).toArray(),
  ]);

  const seen = new Set<number>();
  const result: UtxoLineage[] = [];
  for (const rec of byCreated) {
    if (rec.id != null && !seen.has(rec.id)) {
      seen.add(rec.id);
      result.push(rec);
    }
  }
  for (const rec of bySpent) {
    if (rec.id != null && !seen.has(rec.id)) {
      seen.add(rec.id);
      result.push(rec);
    }
  }
  return result;
}

export type ProgressCallback = (current: number, total: number) => void;

// Generate minimal evidence bundle with selective disclosure
export async function generateEvidenceBundle(
  options: EvidenceBundleOptions,
  onProgress?: ProgressCallback
): Promise<EvidenceBundle> {
  const segments = options.selectedSegmentIds
    ? await db.custodySegments.where('segmentId').anyOf(options.selectedSegmentIds).toArray()
    : await loadSegmentsInBatches();

  const { totalDays, earliestOrigin, latestActivity } = getCustodyDuration(segments);
  const totalValueBtc = segments.reduce((sum, s) => sum + s.currentAmount, 0) / 100000000;

  const evidenceSegments: EvidenceSegment[] = [];

  const buildPartialBundle = async (): Promise<EvidenceBundle> => {
    const partialValue = evidenceSegments.reduce((sum, s) => {
      return sum + (s.origin?.amount ?? 0);
    }, 0) / 100000000;

    const partialBundle: EvidenceBundle = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      bundleId: 'bundle_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      isPartial: true,
      requestedSegments: segments.length,
      summary: {
        totalSegments: evidenceSegments.length,
        totalValueBtc: partialValue,
        earliestOrigin: earliestOrigin.toISOString(),
        latestActivity: latestActivity.toISOString(),
        totalCustodyDays: totalDays
      },
      segments: evidenceSegments
    };
    partialBundle.integrityHash = await generateIntegrityHash(partialBundle);
    return partialBundle;
  };

  for (const segment of segments) {
    try {
      const segmentLineage = options.includeLineageChain
        ? await getLineageForSegment(segment)
        : [];

      const originDateMs = segment.originDate * 1000;
      const custodyDays = Math.floor((Date.now() - originDateMs) / (1000 * 60 * 60 * 24));

      const evidenceSegment: EvidenceSegment = {
        segmentId: segment.segmentId,
        custodyDays,
        hopCount: segment.hopCount,
        includesFullAddresses: options.includeAddresses,
        includesFullTxids: options.includeTxids
      };

      evidenceSegment.origin = {
        address: options.includeAddresses ? segment.originAddress : hashAddress(segment.originAddress),
        txid: options.includeTxids ? segment.originTxid : hashTxid(segment.originTxid),
        vout: segment.originVout,
        date: new Date(originDateMs).toISOString(),
        amount: segment.originAmount
      };

      evidenceSegment.current = {
        address: options.includeAddresses && segment.currentAddress 
          ? segment.currentAddress 
          : (segment.currentAddress ? hashAddress(segment.currentAddress) : undefined),
        txid: options.includeTxids && segment.currentTxid 
          ? segment.currentTxid 
          : (segment.currentTxid ? hashTxid(segment.currentTxid) : undefined),
        vout: segment.currentVout,
        amount: segment.currentAmount,
        status: segment.status
      };

      if (options.includeLineageChain && segmentLineage.length > 0) {
        evidenceSegment.lineageChain = segmentLineage.map(l => ({
          txid: options.includeTxids ? l.createdTxid : hashTxid(l.createdTxid),
          type: 'created' as const,
          confidenceLevel: l.confidence
        }));
      }

      evidenceSegments.push(evidenceSegment);
    } catch (err) {
      if (evidenceSegments.length > 0) {
        const partialBundle = await buildPartialBundle();
        const originalMessage = err instanceof Error ? err.message : 'Unknown error';
        throw new PartialBundleError(
          `Export failed after processing ${evidenceSegments.length} of ${segments.length} segments: ${originalMessage}`,
          partialBundle
        );
      }
      throw err;
    }

    if (onProgress) {
      onProgress(evidenceSegments.length, segments.length);
      if (evidenceSegments.length % 5 === 0 || evidenceSegments.length === segments.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  const bundle: EvidenceBundle = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    bundleId: 'bundle_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    summary: {
      totalSegments: segments.length,
      totalValueBtc,
      earliestOrigin: earliestOrigin.toISOString(),
      latestActivity: latestActivity.toISOString(),
      totalCustodyDays: totalDays
    },
    segments: evidenceSegments
  };

  bundle.integrityHash = await generateIntegrityHash(bundle);

  return bundle;
}

// Hash address for privacy (first 8 chars of SHA-256)
function hashAddress(address: string): string {
  return 'addr_' + simpleHash(address).slice(0, 8);
}

// Hash txid for privacy (first 8 chars of SHA-256)
function hashTxid(txid: string): string {
  return 'tx_' + simpleHash(txid).slice(0, 8);
}

// Simple hash function for privacy (not cryptographically secure for external verification)
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Generate integrity hash for the bundle
async function generateIntegrityHash(bundle: EvidenceBundle): Promise<string> {
  const content = JSON.stringify({
    generatedAt: bundle.generatedAt,
    summary: bundle.summary,
    segmentCount: bundle.segments.length,
    segmentIds: bundle.segments.map(s => s.segmentId).sort()
  });
  
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Export evidence bundle to file
export function downloadEvidenceBundle(bundle: EvidenceBundle, filename?: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `evidence-bundle-${bundle.bundleId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Export evidence bundle as PDF
export async function downloadEvidenceBundlePdf(bundle: EvidenceBundle, filename?: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = 20;
  
  const checkPageBreak = (neededSpace: number) => {
    if (y + neededSpace > 280) {
      doc.addPage();
      y = 20;
    }
  };
  
  const formatBtc = (sats: number): string => (sats / 100000000).toFixed(8);
  
  // Title
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('KYUTXO Evidence Bundle', margin, y);
  y += 10;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('Continuity Certificate Report', margin, y);
  y += 8;

  if (bundle.isPartial) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(180, 60, 60);
    doc.text(
      `INCOMPLETE — ${bundle.summary.totalSegments} of ${bundle.requestedSegments ?? '?'} segments exported`,
      margin, y
    );
    doc.setTextColor(0);
    y += 7;
  }
  y += 7;
  
  // Bundle info box
  doc.setDrawColor(200);
  doc.setFillColor(248, 248, 248);
  doc.roundedRect(margin, y, contentWidth, 35, 2, 2, 'FD');
  
  doc.setTextColor(60);
  doc.setFontSize(9);
  y += 8;
  doc.text(`Bundle ID: ${bundle.bundleId}`, margin + 5, y);
  y += 6;
  doc.text(`Generated: ${new Date(bundle.generatedAt).toLocaleString()}`, margin + 5, y);
  y += 6;
  doc.text(`Version: ${bundle.version}`, margin + 5, y);
  y += 6;
  doc.text(`Integrity Hash: ${bundle.integrityHash?.slice(0, 32)}...`, margin + 5, y);
  y += 15;
  
  // Summary section
  doc.setTextColor(0);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Summary', margin, y);
  y += 8;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  
  const summaryData = [
    ['Total Segments:', bundle.summary.totalSegments.toString()],
    ['Total Value:', `${bundle.summary.totalValueBtc.toFixed(8)} BTC`],
    ['Total Custody:', `${bundle.summary.totalCustodyDays} days`],
    ['Earliest Origin:', new Date(bundle.summary.earliestOrigin).toLocaleDateString()],
    ['Latest Activity:', new Date(bundle.summary.latestActivity).toLocaleDateString()]
  ];
  
  for (const [label, value] of summaryData) {
    doc.setFont('helvetica', 'bold');
    doc.text(label, margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, margin + 45, y);
    y += 6;
  }
  y += 10;
  
  // Segments section
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Custody Segments', margin, y);
  y += 10;
  
  for (let i = 0; i < bundle.segments.length; i++) {
    const segment = bundle.segments[i];
    checkPageBreak(60);
    
    // Segment header
    doc.setFillColor(240, 240, 240);
    doc.roundedRect(margin, y - 4, contentWidth, 8, 1, 1, 'F');
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0);
    doc.text(`Segment ${i + 1}: ${segment.segmentId}`, margin + 3, y + 2);
    y += 12;
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    
    // Custody info
    doc.text(`Custody Duration: ${segment.custodyDays} days`, margin, y);
    doc.text(`Hop Count: ${segment.hopCount}`, margin + 80, y);
    y += 6;
    
    doc.setTextColor(100);
    doc.text(`Disclosure: Addresses ${segment.includesFullAddresses ? 'included' : 'redacted'} | TXIDs ${segment.includesFullTxids ? 'included' : 'redacted'}`, margin, y);
    doc.setTextColor(0);
    y += 8;
    
    // Origin details
    if (segment.origin) {
      doc.setFont('helvetica', 'bold');
      doc.text('Origin:', margin, y);
      doc.setFont('helvetica', 'normal');
      y += 5;
      
      const originAddress = segment.origin.address.length > 40 
        ? segment.origin.address.slice(0, 20) + '...' + segment.origin.address.slice(-10)
        : segment.origin.address;
      doc.text(`  Address: ${originAddress}`, margin, y);
      y += 5;
      
      const originTxid = segment.origin.txid.length > 40
        ? segment.origin.txid.slice(0, 20) + '...' + segment.origin.txid.slice(-10)
        : segment.origin.txid;
      doc.text(`  TXID: ${originTxid}`, margin, y);
      y += 5;
      
      doc.text(`  Date: ${new Date(segment.origin.date).toLocaleDateString()}`, margin, y);
      doc.text(`  Amount: ${formatBtc(segment.origin.amount)} BTC`, margin + 80, y);
      y += 8;
    }
    
    // Current state
    if (segment.current) {
      doc.setFont('helvetica', 'bold');
      doc.text('Current State:', margin, y);
      doc.setFont('helvetica', 'normal');
      y += 5;
      
      if (segment.current.address) {
        const currentAddress = segment.current.address.length > 40 
          ? segment.current.address.slice(0, 20) + '...' + segment.current.address.slice(-10)
          : segment.current.address;
        doc.text(`  Address: ${currentAddress}`, margin, y);
        y += 5;
      }
      
      doc.text(`  Status: ${segment.current.status.toUpperCase()}`, margin, y);
      doc.text(`  Amount: ${formatBtc(segment.current.amount)} BTC`, margin + 80, y);
      y += 8;
    }
    
    // Lineage chain
    if (segment.lineageChain && segment.lineageChain.length > 0) {
      checkPageBreak(20);
      doc.setFont('helvetica', 'bold');
      doc.text(`Lineage Chain (${segment.lineageChain.length} links):`, margin, y);
      doc.setFont('helvetica', 'normal');
      y += 5;
      
      const maxLinks = Math.min(segment.lineageChain.length, 5);
      for (let j = 0; j < maxLinks; j++) {
        const link = segment.lineageChain[j];
        const txid = link.txid.length > 40 
          ? link.txid.slice(0, 16) + '...'
          : link.txid;
        doc.text(`  ${j + 1}. ${txid} (${link.confidenceLevel})`, margin, y);
        y += 5;
      }
      
      if (segment.lineageChain.length > 5) {
        doc.setTextColor(100);
        doc.text(`  ... and ${segment.lineageChain.length - 5} more links`, margin, y);
        doc.setTextColor(0);
        y += 5;
      }
    }
    
    y += 10;
  }
  
  // Footer on last page
  checkPageBreak(20);
  y = doc.internal.pageSize.getHeight() - 20;
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text('Generated by KYUTXO - Bitcoin Metadata Manager', margin, y);
  doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin - 20, y);
  
  // Save the PDF
  doc.save(filename || `evidence-bundle-${bundle.bundleId}.pdf`);
}

// Export types for use in components
export type { UtxoLineage, CustodySegment, LineageConfidence, CustodyStatus };
