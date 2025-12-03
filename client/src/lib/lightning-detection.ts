import { db, BlockchainTransaction, TransactionParticipant, Record } from './database';

// Lightning Channel Classification Types
export type LightningClassification = 
  | 'likely-channel-open'
  | 'likely-cooperative-close'
  | 'likely-force-close'
  | 'possibly-ln-related'
  | 'not-ln-related';

// Signal weight categories
type SignalWeight = 'strong' | 'medium' | 'weak';

// Detection signal with weight and description
interface DetectionSignal {
  name: string;
  weight: SignalWeight;
  score: number;
  description: string;
  triggered: boolean;
}

// Result of Lightning detection analysis
export interface LightningDetectionResult {
  txid: string;
  classification: LightningClassification;
  openProbability: number;
  coopCloseProbability: number;
  forceCloseProbability: number;
  uncertainProbability: number;
  signals: DetectionSignal[];
  explanation: string;
  transaction: BlockchainTransaction;
  inputs: TransactionParticipant[];
  outputs: TransactionParticipant[];
  linkedRecords: Record[];
}

// Weight values for signal categories
const SIGNAL_WEIGHTS: { [key in SignalWeight]: number } = {
  strong: 25,
  medium: 15,
  weak: 8
};

// Typical Lightning channel amount ranges (in satoshis)
const LN_MIN_CHANNEL_SATS = 50000;      // 50k sats
const LN_MAX_CHANNEL_SATS = 16777215;   // ~16.7M sats (2^24 - 1, max wumbo)
const LN_TYPICAL_MIN = 100000;          // 100k sats
const LN_TYPICAL_MAX = 10000000;        // 10M sats

// Round amount thresholds (common for LN channels)
const ROUND_AMOUNTS = [
  100000,    // 100k
  200000,    // 200k
  500000,    // 500k
  1000000,   // 1M
  2000000,   // 2M
  5000000,   // 5M
  10000000,  // 10M
  16000000,  // 16M
];

// Check if amount is near a round number (within 1%)
function isRoundAmount(amount: number): boolean {
  for (const round of ROUND_AMOUNTS) {
    const tolerance = round * 0.01;
    if (Math.abs(amount - round) <= tolerance) {
      return true;
    }
  }
  return false;
}

// Check if address is P2WSH (starts with bc1q and is 62 chars, or starts with bc1p for taproot)
function isP2WSH(address: string): boolean {
  // P2WSH addresses are bech32 with 62 characters total
  return address.startsWith('bc1q') && address.length === 62;
}

// Check if address is P2TR (Taproot)
function isP2TR(address: string): boolean {
  return address.startsWith('bc1p') && address.length === 62;
}

// Check if address is P2WPKH (native segwit)
function isP2WPKH(address: string): boolean {
  return address.startsWith('bc1q') && address.length === 42;
}

// Channel Open Detection Signals
function detectChannelOpenSignals(
  tx: BlockchainTransaction,
  inputs: TransactionParticipant[],
  outputs: TransactionParticipant[]
): DetectionSignal[] {
  const signals: DetectionSignal[] = [];
  
  // Strong: Output is P2WSH (canonical LN funding format)
  const p2wshOutputs = outputs.filter(o => isP2WSH(o.address));
  signals.push({
    name: 'P2WSH Output',
    weight: 'strong',
    score: p2wshOutputs.length > 0 ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Output is P2WSH format (typical for LN funding)',
    triggered: p2wshOutputs.length > 0
  });

  // Strong: Exactly 1 output (or 1 primary + small change)
  const outputCount = outputs.length;
  const singleOutput = outputCount === 1;
  const oneWithChange = outputCount === 2 && 
    outputs.some(o => o.amount < outputs.reduce((a, b) => Math.max(a, b.amount), 0) * 0.1);
  signals.push({
    name: 'Single Output Pattern',
    weight: 'strong',
    score: (singleOutput || oneWithChange) ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Exactly 1 output or 1 primary + small change',
    triggered: singleOutput || oneWithChange
  });

  // Strong: Amount in typical LN range
  const primaryOutput = outputs.reduce((max, o) => o.amount > max.amount ? o : max, outputs[0]);
  const inTypicalRange = primaryOutput && 
    primaryOutput.amount >= LN_TYPICAL_MIN && 
    primaryOutput.amount <= LN_TYPICAL_MAX;
  signals.push({
    name: 'Typical LN Amount',
    weight: 'strong',
    score: inTypicalRange ? SIGNAL_WEIGHTS.strong : 0,
    description: `Amount between 100k-10M sats (found: ${primaryOutput?.amount?.toLocaleString()} sats)`,
    triggered: inTypicalRange
  });

  // Medium: P2TR output (Taproot LN channels)
  const p2trOutputs = outputs.filter(o => isP2TR(o.address));
  signals.push({
    name: 'P2TR Output',
    weight: 'medium',
    score: p2trOutputs.length > 0 ? SIGNAL_WEIGHTS.medium : 0,
    description: 'Output is P2TR format (Taproot LN channels)',
    triggered: p2trOutputs.length > 0
  });

  // Medium: 1 input, 1 output pattern
  const oneInOneOut = inputs.length === 1 && outputs.length === 1;
  signals.push({
    name: '1-in-1-out Pattern',
    weight: 'medium',
    score: oneInOneOut ? SIGNAL_WEIGHTS.medium : 0,
    description: 'Transaction has exactly 1 input and 1 output',
    triggered: oneInOneOut
  });

  // Medium: Round amount
  const hasRoundAmount = primaryOutput && isRoundAmount(primaryOutput.amount);
  signals.push({
    name: 'Round Amount',
    weight: 'medium',
    score: hasRoundAmount ? SIGNAL_WEIGHTS.medium : 0,
    description: 'Primary output is a round amount (common for channels)',
    triggered: hasRoundAmount
  });

  // Weak: Amount within LN valid range (broader check)
  const inValidRange = primaryOutput && 
    primaryOutput.amount >= LN_MIN_CHANNEL_SATS && 
    primaryOutput.amount <= LN_MAX_CHANNEL_SATS;
  signals.push({
    name: 'Valid LN Range',
    weight: 'weak',
    score: (inValidRange && !inTypicalRange) ? SIGNAL_WEIGHTS.weak : 0,
    description: 'Amount within valid LN channel range (50k-16.7M sats)',
    triggered: inValidRange && !inTypicalRange
  });

  // Weak: Low fee rate (LN opens often not time-sensitive)
  const lowFeeRate = tx.feeRate < 10;
  signals.push({
    name: 'Low Fee Rate',
    weight: 'weak',
    score: lowFeeRate ? SIGNAL_WEIGHTS.weak : 0,
    description: `Low fee rate suggests non-urgent tx (${tx.feeRate} sat/vB)`,
    triggered: lowFeeRate
  });

  return signals;
}

// Cooperative Close Detection Signals
function detectCoopCloseSignals(
  tx: BlockchainTransaction,
  inputs: TransactionParticipant[],
  outputs: TransactionParticipant[],
  knownAddresses: Set<string>
): DetectionSignal[] {
  const signals: DetectionSignal[] = [];

  // Strong: Input is P2WSH (spending from LN funding UTXO)
  const p2wshInputs = inputs.filter(i => isP2WSH(i.address));
  signals.push({
    name: 'P2WSH Input',
    weight: 'strong',
    score: p2wshInputs.length > 0 ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Input is P2WSH (likely spending from LN funding)',
    triggered: p2wshInputs.length > 0
  });

  // Strong: Input is from known/tracked address
  const knownInputs = inputs.filter(i => knownAddresses.has(i.address));
  signals.push({
    name: 'Known Funding Input',
    weight: 'strong',
    score: knownInputs.length > 0 ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Input is from a tracked/known address',
    triggered: knownInputs.length > 0
  });

  // Strong: Exactly 2 outputs (mutual settlement)
  const twoOutputs = outputs.length === 2;
  signals.push({
    name: 'Two Outputs',
    weight: 'strong',
    score: twoOutputs ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Exactly 2 outputs (mutual close settlement)',
    triggered: twoOutputs
  });

  // Medium: Both outputs are spendable (P2WPKH, P2TR, P2WSH)
  const spendableOutputs = outputs.filter(o => 
    isP2WPKH(o.address) || isP2TR(o.address) || isP2WSH(o.address)
  );
  signals.push({
    name: 'Spendable Outputs',
    weight: 'medium',
    score: spendableOutputs.length === outputs.length ? SIGNAL_WEIGHTS.medium : 0,
    description: 'All outputs are immediately spendable',
    triggered: spendableOutputs.length === outputs.length
  });

  // Medium: Outputs have similar values (balanced close)
  if (outputs.length === 2) {
    const ratio = Math.min(outputs[0].amount, outputs[1].amount) / 
                  Math.max(outputs[0].amount, outputs[1].amount);
    const balanced = ratio > 0.1; // At least 10% of the other
    signals.push({
      name: 'Balanced Outputs',
      weight: 'medium',
      score: balanced ? SIGNAL_WEIGHTS.medium : 0,
      description: 'Two outputs with reasonably balanced amounts',
      triggered: balanced
    });
  }

  // Medium: Moderate fee (not overly high)
  const moderateFee = tx.feeRate >= 5 && tx.feeRate <= 50;
  signals.push({
    name: 'Moderate Fee',
    weight: 'medium',
    score: moderateFee ? SIGNAL_WEIGHTS.medium : 0,
    description: `Moderate fee rate typical for coop close (${tx.feeRate} sat/vB)`,
    triggered: moderateFee
  });

  // Weak: Single input
  const singleInput = inputs.length === 1;
  signals.push({
    name: 'Single Input',
    weight: 'weak',
    score: singleInput ? SIGNAL_WEIGHTS.weak : 0,
    description: 'Single input (spending channel UTXO)',
    triggered: singleInput
  });

  return signals;
}

// Force Close Detection Signals
function detectForceCloseSignals(
  tx: BlockchainTransaction,
  inputs: TransactionParticipant[],
  outputs: TransactionParticipant[],
  knownAddresses: Set<string>
): DetectionSignal[] {
  const signals: DetectionSignal[] = [];

  // Strong: Input is P2WSH (commitment tx spending funding)
  const p2wshInputs = inputs.filter(i => isP2WSH(i.address));
  signals.push({
    name: 'P2WSH Input',
    weight: 'strong',
    score: p2wshInputs.length > 0 ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Input is P2WSH (commitment tx)',
    triggered: p2wshInputs.length > 0
  });

  // Strong: Known address input
  const knownInputs = inputs.filter(i => knownAddresses.has(i.address));
  signals.push({
    name: 'Known Channel Input',
    weight: 'strong',
    score: knownInputs.length > 0 ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Input from tracked channel address',
    triggered: knownInputs.length > 0
  });

  // Strong: Multiple outputs (typical for commitment tx with HTLCs)
  const multipleOutputs = outputs.length >= 2;
  signals.push({
    name: 'Multiple Outputs',
    weight: 'strong',
    score: multipleOutputs ? SIGNAL_WEIGHTS.strong : 0,
    description: 'Multiple outputs (commitment + HTLC outputs)',
    triggered: multipleOutputs
  });

  // Medium: High fee rate (force closes often urgent)
  const highFee = tx.feeRate > 50;
  signals.push({
    name: 'High Fee Rate',
    weight: 'medium',
    score: highFee ? SIGNAL_WEIGHTS.medium : 0,
    description: `High fee rate suggests urgency (${tx.feeRate} sat/vB)`,
    triggered: highFee
  });

  // Medium: P2WSH output (timelocked output)
  const p2wshOutputs = outputs.filter(o => isP2WSH(o.address));
  signals.push({
    name: 'P2WSH Output',
    weight: 'medium',
    score: p2wshOutputs.length > 0 ? SIGNAL_WEIGHTS.medium : 0,
    description: 'P2WSH output (likely timelocked)',
    triggered: p2wshOutputs.length > 0
  });

  // Medium: One small output (anchor output pattern)
  const anchorOutputs = outputs.filter(o => o.amount <= 546); // Dust threshold
  signals.push({
    name: 'Anchor Outputs',
    weight: 'medium',
    score: anchorOutputs.length > 0 ? SIGNAL_WEIGHTS.medium : 0,
    description: 'Small anchor-like outputs present',
    triggered: anchorOutputs.length > 0
  });

  // Weak: 3+ outputs (HTLC outputs)
  const manyOutputs = outputs.length >= 3;
  signals.push({
    name: 'Many Outputs',
    weight: 'weak',
    score: manyOutputs ? SIGNAL_WEIGHTS.weak : 0,
    description: 'Multiple outputs suggesting HTLCs',
    triggered: manyOutputs
  });

  // Weak: Very high fee
  const veryHighFee = tx.feeRate > 100;
  signals.push({
    name: 'Very High Fee',
    weight: 'weak',
    score: veryHighFee ? SIGNAL_WEIGHTS.weak : 0,
    description: `Very high fee rate (${tx.feeRate} sat/vB)`,
    triggered: veryHighFee
  });

  return signals;
}

// Calculate probability from signals
function calculateProbability(signals: DetectionSignal[]): number {
  const triggeredSignals = signals.filter(s => s.triggered);
  if (triggeredSignals.length === 0) return 0;
  
  const totalScore = triggeredSignals.reduce((sum, s) => sum + s.score, 0);
  const maxPossible = signals.reduce((sum, s) => sum + s.score, 0);
  
  // Normalize to 0-100, with diminishing returns after 70%
  const rawPercent = (totalScore / maxPossible) * 100;
  return Math.min(99, Math.round(rawPercent));
}

// Generate explanation from signals
function generateExplanation(
  classification: LightningClassification,
  signals: DetectionSignal[]
): string {
  const triggeredSignals = signals.filter(s => s.triggered);
  
  if (triggeredSignals.length === 0) {
    return 'No Lightning-related patterns detected.';
  }

  const strongSignals = triggeredSignals.filter(s => s.weight === 'strong');
  const mediumSignals = triggeredSignals.filter(s => s.weight === 'medium');
  
  let explanation = '';
  
  switch (classification) {
    case 'likely-channel-open':
      explanation = 'Likely Lightning channel opening: ';
      break;
    case 'likely-cooperative-close':
      explanation = 'Likely cooperative channel close: ';
      break;
    case 'likely-force-close':
      explanation = 'Likely force close (unilateral): ';
      break;
    case 'possibly-ln-related':
      explanation = 'Possibly Lightning-related: ';
      break;
    default:
      return 'No Lightning patterns detected.';
  }

  const signalDescriptions: string[] = [];
  if (strongSignals.length > 0) {
    signalDescriptions.push(...strongSignals.map(s => s.name));
  }
  if (mediumSignals.length > 0 && signalDescriptions.length < 3) {
    signalDescriptions.push(...mediumSignals.slice(0, 3 - signalDescriptions.length).map(s => s.name));
  }

  explanation += signalDescriptions.join(', ');
  return explanation;
}

// Main detection function for a single transaction
export async function detectLightningActivity(
  txid: string
): Promise<LightningDetectionResult | null> {
  // Fetch transaction and participants
  const tx = await db.blockchainTransactions.where('txid').equals(txid).first();
  if (!tx) return null;

  const participants = await db.transactionParticipants.where('txid').equals(txid).toArray();
  const inputs = participants.filter(p => p.role === 'input');
  const outputs = participants.filter(p => p.role === 'output');

  // Get all tracked addresses for known-address detection
  const records = await db.records.where('type').equals('address').toArray();
  const knownAddresses = new Set(records.map(r => r.inputString));

  // Get linked records for this transaction
  const participantAddresses = participants.map(p => p.address);
  const linkedRecords = records.filter(r => participantAddresses.includes(r.inputString));

  // Run all detection algorithms
  const openSignals = detectChannelOpenSignals(tx, inputs, outputs);
  const coopCloseSignals = detectCoopCloseSignals(tx, inputs, outputs, knownAddresses);
  const forceCloseSignals = detectForceCloseSignals(tx, inputs, outputs, knownAddresses);

  // Calculate probabilities
  const openProbability = calculateProbability(openSignals);
  const coopCloseProbability = calculateProbability(coopCloseSignals);
  const forceCloseProbability = calculateProbability(forceCloseSignals);

  // Determine classification
  let classification: LightningClassification = 'not-ln-related';
  let signals: DetectionSignal[] = [];
  let maxProbability = 0;

  if (openProbability >= coopCloseProbability && openProbability >= forceCloseProbability) {
    if (openProbability >= 60) {
      classification = 'likely-channel-open';
    } else if (openProbability >= 30) {
      classification = 'possibly-ln-related';
    }
    signals = openSignals;
    maxProbability = openProbability;
  } else if (coopCloseProbability >= forceCloseProbability) {
    if (coopCloseProbability >= 60) {
      classification = 'likely-cooperative-close';
    } else if (coopCloseProbability >= 30) {
      classification = 'possibly-ln-related';
    }
    signals = coopCloseSignals;
    maxProbability = coopCloseProbability;
  } else {
    if (forceCloseProbability >= 60) {
      classification = 'likely-force-close';
    } else if (forceCloseProbability >= 30) {
      classification = 'possibly-ln-related';
    }
    signals = forceCloseSignals;
    maxProbability = forceCloseProbability;
  }

  // If any probability is above threshold, uncertain becomes relevant
  const uncertainProbability = Math.max(0, maxProbability - 20);

  return {
    txid,
    classification,
    openProbability,
    coopCloseProbability,
    forceCloseProbability,
    uncertainProbability,
    signals,
    explanation: generateExplanation(classification, signals),
    transaction: tx,
    inputs,
    outputs,
    linkedRecords
  };
}

// Scan all transactions for Lightning activity
export async function scanForLightningActivity(
  options: {
    owner?: string;
    walletName?: string;
    minProbability?: number;
  } = {}
): Promise<LightningDetectionResult[]> {
  const { owner, walletName, minProbability = 30 } = options;

  // Get relevant records based on filters
  let recordsQuery = db.records.where('type').equals('address');
  let records = await recordsQuery.toArray();

  // Apply owner/wallet filters
  if (owner) {
    records = records.filter(r => r.owner === owner);
  }
  if (walletName) {
    records = records.filter(r => r.walletName === walletName);
  }

  // Get addresses from filtered records
  const filteredAddresses = new Set(records.map(r => r.inputString));

  // Find all transactions involving these addresses
  let participants: TransactionParticipant[];
  if (filteredAddresses.size > 0) {
    participants = await db.transactionParticipants
      .where('address')
      .anyOf(Array.from(filteredAddresses))
      .toArray();
  } else {
    // No filter - get all participants
    participants = await db.transactionParticipants.toArray();
  }

  // Get unique transaction IDs
  const txidSet = new Set(participants.map(p => p.txid));
  const txids = Array.from(txidSet);

  // Analyze each transaction
  const results: LightningDetectionResult[] = [];
  for (const txid of txids) {
    const result = await detectLightningActivity(txid);
    if (result) {
      const maxProb = Math.max(
        result.openProbability,
        result.coopCloseProbability,
        result.forceCloseProbability
      );
      if (maxProb >= minProbability) {
        results.push(result);
      }
    }
  }

  // Sort by highest probability
  results.sort((a, b) => {
    const aMax = Math.max(a.openProbability, a.coopCloseProbability, a.forceCloseProbability);
    const bMax = Math.max(b.openProbability, b.coopCloseProbability, b.forceCloseProbability);
    return bMax - aMax;
  });

  return results;
}

// Get classification color for UI
export function getClassificationColor(classification: LightningClassification): string {
  switch (classification) {
    case 'likely-channel-open':
      return 'text-green-500';
    case 'likely-cooperative-close':
      return 'text-blue-500';
    case 'likely-force-close':
      return 'text-orange-500';
    case 'possibly-ln-related':
      return 'text-yellow-500';
    default:
      return 'text-muted-foreground';
  }
}

// Get classification badge variant
export function getClassificationBadgeVariant(classification: LightningClassification): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (classification) {
    case 'likely-channel-open':
      return 'default';
    case 'likely-cooperative-close':
      return 'secondary';
    case 'likely-force-close':
      return 'destructive';
    default:
      return 'outline';
  }
}

// Human-readable classification label
export function getClassificationLabel(classification: LightningClassification): string {
  switch (classification) {
    case 'likely-channel-open':
      return 'Channel Open';
    case 'likely-cooperative-close':
      return 'Coop Close';
    case 'likely-force-close':
      return 'Force Close';
    case 'possibly-ln-related':
      return 'Possibly LN';
    default:
      return 'Not LN';
  }
}
