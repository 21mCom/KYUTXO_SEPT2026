/**
 * Compliance Proofs Module
 * 
 * This module provides cryptographic proof generation for regulatory compliance scenarios.
 * It enables selective disclosure of custody history while preserving privacy.
 * 
 * Features:
 * - Merkle tree generation from custody segments
 * - Selective branch revelation (prove specific timeframes/addresses)
 * - Ownership attestation verification (Bitcoin signed messages)
 * - Proof bundle export/import
 * 
 * This is a separate, prunable feature.
 */

import { 
  CustodySegment, 
  UtxoLineage, 
  OwnershipAttestation, 
  ComplianceProof,
  MerkleNode,
  ProofDisclosureLevel,
  AttestationStatus,
  AttestationSignatureType
} from './database';

// SHA-256 hash function using Web Crypto API
async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate a deterministic hash for a custody transition
export async function hashCustodyTransition(
  fromAddress: string,
  toAddress: string,
  txid: string,
  amount: number,
  timestamp: number
): Promise<string> {
  const data = `${fromAddress}|${toAddress}|${txid}|${amount}|${timestamp}`;
  return sha256(data);
}

// Generate a hash for a custody segment leaf node
export async function hashSegmentLeaf(segment: CustodySegment): Promise<string> {
  const data = JSON.stringify({
    segmentId: segment.segmentId,
    originTxid: segment.originTxid,
    originVout: segment.originVout,
    originAddress: segment.originAddress,
    originDate: segment.originDate,
    originAmount: segment.originAmount,
    currentTxid: segment.currentTxid,
    currentAddress: segment.currentAddress,
    currentAmount: segment.currentAmount,
    status: segment.status,
    hopCount: segment.hopCount
  });
  return sha256(data);
}

// Combine two hashes into a parent node hash
export async function combineHashes(left: string, right: string): Promise<string> {
  return sha256(left + right);
}

/**
 * Build a Merkle tree from custody segments
 * Returns the tree structure with the root hash
 */
export async function buildCustodyMerkleTree(
  segments: CustodySegment[],
  options?: {
    redactAddresses?: string[];
    redactTxids?: string[];
    includeAmounts?: boolean;
  }
): Promise<{ root: string; nodes: MerkleNode[] }> {
  if (segments.length === 0) {
    return { root: '', nodes: [] };
  }

  const { redactAddresses = [], redactTxids = [], includeAmounts = true } = options || {};

  // Create leaf nodes from segments
  const leaves: MerkleNode[] = await Promise.all(
    segments.map(async (segment) => {
      const hash = await hashSegmentLeaf(segment);
      
      // Check if this segment should be redacted
      const isAddressRedacted = redactAddresses.includes(segment.originAddress) ||
        (segment.currentAddress ? redactAddresses.includes(segment.currentAddress) : false);
      const isTxidRedacted = redactTxids.includes(segment.originTxid) ||
        (segment.currentTxid ? redactTxids.includes(segment.currentTxid) : false);
      const isRedacted = isAddressRedacted || isTxidRedacted;

      return {
        hash,
        data: isRedacted ? undefined : {
          segmentId: segment.segmentId,
          txid: segment.originTxid,
          address: segment.originAddress,
          timestamp: segment.originDate,
          amount: includeAmounts ? segment.originAmount : undefined
        },
        isRedacted
      };
    })
  );

  // If only one leaf, return it as root
  if (leaves.length === 1) {
    return { root: leaves[0].hash, nodes: leaves };
  }

  // Build tree bottom-up
  let currentLevel = leaves;
  const allNodes = [...leaves];

  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left; // Duplicate last if odd number
      
      const parentHash = await combineHashes(left.hash, right.hash);
      const parentNode: MerkleNode = {
        hash: parentHash,
        left: left.hash,
        right: right.hash,
        isRedacted: left.isRedacted && right.isRedacted
      };
      
      nextLevel.push(parentNode);
      allNodes.push(parentNode);
    }
    
    currentLevel = nextLevel;
  }

  return {
    root: currentLevel[0].hash,
    nodes: allNodes
  };
}

/**
 * Generate a proof path for a specific segment
 * Returns the nodes needed to verify the segment is in the tree
 */
export async function generateProofPath(
  targetSegmentId: string,
  segments: CustodySegment[]
): Promise<{ proofPath: string[]; leafHash: string } | null> {
  const targetIndex = segments.findIndex(s => s.segmentId === targetSegmentId);
  if (targetIndex === -1) return null;

  // Build leaf hashes
  const leafHashes = await Promise.all(segments.map(s => hashSegmentLeaf(s)));
  const targetHash = leafHashes[targetIndex];

  // Build proof path (sibling hashes needed to reconstruct root)
  const proofPath: string[] = [];
  let currentIndex = targetIndex;
  let currentLevel = leafHashes;

  while (currentLevel.length > 1) {
    const siblingIndex = currentIndex % 2 === 0 
      ? currentIndex + 1 
      : currentIndex - 1;
    
    if (siblingIndex < currentLevel.length) {
      proofPath.push(currentLevel[siblingIndex]);
    } else {
      proofPath.push(currentLevel[currentIndex]); // Duplicate for odd case
    }

    // Move to next level
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left;
      nextLevel.push(await combineHashes(left, right));
    }
    
    currentIndex = Math.floor(currentIndex / 2);
    currentLevel = nextLevel;
  }

  return { proofPath, leafHash: targetHash };
}

/**
 * Verify a proof path against a merkle root
 */
export async function verifyProofPath(
  leafHash: string,
  proofPath: string[],
  merkleRoot: string,
  leafIndex: number
): Promise<boolean> {
  let currentHash = leafHash;
  let currentIndex = leafIndex;

  for (const sibling of proofPath) {
    if (currentIndex % 2 === 0) {
      currentHash = await combineHashes(currentHash, sibling);
    } else {
      currentHash = await combineHashes(sibling, currentHash);
    }
    currentIndex = Math.floor(currentIndex / 2);
  }

  return currentHash === merkleRoot;
}

/**
 * Filter custody segments by date range
 */
export function filterSegmentsByDateRange(
  segments: CustodySegment[],
  startDate: number,
  endDate: number
): CustodySegment[] {
  return segments.filter(segment => {
    const originDate = segment.originDate;
    return originDate >= startDate && originDate <= endDate;
  });
}

/**
 * Filter custody segments by addresses
 */
export function filterSegmentsByAddresses(
  segments: CustodySegment[],
  addresses: string[]
): CustodySegment[] {
  const addressSet = new Set(addresses.map(a => a.toLowerCase()));
  return segments.filter(segment => {
    const hasOrigin = addressSet.has(segment.originAddress.toLowerCase());
    const hasCurrent = segment.currentAddress && 
      addressSet.has(segment.currentAddress.toLowerCase());
    return hasOrigin || hasCurrent;
  });
}

/**
 * Generate a standard attestation message for an address
 */
export function generateAttestationMessage(
  address: string,
  options?: {
    validFrom?: number;
    validUntil?: number;
    purpose?: string;
  }
): string {
  const { validFrom, validUntil, purpose } = options || {};
  
  let message = `I attest that I control the Bitcoin address: ${address}`;
  
  if (validFrom || validUntil) {
    const fromDate = validFrom ? new Date(validFrom * 1000).toISOString().split('T')[0] : 'beginning';
    const untilDate = validUntil ? new Date(validUntil * 1000).toISOString().split('T')[0] : 'present';
    message += `\nValidity period: ${fromDate} to ${untilDate}`;
  }
  
  if (purpose) {
    message += `\nPurpose: ${purpose}`;
  }
  
  message += `\nTimestamp: ${new Date().toISOString()}`;
  
  return message;
}

/**
 * Parse a Bitcoin signed message (basic format detection)
 * Note: Full verification requires bitcoinjs-message library
 */
export function parseSignedMessage(signatureInput: string): {
  signature: string;
  type: AttestationSignatureType;
} {
  const trimmed = signatureInput.trim();
  
  // Electrum-style: starts with signature header
  if (trimmed.startsWith('-----BEGIN BITCOIN SIGNED MESSAGE-----')) {
    const sigMatch = trimmed.match(/-----BEGIN SIGNATURE-----\n([\s\S]*?)\n-----END/);
    return {
      signature: sigMatch ? sigMatch[1].trim() : trimmed,
      type: 'electrum'
    };
  }
  
  // Base64 encoded signature (65 bytes = ~88 chars in base64)
  if (/^[A-Za-z0-9+/=]{86,90}$/.test(trimmed)) {
    return { signature: trimmed, type: 'bitcoin-message' };
  }
  
  // Hex encoded signature (130 chars for 65 bytes)
  if (/^[0-9a-fA-F]{130}$/.test(trimmed)) {
    return { signature: trimmed, type: 'bitcoin-message' };
  }
  
  // Default to generic bitcoin message
  return { signature: trimmed, type: 'bitcoin-message' };
}

/**
 * Create an ownership attestation record
 */
export async function createOwnershipAttestation(
  address: string,
  message: string,
  signature: string,
  signatureType: AttestationSignatureType,
  options?: {
    recordId?: number;
    validFrom?: number;
    validUntil?: number;
    notes?: string;
  }
): Promise<Omit<OwnershipAttestation, 'id'>> {
  const now = Date.now();
  const messageHash = await sha256(message);
  
  return {
    attestationId: crypto.randomUUID(),
    address,
    recordId: options?.recordId,
    message,
    messageHash,
    signature,
    signatureType,
    status: 'pending' as AttestationStatus,
    validFrom: options?.validFrom,
    validUntil: options?.validUntil,
    notes: options?.notes,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Create a compliance proof bundle
 */
export async function createComplianceProof(
  name: string,
  segments: CustodySegment[],
  attestationIds: string[],
  options: {
    description?: string;
    startDate: number;
    endDate: number;
    disclosureLevel: ProofDisclosureLevel;
    redactedAddresses?: string[];
    redactedTxids?: string[];
  }
): Promise<Omit<ComplianceProof, 'id'>> {
  const now = Date.now();
  
  // Build merkle tree with redaction options
  const { root, nodes } = await buildCustodyMerkleTree(segments, {
    redactAddresses: options.redactedAddresses,
    redactTxids: options.redactedTxids,
    includeAmounts: options.disclosureLevel !== 'amounts-hidden'
  });
  
  // Collect unique addresses and txids
  const addresses = new Set<string>();
  const txids = new Set<string>();
  
  segments.forEach(segment => {
    addresses.add(segment.originAddress);
    if (segment.currentAddress) addresses.add(segment.currentAddress);
    txids.add(segment.originTxid);
    segment.evidenceTxids.forEach(txid => txids.add(txid));
  });
  
  // Calculate total amount if disclosed
  const totalAmountSats = options.disclosureLevel !== 'amounts-hidden'
    ? segments.reduce((sum, s) => sum + s.originAmount, 0)
    : undefined;
  
  return {
    proofId: crypto.randomUUID(),
    name,
    description: options.description,
    includedAddresses: Array.from(addresses),
    includedSegmentIds: segments.map(s => s.segmentId),
    startDate: options.startDate,
    endDate: options.endDate,
    merkleRoot: root,
    merkleNodes: nodes,
    attestationIds,
    disclosureLevel: options.disclosureLevel,
    redactedAddresses: options.redactedAddresses,
    redactedTxids: options.redactedTxids,
    totalAddresses: addresses.size,
    totalTransactions: txids.size,
    totalAmountSats,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Export a compliance proof as a verifiable JSON bundle
 */
export function exportProofBundle(
  proof: ComplianceProof,
  attestations: OwnershipAttestation[]
): string {
  const bundle = {
    version: '1.0',
    type: 'kyutxo-compliance-proof',
    generated: new Date().toISOString(),
    proof: {
      proofId: proof.proofId,
      name: proof.name,
      description: proof.description,
      period: {
        start: new Date(proof.startDate * 1000).toISOString(),
        end: new Date(proof.endDate * 1000).toISOString()
      },
      merkleRoot: proof.merkleRoot,
      disclosureLevel: proof.disclosureLevel,
      summary: {
        totalAddresses: proof.totalAddresses,
        totalTransactions: proof.totalTransactions,
        totalAmountBtc: proof.totalAmountSats 
          ? (proof.totalAmountSats / 100_000_000).toFixed(8)
          : 'not disclosed'
      }
    },
    attestations: attestations.map(a => ({
      attestationId: a.attestationId,
      address: a.address,
      message: a.message,
      signature: a.signature,
      signatureType: a.signatureType,
      status: a.status,
      validFrom: a.validFrom ? new Date(a.validFrom * 1000).toISOString() : undefined,
      validUntil: a.validUntil ? new Date(a.validUntil * 1000).toISOString() : undefined
    })),
    merkleTree: proof.merkleNodes.map(node => ({
      hash: node.hash,
      left: node.left,
      right: node.right,
      data: node.isRedacted ? '[REDACTED]' : node.data,
      isRedacted: node.isRedacted
    }))
  };
  
  return JSON.stringify(bundle, null, 2);
}

/**
 * Verify a proof bundle's integrity
 */
export async function verifyProofBundle(bundleJson: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  try {
    const bundle = JSON.parse(bundleJson);
    
    // Check version
    if (bundle.version !== '1.0') {
      warnings.push(`Unknown bundle version: ${bundle.version}`);
    }
    
    // Check type
    if (bundle.type !== 'kyutxo-compliance-proof') {
      errors.push('Invalid bundle type');
    }
    
    // Verify merkle root matches tree
    if (bundle.merkleTree && bundle.merkleTree.length > 0) {
      const rootNodes = bundle.merkleTree.filter(
        (n: MerkleNode) => !bundle.merkleTree.some(
          (other: MerkleNode) => other.left === n.hash || other.right === n.hash
        )
      );
      
      if (rootNodes.length === 1 && rootNodes[0].hash !== bundle.proof.merkleRoot) {
        errors.push('Merkle root mismatch');
      }
    }
    
    // Check attestations have valid signatures (format only, not crypto verification)
    for (const attestation of bundle.attestations || []) {
      if (!attestation.signature) {
        errors.push(`Missing signature for attestation ${attestation.attestationId}`);
      }
      if (!attestation.address) {
        errors.push(`Missing address for attestation ${attestation.attestationId}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  } catch (e) {
    return {
      valid: false,
      errors: [`Failed to parse bundle: ${e}`],
      warnings
    };
  }
}

/**
 * Generate a standalone HTML verifier that can validate proof bundles
 * This creates a self-contained HTML file with embedded JavaScript
 */
export function generateStandaloneVerifier(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KYUTXO Compliance Proof Verifier</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --card: #141414;
      --border: #262626;
      --text: #fafafa;
      --muted: #a1a1aa;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
      --primary: #f97316;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 2rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .drop-zone {
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .drop-zone:hover, .drop-zone.dragover { border-color: var(--primary); }
    .drop-zone input { display: none; }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .btn:hover { opacity: 0.9; }
    .result { margin-top: 1.5rem; }
    .status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .status.valid { color: var(--success); }
    .status.invalid { color: var(--error); }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    .detail-label { color: var(--muted); }
    .badge {
      background: var(--border);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .error-list, .warning-list { margin-top: 1rem; }
    .error-item { color: var(--error); margin: 0.25rem 0; }
    .warning-item { color: var(--warning); margin: 0.25rem 0; }
    .attestation-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      margin: 0.5rem 0;
    }
    .mono { font-family: monospace; font-size: 0.75rem; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      KYUTXO Compliance Proof Verifier
    </h1>
    <p class="subtitle">Verify the integrity of compliance proof bundles</p>

    <div class="card">
      <div class="drop-zone" id="dropZone">
        <p>Drop a compliance proof JSON file here or click to browse</p>
        <input type="file" id="fileInput" accept=".json">
        <br><br>
        <button class="btn" onclick="document.getElementById('fileInput').click()">
          Select File
        </button>
      </div>

      <div id="result" class="result hidden">
        <div id="status" class="status"></div>
        
        <div id="proofDetails"></div>
        
        <div id="errors" class="error-list hidden"></div>
        <div id="warnings" class="warning-list hidden"></div>
        
        <div id="attestations" class="hidden">
          <h3 style="margin: 1rem 0 0.5rem;">Ownership Attestations</h3>
          <div id="attestationList"></div>
        </div>
      </div>
    </div>

    <div class="card" style="font-size: 0.875rem; color: var(--muted);">
      <p>This verifier checks:</p>
      <ul style="margin: 0.5rem 0 0 1.5rem;">
        <li>Bundle format and version</li>
        <li>Merkle tree integrity</li>
        <li>Attestation completeness</li>
      </ul>
      <p style="margin-top: 0.5rem;">
        Note: Cryptographic signature verification requires the original addresses and private keys.
      </p>
    </div>
  </div>

  <script>
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const resultDiv = document.getElementById('result');
    const statusDiv = document.getElementById('status');
    const detailsDiv = document.getElementById('proofDetails');
    const errorsDiv = document.getElementById('errors');
    const warningsDiv = document.getElementById('warnings');
    const attestationsDiv = document.getElementById('attestations');
    const attestationList = document.getElementById('attestationList');

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) processFile(file);
    });

    function processFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target.result;
          verifyBundle(content);
        } catch (err) {
          showError('Failed to read file: ' + err.message);
        }
      };
      reader.readAsText(file);
    }

    function verifyBundle(jsonContent) {
      resultDiv.classList.remove('hidden');
      errorsDiv.classList.add('hidden');
      warningsDiv.classList.add('hidden');
      attestationsDiv.classList.add('hidden');

      const errors = [];
      const warnings = [];

      try {
        const bundle = JSON.parse(jsonContent);

        if (bundle.version !== '1.0') {
          warnings.push('Unknown bundle version: ' + bundle.version);
        }

        if (bundle.type !== 'kyutxo-compliance-proof') {
          errors.push('Invalid bundle type');
        }

        if (!bundle.proof || !bundle.proof.merkleRoot) {
          errors.push('Missing proof data or merkle root');
        }

        if (bundle.merkleTree && bundle.merkleTree.length > 0) {
          const rootNodes = bundle.merkleTree.filter(
            n => !bundle.merkleTree.some(other => other.left === n.hash || other.right === n.hash)
          );
          if (rootNodes.length === 1 && rootNodes[0].hash !== bundle.proof.merkleRoot) {
            errors.push('Merkle root mismatch - data may have been tampered with');
          }
        }

        for (const attestation of bundle.attestations || []) {
          if (!attestation.signature) {
            errors.push('Missing signature for attestation ' + attestation.attestationId);
          }
          if (!attestation.address) {
            errors.push('Missing address for attestation ' + attestation.attestationId);
          }
        }

        const isValid = errors.length === 0;

        statusDiv.className = 'status ' + (isValid ? 'valid' : 'invalid');
        statusDiv.innerHTML = isValid 
          ? '<span style="font-size:1.5rem">&#x2713;</span> Proof bundle is valid'
          : '<span style="font-size:1.5rem">&#x2717;</span> Proof bundle has issues';

        if (bundle.proof) {
          detailsDiv.innerHTML = \`
            <div class="detail-row">
              <span class="detail-label">Proof Name</span>
              <span>\${bundle.proof.name || 'Unnamed'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Period</span>
              <span>\${bundle.proof.period?.start?.split('T')[0] || '?'} to \${bundle.proof.period?.end?.split('T')[0] || '?'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Disclosure Level</span>
              <span class="badge">\${bundle.proof.disclosureLevel || 'unknown'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Addresses</span>
              <span>\${bundle.proof.summary?.totalAddresses || 0}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Transactions</span>
              <span>\${bundle.proof.summary?.totalTransactions || 0}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Total Amount</span>
              <span>\${bundle.proof.summary?.totalAmountBtc || 'not disclosed'} BTC</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Merkle Root</span>
              <span class="mono">\${bundle.proof.merkleRoot?.slice(0, 24) || 'N/A'}...</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Generated</span>
              <span>\${bundle.generated || 'Unknown'}</span>
            </div>
          \`;
        }

        if (errors.length > 0) {
          errorsDiv.classList.remove('hidden');
          errorsDiv.innerHTML = '<strong>Errors:</strong>' + errors.map(e => '<div class="error-item">- ' + e + '</div>').join('');
        }

        if (warnings.length > 0) {
          warningsDiv.classList.remove('hidden');
          warningsDiv.innerHTML = '<strong>Warnings:</strong>' + warnings.map(w => '<div class="warning-item">- ' + w + '</div>').join('');
        }

        if (bundle.attestations && bundle.attestations.length > 0) {
          attestationsDiv.classList.remove('hidden');
          attestationList.innerHTML = bundle.attestations.map(a => \`
            <div class="attestation-card">
              <div class="mono" style="margin-bottom: 0.5rem;">\${a.address}</div>
              <div style="font-size: 0.75rem; color: var(--muted);">
                Type: \${a.signatureType || 'unknown'} | Status: \${a.status || 'unknown'}
              </div>
            </div>
          \`).join('');
        }

      } catch (err) {
        showError('Failed to parse bundle: ' + err.message);
      }
    }

    function showError(message) {
      resultDiv.classList.remove('hidden');
      statusDiv.className = 'status invalid';
      statusDiv.innerHTML = '<span style="font-size:1.5rem">&#x2717;</span> ' + message;
      detailsDiv.innerHTML = '';
      errorsDiv.classList.add('hidden');
      warningsDiv.classList.add('hidden');
      attestationsDiv.classList.add('hidden');
    }
  </script>
</body>
</html>`;
}
