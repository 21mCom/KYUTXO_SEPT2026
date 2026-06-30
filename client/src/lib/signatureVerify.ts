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
 * In addition, BIP-322 "Simple" single-key-spend signatures (the base64
 * witness produced by Bitcoin Core 24+, Sparrow, and other BIP-322 capable
 * wallets) are verified for:
 *
 *   - P2TR  (Taproot, bc1p…)   — Schnorr signature over the BIP-341 key-path
 *                                sighash
 *   - P2WPKH (native SegWit bc1q…) — ECDSA signature over the BIP-143 sighash
 *
 * For bc1q addresses the legacy Bitcoin Signed Message (65-byte) path is still
 * used when a 65-byte signature is pasted; anything else is treated as a
 * BIP-322 witness, so both formats are accepted.
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
 *   - 'bip322'  → BIP-322 Simple witness (Taproot Schnorr or SegWit ECDSA)
 */
export type SignatureFormat = 'legacy' | 'bip322';

/** Human-readable label for a signature format, used in the UI and PDF. */
export function signatureFormatLabel(format: SignatureFormat): string {
  // "BIP-322" covers both Simple (single-key) and Full (script-path / multisig)
  // witnesses, so the label stays accurate for either kind of proof.
  return format === 'bip322'
    ? 'BIP-322'
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

  // Native SegWit v0 (bc1q…) addresses are either P2WPKH (20-byte program) or
  // P2WSH (32-byte program — multisig / miniscript vaults). P2WSH is always a
  // BIP-322 "Full" script-path spend, so route it to the Full verifier.
  if (
    trimmedAddr.startsWith('bc1q') ||
    trimmedAddr.startsWith('tb1q') ||
    trimmedAddr.startsWith('bcrt1q')
  ) {
    let programLen = -1;
    try {
      programLen = bitcoin.address.fromBech32(trimmedAddr).data.length;
    } catch {
      programLen = -1;
    }
    if (programLen === 32) {
      return verifyBip322Full(trimmedAddr, message, sigBase64);
    }

    // P2WPKH (bc1q…) can carry either a legacy BIP-137 signature (exactly 65
    // bytes) or a BIP-322 "Simple" witness (signature + public key, always
    // longer than 65 bytes). Route by the decoded signature length: 65-byte
    // signatures keep using the legacy path below; anything else is a BIP-322
    // witness.
    let decodedLen = -1;
    try {
      decodedLen = atob(sigBase64.trim()).length;
    } catch {
      decodedLen = -1;
    }
    if (decodedLen !== 65) {
      return verifyBip322P2WPKH(trimmedAddr, message, sigBase64);
    }
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
    // A multi-item witness is a BIP-322 "Full" script-path spend (e.g. a
    // Taproot multisig / tapscript vault). Hand it to the Full verifier.
    return verifyBip322Full(address, message, sigBase64);
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

/** Constant-time-ish byte comparison for short fixed-length arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Concatenate a list of byte chunks into a single Uint8Array. */
function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode a length as a Bitcoin CompactSize varint (lengths used here are small). */
function compactSizeEncode(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([
    0xfe,
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}

/** Lexicographic comparison of two byte arrays (returns <0, 0, or >0). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** A single parsed script element: a data push (with `data`) or a bare opcode. */
interface ScriptOp {
  op: number;
  data?: Uint8Array;
}

/**
 * Tokenize a Bitcoin script into pushes and opcodes. Data pushes carry their
 * payload in `data`; bare opcodes (e.g. OP_CHECKSIG) carry only `op`.
 */
function tokenizeScript(script: Uint8Array): ScriptOp[] {
  const ops: ScriptOp[] = [];
  let i = 0;
  const dv = new DataView(script.buffer, script.byteOffset, script.byteLength);
  while (i < script.length) {
    const op = script[i++];
    if (op === 0x00) {
      // OP_0 / OP_FALSE pushes an empty byte vector.
      ops.push({ op, data: new Uint8Array(0) });
      continue;
    }
    if (op <= 0x4b) {
      const data = script.subarray(i, i + op);
      if (data.length !== op) throw new Error('Truncated data push in script.');
      i += op;
      ops.push({ op, data });
    } else if (op === 0x4c) {
      const len = script[i++];
      const data = script.subarray(i, i + len);
      if (data.length !== len) throw new Error('Truncated OP_PUSHDATA1 in script.');
      i += len;
      ops.push({ op, data });
    } else if (op === 0x4d) {
      const len = dv.getUint16(i, true);
      i += 2;
      const data = script.subarray(i, i + len);
      if (data.length !== len) throw new Error('Truncated OP_PUSHDATA2 in script.');
      i += len;
      ops.push({ op, data });
    } else if (op === 0x4e) {
      const len = dv.getUint32(i, true);
      i += 4;
      const data = script.subarray(i, i + len);
      if (data.length !== len) throw new Error('Truncated OP_PUSHDATA4 in script.');
      i += len;
      ops.push({ op, data });
    } else {
      ops.push({ op });
    }
  }
  return ops;
}

/** Decode a minimally-encoded CScriptNum (little-endian, sign-magnitude). */
function decodeScriptNum(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  if (buf.length > 5) throw new Error('Script number too large.');
  const negative = (buf[buf.length - 1] & 0x80) !== 0;
  let result = 0;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i];
    if (i === buf.length - 1) b &= 0x7f;
    result += b * 2 ** (8 * i);
  }
  return negative ? -result : result;
}

/** Encode a number as a minimally-encoded CScriptNum byte vector. */
function encodeScriptNum(n: number): Uint8Array {
  if (n === 0) return new Uint8Array(0);
  const negative = n < 0;
  let abs = Math.abs(n);
  const bytes: number[] = [];
  while (abs > 0) {
    bytes.push(abs & 0xff);
    abs = Math.floor(abs / 256);
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return new Uint8Array(bytes);
}

/** Bitcoin Script truthiness: any non-zero byte (ignoring a trailing sign bit). */
function castToBool(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) {
      // A lone negative-zero (0x80 in the last byte) is still false.
      if (i === buf.length - 1 && buf[i] === 0x80) return false;
      return true;
    }
  }
  return false;
}

const SCRIPT_TRUE = new Uint8Array([1]);
const SCRIPT_FALSE = new Uint8Array(0);

/** Pop the top of a script stack, throwing on underflow. */
function popStack(stack: Uint8Array[]): Uint8Array {
  const v = stack.pop();
  if (v === undefined) throw new Error('Script stack underflow.');
  return v;
}

/**
 * Verify a single ECDSA signature (DER + trailing sighash-type byte) against a
 * public key, using a sighash computed for the signature's hash type.
 */
function checkEcdsaSig(
  sig: Uint8Array,
  pubkey: Uint8Array,
  computeSighash: (hashType: number) => Uint8Array,
): boolean {
  if (sig.length === 0) return false;
  let decoded: { signature: Uint8Array; hashType: number };
  try {
    decoded = bitcoin.script.signature.decode(sig);
  } catch {
    return false;
  }
  try {
    const sighash = computeSighash(decoded.hashType);
    return ecc.verify(sighash, pubkey, decoded.signature);
  } catch {
    return false;
  }
}

/**
 * Verify an m-of-n CHECKMULTISIG: each signature must match a distinct public
 * key, with both lists kept in their script order (the standard sequential
 * matching algorithm used by Bitcoin's interpreter).
 */
function checkMultisig(
  sigs: Uint8Array[],
  pubkeys: Uint8Array[],
  computeSighash: (hashType: number) => Uint8Array,
): boolean {
  let i = 0;
  let j = 0;
  while (i < sigs.length) {
    if (j >= pubkeys.length) return false;
    if (checkEcdsaSig(sigs[i], pubkeys[j], computeSighash)) i++;
    j++;
    if (sigs.length - i > pubkeys.length - j) return false;
  }
  return true;
}

/**
 * Verify a single BIP-340 Schnorr signature (tapscript): 64 bytes implies
 * SIGHASH_DEFAULT, 65 bytes carries an explicit (non-zero) sighash type.
 */
function checkSchnorrSig(
  sig: Uint8Array,
  pubkey: Uint8Array,
  computeSighash: (hashType: number) => Uint8Array,
): boolean {
  if (sig.length === 0) return false;
  if (pubkey.length !== 32) return false;
  let sig64 = sig;
  let hashType = 0x00;
  if (sig.length === 65) {
    hashType = sig[64];
    if (hashType === 0x00) return false;
    sig64 = sig.subarray(0, 64);
  } else if (sig.length !== 64) {
    return false;
  }
  try {
    const sighash = computeSighash(hashType);
    return ecc.verifySchnorr(sighash, pubkey, sig64);
  } catch {
    return false;
  }
}

/**
 * Execute a witness v0 (P2WSH) script against an initial stack from the
 * witness, returning whether the script leaves a truthy value on top.
 * Supports the standard single-key and m-of-n multisig vault scripts.
 */
function execWitnessScriptV0(
  witnessScript: Uint8Array,
  initialStack: Uint8Array[],
  computeSighash: (hashType: number) => Uint8Array,
): boolean {
  const ops = tokenizeScript(witnessScript);
  const stack = initialStack.slice();
  for (const { op, data } of ops) {
    if (data !== undefined) {
      stack.push(data);
      continue;
    }
    if (op === 0x4f) {
      stack.push(encodeScriptNum(-1));
      continue;
    }
    if (op >= 0x51 && op <= 0x60) {
      stack.push(encodeScriptNum(op - 0x50));
      continue;
    }
    switch (op) {
      case 0x69: {
        // OP_VERIFY
        if (!castToBool(popStack(stack))) return false;
        break;
      }
      case 0x87:
      case 0x88: {
        // OP_EQUAL / OP_EQUALVERIFY
        const b = popStack(stack);
        const a = popStack(stack);
        const eq = bytesEqual(a, b);
        if (op === 0x88) {
          if (!eq) return false;
        } else {
          stack.push(eq ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0x9c:
      case 0x9d: {
        // OP_NUMEQUAL / OP_NUMEQUALVERIFY
        const b = decodeScriptNum(popStack(stack));
        const a = decodeScriptNum(popStack(stack));
        const eq = a === b;
        if (op === 0x9d) {
          if (!eq) return false;
        } else {
          stack.push(eq ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0xac:
      case 0xad: {
        // OP_CHECKSIG / OP_CHECKSIGVERIFY
        const pubkey = popStack(stack);
        const sig = popStack(stack);
        const ok = checkEcdsaSig(sig, pubkey, computeSighash);
        if (op === 0xad) {
          if (!ok) return false;
        } else {
          stack.push(ok ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0xae:
      case 0xaf: {
        // OP_CHECKMULTISIG / OP_CHECKMULTISIGVERIFY
        const n = decodeScriptNum(popStack(stack));
        if (n < 0 || n > 20) throw new Error('Invalid public key count in CHECKMULTISIG.');
        const pubkeys: Uint8Array[] = [];
        for (let i = 0; i < n; i++) pubkeys.push(popStack(stack));
        pubkeys.reverse();
        const m = decodeScriptNum(popStack(stack));
        if (m < 0 || m > n) throw new Error('Invalid signature count in CHECKMULTISIG.');
        const sigs: Uint8Array[] = [];
        for (let i = 0; i < m; i++) sigs.push(popStack(stack));
        sigs.reverse();
        // Pop the extra element consumed by the CHECKMULTISIG off-by-one bug.
        popStack(stack);
        const ok = checkMultisig(sigs, pubkeys, computeSighash);
        if (op === 0xaf) {
          if (!ok) return false;
        } else {
          stack.push(ok ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      default:
        throw new Error(
          `Unsupported opcode 0x${op.toString(16)} in P2WSH witness script ` +
            '(only standard single-key and multisig scripts are supported).',
        );
    }
  }
  return stack.length > 0 && castToBool(stack[stack.length - 1]);
}

/**
 * Execute a Taproot leaf script (BIP-342 tapscript) against an initial stack
 * from the witness. Supports single-key spends and CHECKSIGADD multisig.
 */
function execTapscript(
  leafScript: Uint8Array,
  initialStack: Uint8Array[],
  computeSighash: (hashType: number) => Uint8Array,
): boolean {
  const ops = tokenizeScript(leafScript);
  const stack = initialStack.slice();
  for (const { op, data } of ops) {
    if (data !== undefined) {
      stack.push(data);
      continue;
    }
    if (op === 0x4f) {
      stack.push(encodeScriptNum(-1));
      continue;
    }
    if (op >= 0x51 && op <= 0x60) {
      stack.push(encodeScriptNum(op - 0x50));
      continue;
    }
    switch (op) {
      case 0x69: {
        // OP_VERIFY
        if (!castToBool(popStack(stack))) return false;
        break;
      }
      case 0x87:
      case 0x88: {
        // OP_EQUAL / OP_EQUALVERIFY
        const b = popStack(stack);
        const a = popStack(stack);
        const eq = bytesEqual(a, b);
        if (op === 0x88) {
          if (!eq) return false;
        } else {
          stack.push(eq ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0x9c:
      case 0x9d: {
        // OP_NUMEQUAL / OP_NUMEQUALVERIFY
        const b = decodeScriptNum(popStack(stack));
        const a = decodeScriptNum(popStack(stack));
        const eq = a === b;
        if (op === 0x9d) {
          if (!eq) return false;
        } else {
          stack.push(eq ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0xa2: {
        // OP_GREATERTHANOREQUAL (used by some threshold tapscripts)
        const b = decodeScriptNum(popStack(stack));
        const a = decodeScriptNum(popStack(stack));
        stack.push(a >= b ? SCRIPT_TRUE : SCRIPT_FALSE);
        break;
      }
      case 0xac:
      case 0xad: {
        // OP_CHECKSIG / OP_CHECKSIGVERIFY (Schnorr in tapscript)
        const pubkey = popStack(stack);
        const sig = popStack(stack);
        const ok = checkSchnorrSig(sig, pubkey, computeSighash);
        if (op === 0xad) {
          if (!ok) return false;
        } else {
          stack.push(ok ? SCRIPT_TRUE : SCRIPT_FALSE);
        }
        break;
      }
      case 0xba: {
        // OP_CHECKSIGADD
        const pubkey = popStack(stack);
        const num = decodeScriptNum(popStack(stack));
        const sig = popStack(stack);
        const ok = checkSchnorrSig(sig, pubkey, computeSighash);
        stack.push(encodeScriptNum(num + (ok ? 1 : 0)));
        break;
      }
      default:
        throw new Error(
          `Unsupported opcode 0x${op.toString(16)} in Taproot leaf script ` +
            '(only standard single-key and CHECKSIGADD multisig scripts are supported).',
        );
    }
  }
  return stack.length > 0 && castToBool(stack[stack.length - 1]);
}

/** Tagged BIP-341 TapLeaf hash for a leaf version + script. */
function tapLeafHash(leafVersion: number, script: Uint8Array): Uint8Array {
  const buf = concatBytes(
    new Uint8Array([leafVersion]),
    compactSizeEncode(script.length),
    script,
  );
  return new Uint8Array(bitcoin.crypto.taggedHash('TapLeaf', buf as Buffer));
}

/**
 * Verify that a Taproot script-path control block commits the given leaf script
 * to the address's output key (BIP-341 merkle path folding + key tweak).
 */
function verifyTaprootCommitment(
  outputKey: Uint8Array,
  leafScript: Uint8Array,
  controlBlock: Uint8Array,
): boolean {
  if (controlBlock.length < 33 || (controlBlock.length - 33) % 32 !== 0) return false;
  const leafVersion = controlBlock[0] & 0xfe;
  const internalKey = controlBlock.subarray(1, 33);
  let k = tapLeafHash(leafVersion, leafScript);
  const pathLen = (controlBlock.length - 33) / 32;
  for (let i = 0; i < pathLen; i++) {
    const node = controlBlock.subarray(33 + i * 32, 33 + i * 32 + 32);
    const combined =
      compareBytes(k, node) <= 0 ? concatBytes(k, node) : concatBytes(node, k);
    k = new Uint8Array(bitcoin.crypto.taggedHash('TapBranch', combined as Buffer));
  }
  const tweak = new Uint8Array(
    bitcoin.crypto.taggedHash('TapTweak', concatBytes(internalKey, k) as Buffer),
  );
  let tweaked: { parity: number; xOnlyPubkey: Uint8Array } | null;
  try {
    tweaked = ecc.xOnlyPointAddTweak(internalKey, tweak);
  } catch {
    return false;
  }
  if (!tweaked) return false;
  if (!bytesEqual(new Uint8Array(tweaked.xOnlyPubkey), outputKey)) return false;
  return tweaked.parity === (controlBlock[0] & 1);
}

/**
 * Verify a BIP-322 "Full" (script-path) signature for a native SegWit P2WSH
 * (bc1q…, 32-byte program) or Taproot P2TR (bc1p…) script-path address.
 *
 * This is the format produced when proving control of a multisig vault or a
 * miniscript / tapscript wallet: the witness stack carries multiple items (the
 * spending stack plus the witness/leaf script and, for Taproot, the control
 * block). Verification reconstructs the BIP-322 virtual to_spend / to_sign
 * transactions, confirms the script is committed to by the address, and runs a
 * focused script interpreter that validates every required signature:
 *
 *   - P2WSH: CHECKSIG / CHECKMULTISIG against the BIP-143 (witness v0) sighash
 *   - P2TR : CHECKSIG / CHECKSIGADD against the BIP-341/342 (tapscript) sighash
 *
 * Genuinely invalid signatures, mismatched scripts, and exotic/unsupported
 * scripts all produce clear errors rather than a silent pass.
 */
export async function verifyBip322Full(
  address: string,
  message: string,
  sigBase64: string,
): Promise<VerificationResult> {
  let version: number;
  let program: Uint8Array;
  try {
    const decoded = bitcoin.address.fromBech32(address.trim());
    version = decoded.version;
    program = new Uint8Array(decoded.data);
  } catch {
    return {
      verified: false,
      error:
        'Could not decode the address as a native SegWit / Taproot (bech32) address. ' +
        'BIP-322 Full verification supports P2WSH and P2TR script-path spends.',
    };
  }

  let spk: Uint8Array;
  if (version === 0 && program.length === 32) {
    spk = concatBytes(new Uint8Array([0x00, 0x20]), program);
  } else if (version === 1 && program.length === 32) {
    spk = concatBytes(new Uint8Array([0x51, 0x20]), program);
  } else {
    return {
      verified: false,
      error:
        'BIP-322 Full verification supports only P2WSH (witness v0, 32-byte) and ' +
        'P2TR (witness v1) script-path addresses.',
    };
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

  let msgHash: Uint8Array;
  try {
    msgHash = await bip322MessageHash(message);
  } catch {
    return { verified: false, error: 'Failed to compute the BIP-322 message hash.' };
  }

  const scriptSig = new Uint8Array(34);
  scriptSig[0] = 0x00; // OP_0
  scriptSig[1] = 0x20; // push 32 bytes
  scriptSig.set(msgHash, 2);

  let toSign: bitcoin.Transaction;
  try {
    const toSpend = new bitcoin.Transaction();
    toSpend.version = 0;
    toSpend.locktime = 0;
    toSpend.addInput(new Uint8Array(32), 0xffffffff, 0, scriptSig);
    toSpend.addOutput(spk, BigInt(0));

    toSign = new bitcoin.Transaction();
    toSign.version = 0;
    toSign.locktime = 0;
    toSign.addInput(toSpend.getHash(), 0, 0);
    toSign.addOutput(new Uint8Array([0x6a]), BigInt(0)); // OP_RETURN
  } catch (err) {
    return {
      verified: false,
      error: `BIP-322 Full verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (version === 0) {
    if (witness.length < 1) {
      return { verified: false, error: 'The BIP-322 witness is empty.' };
    }
    const witnessScript = witness[witness.length - 1];
    let wsHash: Uint8Array;
    try {
      wsHash = await sha256(witnessScript);
    } catch {
      return { verified: false, error: 'Could not hash the witness script.' };
    }
    if (!bytesEqual(wsHash, program)) {
      return {
        verified: false,
        error:
          'The witness script does not hash to this P2WSH address. ' +
          'Make sure you signed with the wallet that holds this exact address.',
      };
    }
    const inputStack = witness.slice(0, witness.length - 1);
    const computeSighash = (hashType: number): Uint8Array =>
      new Uint8Array(
        toSign.hashForWitnessV0(0, witnessScript as Buffer, BigInt(0), hashType),
      );
    let ok: boolean;
    try {
      ok = execWitnessScriptV0(witnessScript, inputStack, computeSighash);
    } catch (err) {
      return {
        verified: false,
        error: `BIP-322 Full (P2WSH) verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (ok) return { verified: true, format: 'bip322' };
    return {
      verified: false,
      error:
        'The BIP-322 Full (P2WSH) signature did not verify against this address. ' +
        'Make sure the message matches exactly and that enough cosigners signed.',
    };
  }

  // version === 1 (Taproot script-path)
  let stack = witness.slice();
  let annex: Uint8Array | undefined;
  if (
    stack.length >= 2 &&
    stack[stack.length - 1].length > 0 &&
    stack[stack.length - 1][0] === 0x50
  ) {
    annex = stack[stack.length - 1];
    stack = stack.slice(0, stack.length - 1);
  }
  if (stack.length < 2) {
    return {
      verified: false,
      error:
        'A Taproot script-path witness must contain at least a leaf script and a control block. ' +
        'A single-item witness is a key-path (BIP-322 Simple) spend.',
    };
  }
  const controlBlock = stack[stack.length - 1];
  const leafScript = stack[stack.length - 2];
  const inputStack = stack.slice(0, stack.length - 2);

  if (!verifyTaprootCommitment(program, leafScript, controlBlock)) {
    return {
      verified: false,
      error:
        'The Taproot script-path control block does not commit to this address ' +
        "(the leaf script is not part of this address's taproot tree).",
    };
  }

  const leafVersion = controlBlock[0] & 0xfe;
  const leafHash = tapLeafHash(leafVersion, leafScript);
  const computeSighash = (hashType: number): Uint8Array =>
    new Uint8Array(
      toSign.hashForWitnessV1(
        0,
        [spk as Buffer],
        [BigInt(0)],
        hashType,
        leafHash as Buffer,
        annex as Buffer | undefined,
      ),
    );

  let ok: boolean;
  try {
    ok = execTapscript(leafScript, inputStack, computeSighash);
  } catch (err) {
    return {
      verified: false,
      error: `BIP-322 Full (Taproot script-path) verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (ok) return { verified: true, format: 'bip322' };
  return {
    verified: false,
    error:
      'The BIP-322 Full (Taproot script-path) signature did not verify against this address. ' +
      'Make sure the message matches exactly and that enough cosigners signed.',
  };
}

/**
 * Verify a BIP-322 "Simple" single-key-spend signature for a native SegWit
 * P2WPKH (bc1q…) address. Accepts the base64 witness produced by Bitcoin
 * Core, Sparrow, and other BIP-322 capable wallets.
 *
 * The witness stack holds two items — an ECDSA DER signature (with a trailing
 * sighash-type byte) and the 33-byte compressed public key. Verification
 * reconstructs the BIP-322 virtual to_spend / to_sign transactions, confirms
 * the public key hashes to the address, and validates the ECDSA signature
 * against the BIP-143 (witness v0) sighash. Script-path / "Full" BIP-322
 * witnesses are not supported and produce a clear error.
 */
export async function verifyBip322P2WPKH(
  address: string,
  message: string,
  sigBase64: string,
): Promise<VerificationResult> {
  let pubKeyHash: Uint8Array;
  try {
    const decoded = bitcoin.address.fromBech32(address.trim());
    if (decoded.version !== 0 || decoded.data.length !== 20) {
      return {
        verified: false,
        error:
          'Address is not a valid native SegWit P2WPKH (bc1q…) output (expected witness v0, 20-byte key hash).',
      };
    }
    pubKeyHash = decoded.data;
  } catch {
    return { verified: false, error: 'Could not decode the SegWit address.' };
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

  if (witness.length !== 2) {
    return {
      verified: false,
      error:
        'Only BIP-322 Simple single-key-spend signatures are supported for SegWit. ' +
        'This witness has ' + witness.length + ' items (script-path / "Full" BIP-322 is not supported).',
    };
  }

  const sigDer = witness[0];
  const pubkey = witness[1];

  if (pubkey.length !== 33) {
    return {
      verified: false,
      error: `Unexpected public key length (${pubkey.length} bytes; expected a 33-byte compressed key).`,
    };
  }

  let derivedHash: Uint8Array;
  try {
    derivedHash = bitcoin.crypto.hash160(pubkey);
  } catch {
    return { verified: false, error: 'Could not hash the witness public key.' };
  }
  if (!bytesEqual(derivedHash, pubKeyHash)) {
    return {
      verified: false,
      error:
        'The BIP-322 signature is cryptographically valid, but its public key does not correspond to this address. ' +
        'Make sure you signed with the wallet that holds this exact address.',
    };
  }

  let sig64: Uint8Array;
  let hashType: number;
  try {
    const dec = bitcoin.script.signature.decode(sigDer);
    sig64 = dec.signature;
    hashType = dec.hashType;
  } catch {
    return { verified: false, error: 'Could not decode the DER signature inside the BIP-322 witness.' };
  }

  try {
    const spk = new Uint8Array(22);
    spk[0] = 0x00; // OP_0
    spk[1] = 0x14; // push 20 bytes
    spk.set(pubKeyHash, 2);

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

    // BIP-143 sighash for P2WPKH uses the implicit P2PKH scriptCode:
    //   OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
    const scriptCode = new Uint8Array(25);
    scriptCode[0] = 0x76; // OP_DUP
    scriptCode[1] = 0xa9; // OP_HASH160
    scriptCode[2] = 0x14; // push 20 bytes
    scriptCode.set(pubKeyHash, 3);
    scriptCode[23] = 0x88; // OP_EQUALVERIFY
    scriptCode[24] = 0xac; // OP_CHECKSIG

    const sighash = toSign.hashForWitnessV0(0, scriptCode, BigInt(0), hashType);
    const ok = ecc.verify(sighash, pubkey, sig64);
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
