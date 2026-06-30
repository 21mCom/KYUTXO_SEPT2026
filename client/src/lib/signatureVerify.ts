/**
 * Offline Bitcoin signed-message verification for Proof of Funds declarations.
 *
 * Supports the legacy Bitcoin Signed Message format (used by Bitcoin Core,
 * Electrum, BlueWallet, Sparrow, Trezor, Ledger, and most hardware/software
 * wallets) for the following address types:
 *
 *   - P2PKH (legacy 1… addresses)  — header bytes 27–34
 *   - P2SH-P2WPKH (3… addresses)  — header bytes 35–38
 *   - P2WPKH (native SegWit bc1q…) — header bytes 39–42, or 31–34 from
 *                                    wallets that sign SegWit with the
 *                                    compressed-P2PKH header
 *
 * P2TR (Taproot, bc1p…) addresses are verified using BIP-322 "Simple"
 * single-key-spend Schnorr signatures (the base64 witness produced by
 * Bitcoin Core 24+, Sparrow, and other BIP-322 capable wallets).
 *
 * No private keys, seeds, or network access are involved — only public
 * addresses and signatures.
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

bitcoin.initEccLib(ecc);

/**
 * Which signing scheme verified an address's control.
 *   - 'legacy'  → Bitcoin Signed Message (BIP-137 style, P2PKH/P2SH/P2WPKH)
 *   - 'bip322'  → BIP-322 Simple Schnorr witness (Taproot / P2TR)
 */
export type SignatureFormat = 'legacy' | 'bip322';

/** Human-readable label for a signature format, used in the UI and PDF. */
export function signatureFormatLabel(format: SignatureFormat): string {
  return format === 'bip322'
    ? 'BIP-322 (Taproot / Schnorr)'
    : 'Bitcoin Signed Message';
}

export interface VerificationResult {
  verified: boolean;
  error?: string;
  /** The scheme used when verification succeeded. */
  format?: SignatureFormat;
}

/**
 * Build the Bitcoin Signed Message hash.
 * Protocol: SHA256d("\x18Bitcoin Signed Message:\n" + varint(len) + message)
 */
async function buildMessageHash(message: string): Promise<Uint8Array> {
  const MAGIC = 'Bitcoin Signed Message:\n';
  const enc = new TextEncoder();
  const magicBytes = enc.encode(MAGIC);
  const msgBytes = enc.encode(message);

  const viSize = msgBytes.length < 253 ? 1 : 3;
  const buf = new Uint8Array(1 + magicBytes.length + viSize + msgBytes.length);
  let offset = 0;

  buf[offset++] = magicBytes.length;
  buf.set(magicBytes, offset);
  offset += magicBytes.length;

  if (msgBytes.length < 253) {
    buf[offset++] = msgBytes.length;
  } else {
    buf[offset++] = 253;
    buf[offset++] = msgBytes.length & 0xff;
    buf[offset++] = (msgBytes.length >> 8) & 0xff;
  }

  buf.set(msgBytes, offset);

  const h1 = await crypto.subtle.digest('SHA-256', buf);
  const h2 = await crypto.subtle.digest('SHA-256', h1);
  return new Uint8Array(h2);
}

/**
 * Verify a Bitcoin signed-message signature against an address and message.
 *
 * @param address   Bitcoin address (P2PKH, P2SH-P2WPKH, or P2WPKH)
 * @param message   The exact message that was signed (challenge text)
 * @param sigBase64 Base64-encoded 65-byte signature from the wallet
 */
export async function verifyBitcoinSignature(
  address: string,
  message: string,
  sigBase64: string,
): Promise<VerificationResult> {
  if (!address.trim() || !message.trim() || !sigBase64.trim()) {
    return { verified: false, error: 'Address, message, and signature are all required.' };
  }

  // Taproot (P2TR) addresses use BIP-322 Simple Schnorr signatures, not the
  // legacy Bitcoin Signed Message format handled below.
  const trimmedAddr = address.trim();
  if (
    trimmedAddr.startsWith('bc1p') ||
    trimmedAddr.startsWith('tb1p') ||
    trimmedAddr.startsWith('bcrt1p')
  ) {
    return verifyBip322Simple(trimmedAddr, message, sigBase64);
  }

  let sigBytes: Uint8Array;
  try {
    const binary = atob(sigBase64.trim());
    sigBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) sigBytes[i] = binary.charCodeAt(i);
  } catch {
    return { verified: false, error: 'Invalid signature: could not decode base64.' };
  }

  if (sigBytes.length !== 65) {
    return {
      verified: false,
      error: `Invalid signature length: expected 65 bytes, got ${sigBytes.length}. Make sure you copied the full base64 signature from your wallet.`,
    };
  }

  const header = sigBytes[0];

  if (header < 27 || header > 42) {
    return {
      verified: false,
      error: `Unrecognised signature header byte ${header}. This signature was not produced by a standard Bitcoin wallet's "Sign Message" function.`,
    };
  }

  const recovery = (header - 27) & 3;
  const compressed = header - 27 >= 4;
  const sig64 = sigBytes.slice(1);

  let msgHash: Uint8Array;
  try {
    msgHash = await buildMessageHash(message);
  } catch {
    return { verified: false, error: 'Failed to compute message hash.' };
  }

  let pubKey: Uint8Array | null;
  try {
    pubKey = ecc.recover(msgHash, sig64, recovery as 0 | 1 | 2 | 3, compressed);
  } catch {
    return { verified: false, error: 'Signature recovery failed — the signature bytes may be corrupt.' };
  }

  if (!pubKey) {
    return { verified: false, error: 'Could not recover a public key from this signature. The signature may be invalid or corrupt.' };
  }

  const network = bitcoin.networks.bitcoin;
  // bitcoinjs-lib v7 accepts a Uint8Array pubkey directly. Do NOT wrap in
  // Buffer.from(...) — the Buffer global is not available in the browser and
  // would throw "Buffer is not defined", failing verification at runtime.
  const candidates: string[] = [];

  try {
    if (compressed) {
      candidates.push(bitcoin.payments.p2wpkh({ pubkey: pubKey, network }).address!);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubKey, network });
      candidates.push(bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address!);
    }
    candidates.push(bitcoin.payments.p2pkh({ pubkey: pubKey, network }).address!);
  } catch (err) {
    return {
      verified: false,
      error: `Address derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (candidates.includes(address)) {
    return { verified: true, format: 'legacy' };
  }

  return {
    verified: false,
    error:
      'The signature is cryptographically valid, but it was not produced by the key controlling this address. ' +
      'Make sure you signed with the wallet that holds this exact address.',
  };
}

const BIP322_TAG = 'BIP0322-signed-message';

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/**
 * BIP-322 message hash (BIP-340 tagged hash):
 *   SHA256(SHA256(tag) || SHA256(tag) || message), tag = "BIP0322-signed-message"
 */
async function bip322MessageHash(message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const tagHash = await sha256(enc.encode(BIP322_TAG));
  const msgBytes = enc.encode(message);
  const buf = new Uint8Array(tagHash.length * 2 + msgBytes.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(msgBytes, tagHash.length * 2);
  return sha256(buf);
}

/** Read a Bitcoin-style CompactSize varint from `buf` at `offset`. */
function readVarInt(buf: Uint8Array, offset: number): { value: number; size: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: dv.getUint16(offset + 1, true), size: 3 };
  if (first === 0xfe) return { value: dv.getUint32(offset + 1, true), size: 5 };
  return { value: Number(dv.getBigUint64(offset + 1, true)), size: 9 };
}

/** Parse a serialized witness stack (count-prefixed, length-prefixed items). */
function parseWitnessStack(buf: Uint8Array): Uint8Array[] {
  let offset = 0;
  const { value: count, size } = readVarInt(buf, offset);
  offset += size;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const { value: len, size: lenSize } = readVarInt(buf, offset);
    offset += lenSize;
    if (offset + len > buf.length) {
      throw new Error('Witness item length exceeds available data.');
    }
    items.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  if (offset !== buf.length) {
    throw new Error('Trailing bytes after witness stack.');
  }
  return items;
}

/**
 * Verify a BIP-322 "Simple" single-key-spend signature for a Taproot (P2TR)
 * address. Accepts the base64 witness produced by Bitcoin Core 24+, Sparrow,
 * and other BIP-322 capable wallets.
 *
 * Implements the BIP-322 virtual to_spend / to_sign transaction construction
 * and validates the Schnorr signature against the address's x-only output key
 * (BIP-341 key-path sighash). Script-path spends and multi-item witnesses
 * (BIP-322 "Full") are not supported and produce a clear error.
 */
export async function verifyBip322Simple(
  address: string,
  message: string,
  sigBase64: string,
): Promise<VerificationResult> {
  let outputKey: Uint8Array;
  try {
    const decoded = bitcoin.address.fromBech32(address.trim());
    if (decoded.version !== 1 || decoded.data.length !== 32) {
      return {
        verified: false,
        error: 'Address is not a valid Taproot (P2TR) output (expected witness v1, 32-byte key).',
      };
    }
    outputKey = decoded.data;
  } catch {
    return { verified: false, error: 'Could not decode the Taproot address.' };
  }

  let witnessBytes: Uint8Array;
  try {
    const binary = atob(sigBase64.trim());
    witnessBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) witnessBytes[i] = binary.charCodeAt(i);
  } catch {
    return { verified: false, error: 'Signature is not valid base64.' };
  }

  let witness: Uint8Array[];
  try {
    witness = parseWitnessStack(witnessBytes);
  } catch {
    return {
      verified: false,
      error: 'Could not parse the BIP-322 witness. Paste the full base64 signature from your wallet.',
    };
  }

  if (witness.length !== 1) {
    return {
      verified: false,
      error:
        'Only BIP-322 Simple single-key-spend signatures are supported. ' +
        'This witness has ' + witness.length + ' items (script-path / "Full" BIP-322 is not supported).',
    };
  }

  let sig = witness[0];
  let hashType = 0x00;
  if (sig.length === 65) {
    hashType = sig[64];
    sig = sig.subarray(0, 64);
  } else if (sig.length !== 64) {
    return {
      verified: false,
      error: `Unexpected BIP-322 signature length (${sig.length} bytes; expected 64 or 65).`,
    };
  }

  try {
    const spk = new Uint8Array(34);
    spk[0] = 0x51; // OP_1
    spk[1] = 0x20; // push 32 bytes
    spk.set(outputKey, 2);

    const msgHash = await bip322MessageHash(message);
    const scriptSig = new Uint8Array(34);
    scriptSig[0] = 0x00; // OP_0
    scriptSig[1] = 0x20; // push 32 bytes
    scriptSig.set(msgHash, 2);

    const toSpend = new bitcoin.Transaction();
    toSpend.version = 0;
    toSpend.locktime = 0;
    toSpend.addInput(new Uint8Array(32), 0xffffffff, 0, scriptSig);
    toSpend.addOutput(spk, BigInt(0));

    const toSign = new bitcoin.Transaction();
    toSign.version = 0;
    toSign.locktime = 0;
    toSign.addInput(toSpend.getHash(), 0, 0);
    toSign.addOutput(new Uint8Array([0x6a]), BigInt(0)); // OP_RETURN

    const sighash = toSign.hashForWitnessV1(0, [spk], [BigInt(0)], hashType);
    const ok = ecc.verifySchnorr(sighash, outputKey, sig);
    if (ok) {
      return { verified: true, format: 'bip322' };
    }
    return {
      verified: false,
      error:
        'The BIP-322 signature did not verify against this address. ' +
        'Make sure the message matches exactly and that you signed with the wallet holding this address.',
    };
  } catch (err) {
    return {
      verified: false,
      error: `BIP-322 verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build the deterministic human-readable challenge message for a given
 * address and declaration context.
 *
 * The message is tied to the declaration nonce so it cannot be silently
 * reused across different declarations.
 */
export function buildChallengeMessage(params: {
  address: string;
  declarantName: string;
  declarationDate: string;
  purpose: string;
  nonce: string;
}): string {
  const { address, declarantName, declarationDate, purpose, nonce } = params;
  return [
    'I certify that I control the following Bitcoin address.',
    '',
    `Declarant: ${declarantName || '(name not yet entered)'}`,
    `Purpose:   ${purpose || '(purpose not yet entered)'}`,
    `Date:      ${declarationDate || '(date not yet set)'}`,
    `Reference: ${nonce}`,
    `Address:   ${address}`,
    '',
    'Generated by KYUTXO for a Proof of Funds Declaration.',
  ].join('\n');
}

/**
 * Generate a random 8-byte hex nonce for use as a declaration reference.
 */
export function generateDeclarationNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
