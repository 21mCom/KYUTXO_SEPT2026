/**
 * Unsigned PSBT (BIP-174) construction for the watch-only PSBT builder.
 *
 * Threat model: the app never holds private keys, never signs, and never
 * broadcasts. This module assembles an *unsigned* PSBT from user-selected
 * UTXOs plus a destination and fee rate, attaching the metadata external
 * signers need:
 *
 *   - witnessUtxo (scriptPubKey + amount) for every input — the scriptPubKey
 *     is recomputed locally from the tracked address, so no network access or
 *     raw-transaction data is required;
 *   - BIP-32 derivation info (pubkey, master fingerprint, full path) ONLY when
 *     a derivation template supplies the true master fingerprint and the
 *     derived pubkey verifiably reproduces the record's address (see
 *     psbt-metadata.ts) — unverifiable origin data is never fabricated;
 *   - witnessScript / redeemScript whenever the input's script type needs
 *     them for signing.
 *
 * Signability gate (hard rule): every input must carry everything an external
 * signer needs to produce a valid signature, or the whole build is REJECTED
 * with an explanation — we never save a PSBT a signer can't validly sign.
 *   - P2WPKH / P2TR: witnessUtxo suffices.
 *   - P2WSH: requires the witnessScript (vault descriptors are not persisted,
 *     so vault inputs without one are rejected).
 *   - P2SH-P2WSH: requires witnessScript + redeemScript.
 *   - P2SH-P2WPKH: requires the input's pubkey (from verified derivation
 *     info) so the redeemScript can be reconstructed.
 *   - Legacy P2PKH / bare P2SH: rejected — signers require the full previous
 *     transaction (nonWitnessUtxo), which is not stored locally.
 *
 * Browser-safe: bitcoinjs-lib v7 is Uint8Array-native; no Buffer anywhere.
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { validateAddress, type AddressType } from './bitcoin';
import type { SavedPsbtDataOutput } from './db-types';

bitcoin.initEccLib(ecc);

/** Standard dust threshold (satoshis) used for change-output decisions. */
export const DUST_LIMIT_SATS = 546;

/**
 * Maximum OP_RETURN payload (bytes) that stays within the standardness limit
 * — larger data outputs won't relay on default node policy.
 */
export const OP_RETURN_MAX_PAYLOAD_BYTES = 80;

/**
 * Placeholder stored in `SavedPsbtOutput.address` for the zero-value
 * OP_RETURN data output (which has no address). Presence of `dataOutput` on
 * the output spec is the real discriminator; this keeps the address field
 * human-meaningful in exports/backups.
 */
export const OP_RETURN_OUTPUT_MARKER = 'OP_RETURN';

/** Minimum accepted fee rate (sats/vB) — below this a tx won't relay. */
export const MIN_FEE_RATE_SATS_PER_VB = 1;

export type PsbtInputScriptType =
  | 'P2PKH'
  | 'P2SH-P2WPKH'
  | 'P2WPKH'
  | 'P2TR'
  | 'P2WSH'
  | 'P2SH-P2WSH'
  | 'P2SH'
  | 'Unknown';

export interface PsbtDerivationInfo {
  /** Compressed pubkey hex (33 bytes), or x-only hex (32 bytes) for P2TR. */
  pubkeyHex: string;
  /** 4-byte master key fingerprint as 8 hex chars. */
  masterFingerprintHex: string;
  /** Full path from the master key, e.g. "m/84'/0'/0'/0/5". */
  path: string;
}

export interface PsbtInputSpec {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  scriptType: PsbtInputScriptType;
  derivation?: PsbtDerivationInfo;
  /** Multisig vaults: the witness script (hex), when the caller has it. */
  witnessScriptHex?: string;
  /** Wrapped vaults: the redeem script (hex), when the caller has it. */
  redeemScriptHex?: string;
}

export interface PsbtOutputSpec {
  address: string;
  amountSats: number;
  isChange: boolean;
  /**
   * Present only on the zero-value OP_RETURN data output: the payload that was
   * embedded. `address` is OP_RETURN_OUTPUT_MARKER on that output.
   */
  dataOutput?: SavedPsbtDataOutput;
}

export interface PsbtBuildParams {
  inputs: PsbtInputSpec[];
  destinationAddress: string;
  /** Amount to send to the destination, in satoshis. */
  sendAmountSats: number;
  feeRateSatsPerVb: number;
  /** Where the leftover goes. Required when the leftover exceeds the dust limit. */
  changeAddress?: string;
  network?: 'mainnet' | 'testnet';
  /**
   * Optional zero-value OP_RETURN data output (e.g. an evidence-file SHA-256
   * digest for on-chain notarization). At most one per transaction; the
   * payload must stay within the standardness limit.
   */
  dataOutput?: { payloadHex: string };
}

export interface PsbtBuildResult {
  psbtBase64: string;
  psbtBytes: Uint8Array;
  feeSats: number;
  estimatedVbytes: number;
  totalInputSats: number;
  sendAmountSats: number;
  changeSats: number;
  destinationAddress: string;
  changeAddress?: string;
  outputs: PsbtOutputSpec[];
  warnings: string[];
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Estimated input size in virtual bytes by script type. Multisig estimates
 * assume a typical 2-of-3 vault; the exact signed size depends on the vault's
 * m-of-n and DER signature lengths, so the fee is always an estimate.
 */
export function inputVbytes(scriptType: PsbtInputScriptType): number {
  switch (scriptType) {
    case 'P2PKH':
      return 148;
    case 'P2SH-P2WPKH':
      return 91;
    case 'P2WPKH':
      return 68;
    case 'P2TR':
      return 58;
    case 'P2WSH':
      // 2-of-3 native multisig, ~104.5 vB.
      return 105;
    case 'P2SH-P2WSH':
      // 2-of-3 wrapped multisig (35-byte scriptSig + witness).
      return 140;
    case 'P2SH':
      // Bare P2SH spends vary widely; assume the common wrapped-segwit shape.
      return 91;
    default:
      // Unknown: use the largest common input size so the fee is over- rather
      // than under-estimated.
      return 148;
  }
}

/** Estimated output size in bytes by address type. */
export function outputVbytes(addressType: AddressType): number {
  switch (addressType) {
    case 'P2PKH':
      return 34;
    case 'P2SH':
      return 32;
    case 'P2WPKH':
      return 31;
    case 'P2WSH':
      return 43;
    case 'P2TR':
      return 43;
    default:
      return 34;
  }
}

/**
 * Serialized size of a zero-value OP_RETURN output: 8-byte amount + varint
 * script length + script. The script is OP_RETURN plus a single push of the
 * payload (direct push up to 75 bytes, OP_PUSHDATA1 beyond that).
 */
export function dataOutputVbytes(payloadBytes: number): number {
  const pushPrefix = payloadBytes <= 75 ? 1 : 2; // OP_PUSHDATA1 adds a length byte
  const scriptLen = 1 + pushPrefix + payloadBytes;
  return 8 + 1 + scriptLen;
}

/** Compile the OP_RETURN scriptPubKey embedding the given payload. */
export function buildOpReturnScript(payload: Uint8Array): Uint8Array {
  if (payload.length === 0) {
    throw new Error('The OP_RETURN payload must not be empty.');
  }
  if (payload.length > OP_RETURN_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `The OP_RETURN payload is ${payload.length} bytes, over the ${OP_RETURN_MAX_PAYLOAD_BYTES}-byte ` +
        'standardness limit — a transaction with this data output would not relay on default node policy.',
    );
  }
  return bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]);
}

/**
 * Estimate the virtual size of the final signed transaction. Only an estimate:
 * input script sizes for multisig vaults depend on m-of-n, and ECDSA signature
 * lengths vary by a byte or two.
 */
export function estimateTxVbytes(
  inputs: PsbtInputSpec[],
  outputTypes: AddressType[],
  dataPayloadBytes = 0,
): number {
  const anySegwit = inputs.some(
    (i) =>
      i.scriptType === 'P2WPKH' ||
      i.scriptType === 'P2SH-P2WPKH' ||
      i.scriptType === 'P2TR' ||
      i.scriptType === 'P2WSH' ||
      i.scriptType === 'P2SH-P2WSH' ||
      i.scriptType === 'P2SH',
  );
  const overhead =
    4 + // version
    1 + // input count varint
    1 + // output count varint
    4 + // locktime
    (anySegwit ? 0.5 : 0); // segwit marker + flag (weight 2)
  const inBytes = inputs.reduce((sum, i) => sum + inputVbytes(i.scriptType), 0);
  const outBytes =
    outputTypes.reduce((sum, t) => sum + outputVbytes(t), 0) +
    (dataPayloadBytes > 0 ? dataOutputVbytes(dataPayloadBytes) : 0);
  return Math.ceil(overhead + inBytes + outBytes);
}

/** Strict address check: format validation AND a successful script decode. */
function toOutputScriptChecked(
  address: string,
  network: bitcoin.Network,
  role: string,
): Uint8Array {
  const validation = validateAddress(address);
  if (!validation.isValid || validation.type !== 'address') {
    throw new Error(
      `Invalid ${role} address${validation.error ? `: ${validation.error}` : ''}`,
    );
  }
  try {
    return bitcoin.address.toOutputScript(address.trim(), network);
  } catch {
    const netLabel = network === bitcoin.networks.bitcoin ? 'mainnet' : 'testnet';
    throw new Error(
      `The ${role} address is not a valid ${netLabel} address (checksum or network mismatch).`,
    );
  }
}

function addressTypeOf(address: string): AddressType {
  return validateAddress(address).addressType ?? 'Unknown';
}

export interface DecodedPsbtSummary {
  inputCount: number;
  outputCount: number;
  /** True when every input carries witnessUtxo (script + amount). */
  allInputsHaveWitnessUtxo: boolean;
  /** True when any input carries a partial signature (i.e. NOT unsigned). */
  hasSignatures: boolean;
}

interface SignabilityResult {
  /** Derived redeemScript for P2SH-P2WPKH inputs (reconstructed from pubkey). */
  derivedRedeemScript?: Uint8Array;
}

/**
 * Signability gate: verify that one input carries everything an external
 * signer needs to sign it, and that any supplied scripts actually reproduce
 * the input's address. Throws a user-readable Error when the input can't be
 * signed from locally available data.
 */
function assertInputSignable(
  input: PsbtInputSpec,
  network: bitcoin.Network,
): SignabilityResult {
  const outpoint = `${input.txid.slice(0, 8)}…:${input.vout}`;
  const addr = input.address.toLowerCase();
  const matchesAddress = (derived: string | undefined) =>
    !!derived && derived.toLowerCase() === addr;

  switch (input.scriptType) {
    case 'P2WPKH':
    case 'P2TR':
      // witnessUtxo (script + amount) is all a signer needs for native segwit.
      return {};

    case 'P2WSH': {
      if (!input.witnessScriptHex) {
        throw new Error(
          `Input ${outpoint} (${input.address.slice(0, 16)}…) is a multisig/script output, ` +
            'but its witness script is not stored locally (vault descriptors are not persisted). ' +
            'Without it no signer can produce a signature, so this PSBT cannot be built here.',
        );
      }
      const witnessScript = hexToBytes(input.witnessScriptHex);
      const derived = bitcoin.payments.p2wsh({
        redeem: { output: witnessScript, network },
        network,
      }).address;
      if (!matchesAddress(derived)) {
        throw new Error(
          `Input ${outpoint}: the stored witness script does not reproduce the input's address ` +
            '— refusing to build a PSBT with inconsistent scripts.',
        );
      }
      return {};
    }

    case 'P2SH-P2WSH': {
      if (!input.witnessScriptHex || !input.redeemScriptHex) {
        throw new Error(
          `Input ${outpoint} (${input.address.slice(0, 16)}…) is a wrapped multisig output, ` +
            'but its witness/redeem scripts are not stored locally (vault descriptors are not ' +
            'persisted). Without them no signer can produce a signature, so this PSBT cannot be built here.',
        );
      }
      const witnessScript = hexToBytes(input.witnessScriptHex);
      const redeemScript = hexToBytes(input.redeemScriptHex);
      // The redeemScript must be the P2WSH scriptPubKey of the witnessScript,
      // and the P2SH of that redeemScript must equal the input address.
      const expectedRedeem = bitcoin.payments.p2wsh({
        redeem: { output: witnessScript, network },
        network,
      }).output;
      if (!expectedRedeem || bytesToHex(expectedRedeem) !== bytesToHex(redeemScript)) {
        throw new Error(
          `Input ${outpoint}: the stored redeem script is not the P2WSH wrapper of the witness ` +
            'script — refusing to build a PSBT with inconsistent scripts.',
        );
      }
      const derived = bitcoin.payments.p2sh({
        redeem: { output: redeemScript, network },
        network,
      }).address;
      if (!matchesAddress(derived)) {
        throw new Error(
          `Input ${outpoint}: the stored scripts do not reproduce the input's address — ` +
            'refusing to build a PSBT with inconsistent scripts.',
        );
      }
      return {};
    }

    case 'P2SH-P2WPKH': {
      // Wrapped SegWit singlesig: the redeemScript is the P2WPKH script of the
      // input's pubkey. The pubkey only reaches us via verified derivation
      // info, so without it the input is unsignable here.
      if (!input.derivation) {
        throw new Error(
          `Input ${outpoint} (${input.address.slice(0, 16)}…) is a wrapped SegWit ` +
            '(P2SH-P2WPKH) output, but its pubkey is unknown — no derivation template with a ' +
            'master fingerprint matches this address record, so the redeem script a signer ' +
            'needs cannot be reconstructed. Add the xpub with its origin fingerprint first.',
        );
      }
      const pubkey = hexToBytes(input.derivation.pubkeyHex);
      const redeem = bitcoin.payments.p2wpkh({ pubkey, network });
      const derived = bitcoin.payments.p2sh({ redeem, network }).address;
      if (!redeem.output || !matchesAddress(derived)) {
        throw new Error(
          `Input ${outpoint}: the derivation pubkey does not reproduce this wrapped SegWit ` +
            'address — refusing to build a PSBT with an inconsistent redeem script.',
        );
      }
      return { derivedRedeemScript: redeem.output };
    }

    case 'P2PKH':
      throw new Error(
        `Input ${outpoint} (${input.address.slice(0, 16)}…) is a legacy P2PKH output. ` +
          'Signers require the full previous transaction (nonWitnessUtxo) to sign legacy ' +
          'inputs, and raw transactions are not stored locally — this input cannot be ' +
          'included in a PSBT built here.',
      );

    case 'P2SH':
      throw new Error(
        `Input ${outpoint} (${input.address.slice(0, 16)}…) is a legacy P2SH output whose ` +
          'redeem script is not stored locally, and signers also require the full previous ' +
          'transaction for legacy inputs — this input cannot be included in a PSBT built here.',
      );

    default:
      throw new Error(
        `Input ${outpoint} has an unrecognized address format, so the metadata a signer ` +
          'needs cannot be determined.',
      );
  }
}

/**
 * Decode and sanity-check a base64 PSBT. Throws on malformed input. Used to
 * verify that what we save is exactly what an external signer will read.
 */
export function decodePsbtSummary(psbtBase64: string): DecodedPsbtSummary {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.bitcoin });
  let allWitness = true;
  let hasSigs = false;
  for (const input of psbt.data.inputs) {
    if (!input.witnessUtxo) allWitness = false;
    if ((input.partialSig?.length ?? 0) > 0) hasSigs = true;
  }
  return {
    inputCount: psbt.inputCount,
    outputCount: psbt.txOutputs.length,
    allInputsHaveWitnessUtxo: allWitness,
    hasSignatures: hasSigs,
  };
}

/**
 * Build an unsigned PSBT spending the given inputs to a single destination,
 * with the leftover (if any) going to a change address.
 *
 * Throws Error with a user-readable message on any validation failure.
 */
export function buildUnsignedPsbt(params: PsbtBuildParams): PsbtBuildResult {
  const network =
    params.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const warnings: string[] = [];

  if (!params.inputs || params.inputs.length === 0) {
    throw new Error('No UTXOs selected.');
  }

  // --- Validate inputs -------------------------------------------------------
  const seenOutpoints = new Set<string>();
  let totalInputSats = 0;
  for (const input of params.inputs) {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) {
      throw new Error(`Input has an invalid transaction id: ${input.txid}`);
    }
    if (!Number.isInteger(input.vout) || input.vout < 0) {
      throw new Error(`Input ${input.txid.slice(0, 8)}… has an invalid output index.`);
    }
    if (!Number.isFinite(input.amountSats) || input.amountSats <= 0) {
      throw new Error(`Input ${input.txid.slice(0, 8)}…:${input.vout} has no known amount.`);
    }
    const outpoint = `${input.txid}:${input.vout}`;
    if (seenOutpoints.has(outpoint)) {
      throw new Error(`The same UTXO (${input.txid.slice(0, 8)}…:${input.vout}) was selected twice.`);
    }
    seenOutpoints.add(outpoint);
    // The scriptPubKey is recomputed from the tracked address; this throws on a
    // malformed address or a network mismatch.
    toOutputScriptChecked(input.address, network, 'input');
    // Hard gate: never assemble a PSBT an external signer can't validly sign.
    assertInputSignable(input, network);
    totalInputSats += input.amountSats;
  }

  // --- Validate destination / fee -------------------------------------------
  const destinationAddress = params.destinationAddress.trim();
  toOutputScriptChecked(destinationAddress, network, 'destination');

  const feeRate = params.feeRateSatsPerVb;
  if (!Number.isFinite(feeRate) || feeRate < MIN_FEE_RATE_SATS_PER_VB) {
    throw new Error(`Fee rate must be at least ${MIN_FEE_RATE_SATS_PER_VB} sat/vB.`);
  }

  const sendAmountSats = Math.floor(params.sendAmountSats);
  if (!Number.isFinite(sendAmountSats) || sendAmountSats < DUST_LIMIT_SATS) {
    throw new Error(`Send amount must be at least ${DUST_LIMIT_SATS} sats (the dust limit).`);
  }

  // --- OP_RETURN data output (optional) ---------------------------------------
  // Validate and compile up front so a payload problem is reported before any
  // fee math is shown. Zero value by definition — data outputs are unspendable.
  let dataOutputScript: Uint8Array | undefined;
  let dataPayload: Uint8Array | undefined;
  if (params.dataOutput) {
    try {
      dataPayload = hexToBytes(params.dataOutput.payloadHex);
    } catch {
      throw new Error('The OP_RETURN payload is not valid hexadecimal.');
    }
    dataOutputScript = buildOpReturnScript(dataPayload); // throws on empty/oversize
  }

  // --- Fee / change math ------------------------------------------------------
  let changeAddress = params.changeAddress?.trim() || undefined;
  let outputTypes: AddressType[] = [addressTypeOf(destinationAddress)];
  if (changeAddress) {
    outputTypes.push(addressTypeOf(changeAddress));
  }
  const estimatedVbytes = estimateTxVbytes(
    params.inputs,
    outputTypes,
    dataPayload?.length ?? 0,
  );
  let feeSats = Math.ceil(feeRate * estimatedVbytes);
  let changeSats = totalInputSats - sendAmountSats - feeSats;

  if (changeSats < 0) {
    throw new Error(
      `Insufficient funds: the selected UTXOs total ${totalInputSats.toLocaleString()} sats, ` +
        `but sending ${sendAmountSats.toLocaleString()} sats plus the estimated fee of ` +
        `${feeSats.toLocaleString()} sats needs ${(sendAmountSats + feeSats).toLocaleString()} sats.`,
    );
  }

  if (changeSats > 0) {
    if (!changeAddress) {
      throw new Error(
        `${changeSats.toLocaleString()} sats would be left over. Enter a change address, ` +
          'or use "Send max" to send everything to the destination.',
      );
    }
    toOutputScriptChecked(changeAddress, network, 'change');
    if (changeSats < DUST_LIMIT_SATS) {
      warnings.push(
        `The leftover change of ${changeSats.toLocaleString()} sats is below the dust limit ` +
          `(${DUST_LIMIT_SATS} sats), so it was added to the fee instead of creating a change output.`,
      );
      feeSats += changeSats;
      changeSats = 0;
      changeAddress = undefined;
    }
  }

  // --- Assemble the PSBT ------------------------------------------------------
  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);

  for (const input of params.inputs) {
    const script = toOutputScriptChecked(input.address, network, 'input');
    const addInput: Parameters<bitcoin.Psbt['addInput']>[0] = {
      hash: input.txid,
      index: input.vout,
      witnessUtxo: { script, value: BigInt(input.amountSats) },
    };

    // The gate already verified these scripts reproduce the input address.
    const { derivedRedeemScript } = assertInputSignable(input, network);
    if (input.witnessScriptHex) {
      addInput.witnessScript = hexToBytes(input.witnessScriptHex);
    }
    const redeemScript = input.redeemScriptHex
      ? hexToBytes(input.redeemScriptHex)
      : derivedRedeemScript;
    if (redeemScript) {
      addInput.redeemScript = redeemScript;
    }

    if (input.derivation) {
      const masterFingerprint = hexToBytes(input.derivation.masterFingerprintHex);
      if (masterFingerprint.length !== 4) {
        throw new Error(
          `Derivation info for ${input.txid.slice(0, 8)}…:${input.vout} has an invalid master fingerprint.`,
        );
      }
      const pubkey = hexToBytes(input.derivation.pubkeyHex);
      if (input.scriptType === 'P2TR') {
        // Key-path-only taproot: x-only internal key, no script tree.
        addInput.tapInternalKey = pubkey;
        addInput.tapBip32Derivation = [
          { pubkey, masterFingerprint, path: input.derivation.path, leafHashes: [] },
        ];
      } else {
        addInput.bip32Derivation = [
          { pubkey, masterFingerprint, path: input.derivation.path },
        ];
      }
    }

    psbt.addInput(addInput);
  }

  const outputs: PsbtOutputSpec[] = [
    { address: destinationAddress, amountSats: sendAmountSats, isChange: false },
  ];
  psbt.addOutput({ address: destinationAddress, value: BigInt(sendAmountSats) });
  if (changeSats > 0 && changeAddress) {
    outputs.push({ address: changeAddress, amountSats: changeSats, isChange: true });
    psbt.addOutput({ address: changeAddress, value: BigInt(changeSats) });
  }
  if (dataOutputScript && dataPayload) {
    outputs.push({
      address: OP_RETURN_OUTPUT_MARKER,
      amountSats: 0,
      isChange: false,
      dataOutput: { payloadHex: bytesToHex(dataPayload) },
    });
    psbt.addOutput({ script: dataOutputScript, value: BigInt(0) });
  }

  return {
    psbtBase64: psbt.toBase64(),
    psbtBytes: psbt.toBuffer(),
    feeSats,
    estimatedVbytes,
    totalInputSats,
    sendAmountSats,
    changeSats,
    destinationAddress,
    changeAddress,
    outputs,
    warnings,
  };
}
