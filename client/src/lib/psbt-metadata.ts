/**
 * Best-effort PSBT input metadata resolved from address records.
 *
 * Fills in what the vault actually knows about each selected UTXO so the
 * unsigned PSBT is signable by an external signer:
 *
 *   - script type detection (from the address format + record xpub/vault info);
 *   - BIP-32 derivation info (pubkey, master fingerprint, full path) when the
 *     address record carries an xpub and derivation path. The derived pubkey
 *     is only attached after verifying it reproduces the record's address —
 *     wrong derivation info is worse than none;
 *   - a suggested fresh change address from the selection's xpub (first
 *     unused address on the change chain), when all selected UTXOs share one.
 *
 * Multisig vault descriptors are NOT persisted on records, so vault inputs
 * carry witnessUtxo only (the signer must know the descriptor already).
 *
 * Everything here is a pure local read — no network access.
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import bs58check from 'bs58check';
import { db, type Record as DbRecord, type DerivationTemplate } from './database';
import { validateAddress } from './bitcoin';
import { deriveAddressesForChain, deriveTaprootAddressesForChain } from './xpub';
import { bytesToHex, type PsbtDerivationInfo, type PsbtInputScriptType } from './psbt';

bitcoin.initEccLib(ecc);

const XPUB_VERSION_BYTES: Record<string, number> = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
};

function writeUInt32BE(data: Uint8Array, value: number, offset: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

/** Convert any supported extended-pubkey variant to plain xpub/tpub encoding. */
function toPlainXpub(extendedKey: string): { converted: string; network: 'mainnet' | 'testnet' } {
  const trimmed = extendedKey.trim();
  const prefix = trimmed.slice(0, 4);
  const targetVersion = XPUB_VERSION_BYTES[prefix];
  if (targetVersion === undefined) {
    throw new Error('Unsupported extended public key format');
  }
  const network = prefix === 'tpub' || prefix === 'upub' || prefix === 'vpub' ? 'testnet' : 'mainnet';
  const decoded = new Uint8Array(bs58check.decode(trimmed));
  writeUInt32BE(decoded, network === 'testnet' ? XPUB_VERSION_BYTES.tpub : XPUB_VERSION_BYTES.xpub, 0);
  return { converted: bs58check.encode(decoded), network };
}

/**
 * Detect the script type of a UTXO's output from its address, refined by the
 * address record when one exists (xpub prefix tells wrapped-segwit P2SH apart
 * from bare P2SH; vault metadata tells wrapped multisig apart from both).
 */
export function detectInputScriptType(
  address: string,
  record?: DbRecord,
): PsbtInputScriptType {
  const validation = validateAddress(address);
  if (!validation.isValid || validation.type !== 'address') return 'Unknown';
  switch (validation.addressType) {
    case 'P2PKH':
      return 'P2PKH';
    case 'P2WPKH':
      return 'P2WPKH';
    case 'P2WSH':
      return 'P2WSH';
    case 'P2TR':
      return 'P2TR';
    case 'P2SH': {
      if (record?.vault?.isVaultXpub) return 'P2SH-P2WSH';
      const prefix = record?.xpub?.trim().slice(0, 4);
      if (prefix === 'ypub' || prefix === 'upub') return 'P2SH-P2WPKH';
      return 'P2SH';
    }
    default:
      return 'Unknown';
  }
}

function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1, 33) : pubkey;
}

/**
 * Extract the trailing non-hardened (chain, index) pair from a derivation
 * path. Handles full paths ("m/84'/0'/0'/0/5"), relative paths ("0/5"), and
 * label-style paths ("receive/5" — chain defaults to 0).
 */
function parseChainAndIndex(path: string): { chain: number; index: number } | undefined {
  const segments = path.split('/').filter((s) => s.length > 0 && s !== 'm');
  const numeric: number[] = [];
  for (const seg of segments) {
    if (/^\d+'?$/.test(seg)) numeric.push(parseInt(seg.replace("'", ''), 10));
  }
  if (numeric.length >= 2) {
    return { chain: numeric[numeric.length - 2], index: numeric[numeric.length - 1] };
  }
  if (numeric.length === 1 && /receive|change/.test(path)) {
    return { chain: /change/.test(path) ? 1 : 0, index: numeric[0] };
  }
  return undefined;
}

/**
 * Resolve BIP-32 derivation info for a PSBT input from its address record.
 *
 * Returns undefined when the record lacks an xpub/path, when the xpub can't be
 * parsed, or — critically — when the pubkey derived from (xpub, chain, index)
 * does NOT reproduce the record's address. Attaching derivation info that
 * doesn't match the spent output would send the signer down the wrong path.
 *
 * Derivation info is only attached when a matching DerivationTemplate supplies
 * the TRUE master fingerprint and account-level path. The account xpub's own
 * fingerprint is NOT a valid substitute — emitting it as a master fingerprint
 * would feed signers invalid BIP-32 origin data and can prevent wallet
 * matching, so without a template we attach nothing.
 */
export function resolveInputDerivation(
  record: DbRecord | undefined,
  scriptType: PsbtInputScriptType,
  templates: DerivationTemplate[],
): PsbtDerivationInfo | undefined {
  if (!record?.xpub || !record.derivationPath) return undefined;
  if (record.vault?.isVaultXpub) return undefined; // multisig: single xpub can't identify the signer key

  const chainIndex = parseChainAndIndex(record.derivationPath);
  if (!chainIndex) return undefined;

  let converted: string;
  let networkKind: 'mainnet' | 'testnet';
  try {
    ({ converted, network: networkKind } = toPlainXpub(record.xpub));
  } catch {
    return undefined;
  }
  const network = networkKind === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  let childPubkey: Uint8Array;
  try {
    const bip32 = BIP32Factory(ecc);
    const node = bip32.fromBase58(converted, network);
    const child = node.derive(chainIndex.chain).derive(chainIndex.index);
    childPubkey = child.publicKey;
  } catch {
    return undefined;
  }

  // Verify the derived key actually reproduces the record's address before
  // attaching anything.
  let derivedAddress: string | undefined;
  try {
    switch (scriptType) {
      case 'P2WPKH':
        derivedAddress = bitcoin.payments.p2wpkh({ pubkey: childPubkey, network }).address;
        break;
      case 'P2PKH':
        derivedAddress = bitcoin.payments.p2pkh({ pubkey: childPubkey, network }).address;
        break;
      case 'P2SH-P2WPKH':
        derivedAddress = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({ pubkey: childPubkey, network }),
          network,
        }).address;
        break;
      case 'P2TR':
        derivedAddress = bitcoin.payments.p2tr({
          internalPubkey: toXOnly(childPubkey),
          network,
        }).address;
        break;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
  if (!derivedAddress || derivedAddress.toLowerCase() !== record.inputString.toLowerCase()) {
    return undefined;
  }

  const template = templates.find(
    (t) =>
      t.xpub &&
      (t.xpub.trim() === record.xpub!.trim() || safeConvert(t.xpub) === converted) &&
      /^[0-9a-fA-F]{8}$/.test(t.fingerprint),
  );
  // No template → the true master fingerprint / origin path is unknown.
  // Attach nothing rather than fabricated BIP-32 origin data.
  if (!template) return undefined;

  const pubkeyHex =
    scriptType === 'P2TR' ? bytesToHex(toXOnly(childPubkey)) : bytesToHex(childPubkey);

  const base = template.derivationPath.replace(/\/+$/, '');
  const fullPath = `${base}/${chainIndex.chain}/${chainIndex.index}`;
  return {
    pubkeyHex,
    masterFingerprintHex: template.fingerprint.toLowerCase(),
    path: fullPath.startsWith('m/') ? fullPath : `m/${fullPath.replace(/^m\/?/, '')}`,
  };
}

function safeConvert(xpub: string): string | undefined {
  try {
    return toPlainXpub(xpub).converted;
  } catch {
    return undefined;
  }
}

/**
 * Suggest a fresh change address for the current selection: when every
 * selected UTXO traces back to the same single-sig xpub, derive its change
 * chain and return the first address that has no record and no transaction
 * activity (a never-used address). Returns undefined when the selection spans
 * multiple xpubs, the xpub isn't usable, or no unused address is found within
 * the scan window.
 */
export async function suggestFreshChangeAddress(
  records: Array<DbRecord | undefined>,
): Promise<string | undefined> {
  const usable = records.filter(
    (r): r is DbRecord => !!r?.xpub && !r.vault?.isVaultXpub,
  );
  const xpubs = new Set(usable.map((r) => r.xpub!.trim()));
  if (xpubs.size !== 1) return undefined;
  const xpub = usable[0].xpub!.trim();

  const isTaproot = usable.some((r) => {
    const a = r.inputString.toLowerCase();
    return a.startsWith('bc1p') || a.startsWith('tb1p');
  });

  const WINDOW = 20;
  const MAX_INDEX = 200;
  for (let start = 0; start < MAX_INDEX; start += WINDOW) {
    let derived: Array<{ address: string }>;
    try {
      derived = isTaproot
        ? await deriveTaprootAddressesForChain(xpub, 1, start, start + WINDOW - 1)
        : await deriveAddressesForChain(xpub, 1, start, start + WINDOW - 1);
    } catch {
      return undefined;
    }
    for (const d of derived) {
      const existing = await db.records
        .where('inputStringLower')
        .equals(d.address.toLowerCase())
        .first();
      if (existing) continue;
      const activity = await db.transactionParticipants
        .where('address')
        .equals(d.address)
        .count();
      if (activity > 0) continue;
      return d.address;
    }
  }
  return undefined;
}
