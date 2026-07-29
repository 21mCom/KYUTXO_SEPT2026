/**
 * Watch-only unsigned PSBT construction.
 *
 * Builds a single-destination spend from user-selected UTXOs. NO keys, NO
 * signing, NO network — every input is assembled from public data already in
 * the vault (address, amount, optional xpub-derivation info) so an external
 * signer (Coldcard, Sparrow, hardware wallet) can complete the spend.
 *
 * Design rules:
 *  - Uint8Array only; the Buffer global does not exist in the browser.
 *  - Explicit failures, never silent fallbacks: when a signer-critical piece
 *    is missing (e.g. the redeem script of a P2SH input, or the full previous
 *    transaction of a legacy input), buildPsbt throws with a message naming
 *    the offending outpoint. Missing signer-*convenience* data (multisig
 *    witness scripts, derivation info) only produces a warning — signers that
 *    know the wallet can still fill it in.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { validateAddress, type AddressType } from './bitcoin';
import type { VaultMetadata } from './db-types';

/** Optional BIP-32 derivation info so signers can match inputs to their keys. */
export interface PsbtDerivationInfo {
  /** 4-byte master key fingerprint as 8 hex chars. */
  masterFingerprint: string;
  /** Full path from the master key, e.g. "m/84'/0'/0'/0/5". */
  path: string;
  /** 33-byte compressed pubkey (or 32-byte x-only for taproot). */
  pubkey: Uint8Array;
}

export interface PsbtInputSpec {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  derivation?: PsbtDerivationInfo;
  /** Multisig vault metadata (m/n) when the address belongs to a vault. */
  vault?: VaultMetadata;
  /**
   * Raw full previous transaction hex. REQUIRED for legacy (non-segwit)
   * inputs — PSBT demands the complete prevout transaction there. Not needed
   * for segwit inputs (witnessUtxo suffices).
   */
  prevTxHex?: string;
}

export interface BuildPsbtOptions {
  inputs: PsbtInputSpec[];
  destinationAddress: string;
  /** Sats to send. Omit to send the maximum (everything minus the fee). */
  amountSats?: number;
  /** Fee rate in sats/vB. Must be > 0. */
  feeRateSatVb: number;
  /** Where the change output goes. Required when the spend leaves change. */
  changeAddress?: string;
}

export interface PsbtOutputSummary {
  address: string;
  amountSats: number;
  isChange: boolean;
}

export interface BuildPsbtResult {
  psbtBase64: string;
  totalInputSats: number;
  sendAmountSats: number;
  changeSats: number;
  feeSats: number;
  vsizeEstimate: number;
  outputs: PsbtOutputSummary[];
  warnings: string[];
}

/** Outputs below this many sats are uneconomical to create (Core dust rule). */
export const DUST_LIMIT_SATS = 546;

// Conservative (rounded-up) vsize estimates per input script type.
const INPUT_VBYTES: Record<string, number> = {
  P2PKH: 148,
  P2SH: 91, // assumed P2SH-P2WPKH single-key wrap (see below)
  P2WPKH: 68,
  P2TR: 58,
};
const OUTPUT_VBYTES: Record<string, number> = {
  P2PKH: 34,
  P2SH: 32,
  P2WPKH: 31,
  P2WSH: 31,
  P2TR: 43,
};
const TX_OVERHEAD_VBYTES = 11;

/** Estimate a multisig input's vbytes from its m-of-n vault metadata. */
function multisigInputVBytes(vault: VaultMetadata | undefined): number {
  const m = vault?.m ?? 2;
  const n = vault?.n ?? 3;
  // outpoint+sequence ~41, scriptSig/witness overhead, n pubkey pushes (33B),
  // m signature slots (~73B) — witness weight /4.
  return Math.ceil(41 + 7 + (n * 33 + m * 73 + 20) / 4);
}

function inputVBytes(spec: PsbtInputSpec, type: AddressType): number {
  if (type === 'P2WSH' || (type === 'P2SH' && spec.vault?.isVaultXpub)) {
    return multisigInputVBytes(spec.vault);
  }
  return INPUT_VBYTES[type] ?? 148;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function xOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1, 33) : pubkey;
}

function outpointLabel(spec: PsbtInputSpec): string {
  return `${spec.txid.slice(0, 8)}…:${spec.vout}`;
}

function addressTypeOf(address: string): { type: AddressType; network: bitcoin.Network } {
  const v = validateAddress(address);
  if (!v.isValid || v.type !== 'address' || !v.addressType || v.addressType === 'Unknown') {
    throw new Error(`Invalid or unsupported Bitcoin address: ${address}`);
  }
  return {
    type: v.addressType,
    network: v.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin,
  };
}

/**
 * Estimate the final transaction vsize for a given input set + output shapes.
 * Used for the live fee/change preview; intentionally conservative (rounds up).
 */
export function estimateVsize(
  inputs: PsbtInputSpec[],
  destinationAddress: string,
  changeAddress?: string,
): number {
  let vbytes = TX_OVERHEAD_VBYTES;
  for (const spec of inputs) {
    const { type } = addressTypeOf(spec.address);
    vbytes += inputVBytes(spec, type);
  }
  const dest = addressTypeOf(destinationAddress);
  vbytes += OUTPUT_VBYTES[dest.type] ?? 34;
  if (changeAddress) {
    const chg = addressTypeOf(changeAddress);
    vbytes += OUTPUT_VBYTES[chg.type] ?? 34;
  }
  return vbytes;
}

/**
 * Build an unsigned PSBT spending the given UTXOs to a single destination
 * (plus optional change). Returns the base64 PSBT and the exact fee/change
 * breakdown used, or throws with a user-readable reason.
 */
export function buildPsbt(opts: BuildPsbtOptions): BuildPsbtResult {
  if (opts.inputs.length === 0) throw new Error('Select at least one UTXO.');
  if (!Number.isFinite(opts.feeRateSatVb) || opts.feeRateSatVb <= 0) {
    throw new Error('Fee rate must be a positive number of sats/vB.');
  }
  if (opts.amountSats !== undefined && (!Number.isInteger(opts.amountSats) || opts.amountSats <= 0)) {
    throw new Error('Send amount must be a positive whole number of sats.');
  }

  const { network } = addressTypeOf(opts.destinationAddress);
  const warnings: string[] = [];
  let totalInputSats = 0;
  for (const spec of opts.inputs) {
    if (!/^[0-9a-fA-F]{64}$/.test(spec.txid)) throw new Error(`Bad txid for input ${outpointLabel(spec)}.`);
    if (!Number.isInteger(spec.amountSats) || spec.amountSats <= 0) {
      throw new Error(`Bad amount for input ${outpointLabel(spec)}.`);
    }
    const { network: inputNet } = addressTypeOf(spec.address);
    if (inputNet !== network) {
      throw new Error(`Input ${outpointLabel(spec)} is on a different network than the destination.`);
    }
    totalInputSats += spec.amountSats;
  }

  // Two-pass fee math: first assume a change output exists, then drop it if
  // the change would be dust (or there is no change at all).
  const sendMax = opts.amountSats === undefined;
  let vsize = estimateVsize(opts.inputs, opts.destinationAddress, sendMax ? undefined : opts.changeAddress);
  let fee = Math.ceil(vsize * opts.feeRateSatVb);
  let sendAmount = opts.amountSats ?? totalInputSats - fee;
  let change = totalInputSats - sendAmount - fee;

  if (sendMax && sendAmount < DUST_LIMIT_SATS) {
    throw new Error(
      `Selected UTXOs total ${totalInputSats.toLocaleString()} sats, which does not cover the estimated fee of ${fee.toLocaleString()} sats.`,
    );
  }

  if (change < 0) {
    throw new Error(
      `Send amount plus the estimated fee (${fee.toLocaleString()} sats) exceeds the selected total by ${(-change).toLocaleString()} sats.`,
    );
  }

  if (change > 0 && change < DUST_LIMIT_SATS) {
    // Uneconomical change — fold it into the fee instead of creating dust.
    fee += change;
    change = 0;
  }

  if (change > 0) {
    if (!opts.changeAddress) {
      throw new Error(
        `This spend leaves ${change.toLocaleString()} sats of change. Provide a change address, or use Send max.`,
      );
    }
    const { network: chgNet } = addressTypeOf(opts.changeAddress);
    if (chgNet !== network) {
      throw new Error('Change address is on a different network than the destination.');
    }
  }

  const psbt = new bitcoin.Psbt({ network });
  for (const spec of opts.inputs) {
    const { type } = addressTypeOf(spec.address);
    const script = bitcoin.address.toOutputScript(spec.address, network);
    const isSegwit = type === 'P2WPKH' || type === 'P2WSH' || type === 'P2TR' || (type === 'P2SH' && !spec.vault?.isVaultXpub);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input: any = { hash: spec.txid, index: spec.vout };

    if (isSegwit) {
      input.witnessUtxo = { script, value: BigInt(spec.amountSats) };
    } else {
      if (!spec.prevTxHex) {
        throw new Error(
          `Legacy input ${outpointLabel(spec)} (${spec.address}) needs its full previous transaction to build a PSBT, which isn't stored locally. Re-sync that address against a node that serves raw transactions, or exclude this UTXO.`,
        );
      }
      const prevBytes = hexToBytes(spec.prevTxHex);
      // Guard against a wrong/mismatched prev transaction being attached.
      try {
        const prevId = bitcoin.Transaction.fromHex(spec.prevTxHex).getId();
        if (prevId.toLowerCase() !== spec.txid.toLowerCase()) {
          throw new Error(`Previous transaction for ${outpointLabel(spec)} has txid ${prevId} — expected ${spec.txid}.`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Previous transaction')) throw err;
        throw new Error(`Could not parse the previous transaction for ${outpointLabel(spec)}.`);
      }
      input.nonWitnessUtxo = prevBytes;
    }

    if (type === 'P2SH' && !spec.vault?.isVaultXpub) {
      // Single-key P2SH is assumed to be a P2SH-P2WPKH wrap; the redeem script
      // is only derivable from the input's pubkey.
      if (!spec.derivation) {
        throw new Error(
          `P2SH input ${outpointLabel(spec)}: cannot determine the redeem script without derivation info. Import this address via its xpub so its pubkey is known, or exclude this UTXO.`,
        );
      }
      input.redeemScript = bitcoin.payments.p2wpkh({ pubkey: spec.derivation.pubkey, network }).output!;
    }

    if (type === 'P2WSH' || (type === 'P2SH' && spec.vault?.isVaultXpub)) {
      const m = spec.vault?.m ?? '?';
      const n = spec.vault?.n ?? '?';
      warnings.push(
        `${outpointLabel(spec)}: ${m}-of-${n} multisig script is not attached (not stored locally). Signers that hold the vault descriptor can still sign.`,
      );
    }

    if (spec.derivation) {
      const fp = hexToBytes(spec.derivation.masterFingerprint);
      if (fp.length !== 4) throw new Error('masterFingerprint must be 4 bytes (8 hex chars).');
      if (type === 'P2TR') {
        input.tapInternalKey = xOnly(spec.derivation.pubkey);
        input.tapBip32Derivation = [
          { pubkey: xOnly(spec.derivation.pubkey), masterFingerprint: fp, path: spec.derivation.path, leafHashes: [] },
        ];
      } else {
        input.bip32Derivation = [
          { pubkey: spec.derivation.pubkey, masterFingerprint: fp, path: spec.derivation.path },
        ];
      }
    }

    psbt.addInput(input);
  }

  psbt.addOutput({ address: opts.destinationAddress, value: BigInt(sendAmount) });
  const outputs: PsbtOutputSummary[] = [
    { address: opts.destinationAddress, amountSats: sendAmount, isChange: false },
  ];
  if (change > 0 && opts.changeAddress) {
    psbt.addOutput({ address: opts.changeAddress, value: BigInt(change) });
    outputs.push({ address: opts.changeAddress, amountSats: change, isChange: true });
  }

  return {
    psbtBase64: psbt.toBase64(),
    totalInputSats,
    sendAmountSats: sendAmount,
    changeSats: change,
    feeSats: fee,
    vsizeEstimate: vsize,
    outputs,
    warnings,
  };
}

/**
 * Pick a fresh change address for an xpub-derived wallet: the first change-chain
 * index (ascending) with no recorded transaction activity, preferring indices
 * already tracked in the vault (so the address stays inside the synced set).
 *
 * `derive` maps a change-chain index to its address (injected so this stays a
 * pure function). Returns undefined when nothing usable is found within
 * `maxScan` indices.
 */
export function suggestFreshChangeAddress(args: {
  changeRecords: Array<{ inputString: string; derivationPath?: string; cachedTxCount?: number }>;
  derive: (index: number) => string | undefined;
  maxScan?: number;
}): { address: string; index: number; isTracked: boolean } | undefined {
  const { changeRecords, derive } = args;
  const maxScan = args.maxScan ?? 50;

  const byIndex = new Map<number, { inputString: string; cachedTxCount?: number }>();
  let maxIndex = -1;
  for (const rec of changeRecords) {
    const last = rec.derivationPath?.split('/').pop();
    const idx = last !== undefined ? Number.parseInt(last, 10) : NaN;
    if (!Number.isInteger(idx) || idx < 0) continue;
    byIndex.set(idx, rec);
    if (idx > maxIndex) maxIndex = idx;
  }

  const scanTo = Math.max(maxIndex + 1, 0) + 1;
  for (let i = 0; i <= Math.min(scanTo, maxScan); i++) {
    const rec = byIndex.get(i);
    const unused = !rec || (rec.cachedTxCount ?? 0) === 0;
    if (!unused) continue;
    const address = derive(i);
    if (!address) continue;
    return { address, index: i, isTracked: !!rec };
  }
  return undefined;
}
