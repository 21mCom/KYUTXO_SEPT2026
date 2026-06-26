/**
 * Boltzmann-style linkability analysis for a single Bitcoin transaction.
 *
 * Pure, in-repo, offline implementation. No external packages.
 *
 * Algorithm (correct partition-cover approach per LaurentMT):
 *   1. A "kernel" is a balanced pair (input_subset S_i, output_subset S_o)
 *      where sum(S_i) == sum(S_o) exactly.
 *   2. A "valid interpretation" is a set of non-overlapping kernels that
 *      together cover ALL inputs and ALL outputs (a perfect partition).
 *   3. If fee > 0, a synthetic "MINER" output of amount = fee is appended so
 *      sum(all inputs) == sum(all augmented outputs) and a full cover exists.
 *   4. Link probability P[i][j] = (# interpretations where input i and output j
 *      appear in the same kernel) / (total interpretations).
 *   5. Transaction entropy H = -Σ P[i][j] * log2(P[i][j]) for P[i][j] > 0.
 *
 * Complexity: O(2^n × 2^m) kernel enumeration, then exponential cover search.
 * Capped at MAX_INPUTS × MAX_OUTPUTS; returns tooComplex for larger txs.
 */

export interface BoltzmannInput {
  index: number;
  address: string;
  amount: number; // satoshis
}

export interface BoltzmannOutput {
  index: number;
  address: string;
  amount: number; // satoshis
}

export interface LinkProbabilityEntry {
  inputIndex: number;
  outputIndex: number;
  inputAddress: string;
  outputAddress: string;
  /** 0–1; 1 = certainty that this input funded this output */
  probability: number;
}

export interface BoltzmannResult {
  /** Shannon entropy in bits. 0 = fully deterministic, higher = more private. */
  entropy: number;
  entropyLabel: string;
  /** Total valid transaction interpretations (partitions). */
  interpretationCount: number;
  /** True when the tx is too large for exact analysis. */
  tooComplex: boolean;
  /** Link-probability entries with P > 0, NOT including the synthetic miner output. */
  linkMatrix: LinkProbabilityEntry[];
  /** Entropy / maxPossibleEntropy for this input/output configuration. */
  efficiency: number;
  /** Max possible entropy (log2 of max possible interpretations). */
  maxEntropy: number;
}

const MAX_INPUTS = 8;
const MAX_OUTPUTS = 8; // after fee augmentation

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sumByMask(amounts: number[], mask: number): number {
  let s = 0;
  for (let i = 0; i < amounts.length; i++) {
    if (mask & (1 << i)) s += amounts[i];
  }
  return s;
}

function entropyLabel(bits: number): string {
  if (bits < 0) return 'Too complex to analyse exactly';
  if (bits === 0) return 'None (fully traceable)';
  if (bits < 2) return 'Very Low';
  if (bits < 5) return 'Low';
  if (bits < 10) return 'Moderate';
  if (bits < 20) return 'High';
  return 'Very High (CoinJoin-level)';
}

// ─── Kernel enumeration ───────────────────────────────────────────────────────

/**
 * Find all balanced (inputMask, augOutputMask) pairs where
 * sum(inputs[inputMask]) == sum(augOutputs[augOutputMask]).
 */
function findKernels(
  inputAmounts: number[],
  augOutputAmounts: number[]
): Array<[number, number]> {
  const n = inputAmounts.length;
  const m = augOutputAmounts.length;
  const kernels: Array<[number, number]> = [];

  // Pre-compute augOutput masks grouped by sum for fast lookup
  const outputSumToMasks = new Map<number, number[]>();
  for (let oMask = 1; oMask < (1 << m); oMask++) {
    const s = sumByMask(augOutputAmounts, oMask);
    const list = outputSumToMasks.get(s);
    if (list) list.push(oMask);
    else outputSumToMasks.set(s, [oMask]);
  }

  for (let iMask = 1; iMask < (1 << n); iMask++) {
    const iSum = sumByMask(inputAmounts, iMask);
    const matches = outputSumToMasks.get(iSum);
    if (matches) {
      for (const oMask of matches) {
        kernels.push([iMask, oMask]);
      }
    }
  }

  return kernels;
}

// ─── Partition cover search ───────────────────────────────────────────────────

/**
 * Recursively find all ways to cover (iRemaining, oRemaining) using
 * non-overlapping kernels. Each complete cover = one valid interpretation.
 *
 * Uses a "pivot" heuristic (fix the lowest-bit unused input) to prune the
 * search tree and avoid duplicate covers.
 */
function findAllCovers(
  iRemaining: number,
  oRemaining: number,
  kernels: Array<[number, number]>,
  linkCountMatrix: number[][],
  nInputs: number,
  nOutputsReal: number // excludes synthetic miner output
): number {
  if (iRemaining === 0 && oRemaining === 0) {
    return 1; // found one valid interpretation
  }
  if (iRemaining === 0 || oRemaining === 0) {
    return 0; // partial cover — not valid
  }

  // Pivot: lowest set bit in iRemaining
  const pivot = iRemaining & (-iRemaining);

  let total = 0;

  for (const [iMask, oMask] of kernels) {
    if (!(iMask & pivot)) continue;           // must include pivot input
    if (iMask & ~iRemaining) continue;        // uses already-used inputs
    if (oMask & ~oRemaining) continue;        // uses already-used outputs

    // Temporarily record which input–output pairs were used by this kernel
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < nInputs; i++) {
      if (!(iMask & (1 << i))) continue;
      for (let j = 0; j < nOutputsReal; j++) {
        if (!(oMask & (1 << j))) continue;
        pairs.push([i, j]);
      }
    }

    // Add link counts for pairs
    for (const [i, j] of pairs) linkCountMatrix[i][j]++;

    const count = findAllCovers(
      iRemaining & ~iMask,
      oRemaining & ~oMask,
      kernels,
      linkCountMatrix,
      nInputs,
      nOutputsReal
    );

    total += count;

    // If this branch found 0 covers, undo the increments
    // If it found ≥1, leave them (they'll be divided by total at the end)
    if (count === 0) {
      for (const [i, j] of pairs) linkCountMatrix[i][j]--;
    } else {
      // We need per-interpretation counts, not just presence.
      // Undo and redo below after we know `count`:
      for (const [i, j] of pairs) linkCountMatrix[i][j] -= 1;
      for (const [i, j] of pairs) linkCountMatrix[i][j] += count;
    }
  }

  return total;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function computeBoltzmann(
  inputs: BoltzmannInput[],
  outputs: BoltzmannOutput[],
  feeSats?: number
): BoltzmannResult {
  if (inputs.length === 0 || outputs.length === 0) {
    return {
      entropy: 0,
      entropyLabel: 'None (fully traceable)',
      interpretationCount: 0,
      tooComplex: false,
      linkMatrix: [],
      efficiency: 0,
      maxEntropy: 0,
    };
  }

  const inputAmounts = inputs.map(i => i.amount);
  const outputAmounts = outputs.map(o => o.amount);
  const totalIn = inputAmounts.reduce((s, a) => s + a, 0);
  const totalOut = outputAmounts.reduce((s, a) => s + a, 0);
  const fee = feeSats !== undefined ? feeSats : Math.max(0, totalIn - totalOut);

  // Augment outputs with synthetic miner output so full cover is possible
  const augOutputAmounts = fee > 0 ? [...outputAmounts, fee] : [...outputAmounts];
  const nOutputsReal = outputs.length;          // real outputs (not miner)
  const nOutputsAug = augOutputAmounts.length;  // includes miner

  if (inputs.length > MAX_INPUTS || nOutputsAug > MAX_OUTPUTS) {
    return {
      entropy: -1,
      entropyLabel: 'Too complex to analyse exactly',
      interpretationCount: -1,
      tooComplex: true,
      linkMatrix: [],
      efficiency: -1,
      maxEntropy: -1,
    };
  }

  // Find all kernels over augmented outputs
  const kernels = findKernels(inputAmounts, augOutputAmounts);

  if (kernels.length === 0) {
    return {
      entropy: 0,
      entropyLabel: 'None (fully traceable)',
      interpretationCount: 0,
      tooComplex: false,
      linkMatrix: [],
      efficiency: 0,
      maxEntropy: 0,
    };
  }

  // Initialise link-count matrix (inputs × real outputs only)
  const linkCount: number[][] = Array.from({ length: inputs.length }, () =>
    new Array(nOutputsReal).fill(0)
  );

  const allInputsMask = (1 << inputs.length) - 1;
  const allOutputsMask = (1 << nOutputsAug) - 1;

  const interpretationCount = findAllCovers(
    allInputsMask,
    allOutputsMask,
    kernels,
    linkCount,
    inputs.length,
    nOutputsReal
  );

  if (interpretationCount === 0) {
    return {
      entropy: 0,
      entropyLabel: 'None (fully traceable)',
      interpretationCount: 0,
      tooComplex: false,
      linkMatrix: [],
      efficiency: 0,
      maxEntropy: 0,
    };
  }

  // Build link-probability matrix and compute entropy
  const linkMatrix: LinkProbabilityEntry[] = [];
  let entropy = 0;

  for (let i = 0; i < inputs.length; i++) {
    for (let j = 0; j < nOutputsReal; j++) {
      const count = linkCount[i][j];
      if (count === 0) continue;
      const p = count / interpretationCount;
      linkMatrix.push({
        inputIndex: i,
        outputIndex: j,
        inputAddress: inputs[i].address,
        outputAddress: outputs[j].address,
        probability: p,
      });
      if (p > 0 && p < 1) {
        entropy -= p * Math.log2(p);
      }
      // p === 1 contributes 0 to entropy (0 * log2(1) = 0)
    }
  }

  const maxEntropy = Math.log2(
    Math.max(1, inputs.length * nOutputsReal)
  );
  const efficiency = maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 0;

  return {
    entropy,
    entropyLabel: entropyLabel(entropy),
    interpretationCount,
    tooComplex: false,
    linkMatrix,
    efficiency,
    maxEntropy,
  };
}

export function formatEntropy(bits: number): string {
  if (bits < 0) return 'N/A';
  return `${bits.toFixed(2)} bits`;
}
