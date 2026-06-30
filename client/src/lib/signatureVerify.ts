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
 * P2TR (Taproot) requires BIP-322 Schnorr verification which is not
 * supported here; a clear error is returned for those addresses.
 *
 * No private keys, seeds, or network access are involved — only public
 * addresses and signatures.
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

bitcoin.initEccLib(ecc);

export interface VerificationResult {
  verified: boolean;
  error?: string;
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

  if (address.startsWith('bc1p') || address.startsWith('tb1p')) {
    return {
      verified: false,
      error:
        'Taproot (P2TR / bc1p…) addresses use BIP-322 Schnorr signatures, which are not supported in this version. ' +
        'Use a P2PKH (1…) or native SegWit P2WPKH (bc1q…) address for cryptographic proof-of-control.',
    };
  }

  const network = bitcoin.networks.bitcoin;
  const pubKeyBuf = Buffer.from(pubKey);

  const candidates: string[] = [];

  try {
    if (compressed) {
      candidates.push(bitcoin.payments.p2wpkh({ pubkey: pubKeyBuf, network }).address!);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubKeyBuf, network });
      candidates.push(bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address!);
    }
    candidates.push(bitcoin.payments.p2pkh({ pubkey: pubKeyBuf, network }).address!);
  } catch (err) {
    return {
      verified: false,
      error: `Address derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (candidates.includes(address)) {
    return { verified: true };
  }

  return {
    verified: false,
    error:
      'The signature is cryptographically valid, but it was not produced by the key controlling this address. ' +
      'Make sure you signed with the wallet that holds this exact address.',
  };
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
