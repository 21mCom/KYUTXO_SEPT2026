// Unit coverage for watch-only PSBT construction (client/src/lib/psbt-builder.ts).
// Builds real key material with bip32 so every script/address is genuine, and
// round-trips every produced PSBT through bitcoinjs-lib's decoder.
import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import { buildPsbt, estimateVsize, suggestFreshChangeAddress, hexToBytes, DUST_LIMIT_SATS, type PsbtInputSpec } from './psbt-builder';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;

const FP = 'a1b2c3d4';
const node = bip32.fromSeed(new Uint8Array(64).fill(7), net);
const child = node.derive(0).derive(5);

const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: net });
const p2tr = bitcoin.payments.p2tr({ internalPubkey: child.publicKey.slice(1, 33), network: net });
const p2shWrapped = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: net }), network: net });
const p2pkh = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network: net });

const DEST = bitcoin.payments.p2wpkh({ pubkey: node.derive(9).publicKey, network: net }).address!;
const CHANGE = bitcoin.payments.p2wpkh({ pubkey: node.derive(1).derive(0).publicKey, network: net }).address!;

const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);

const DERIV = { masterFingerprint: FP, path: "m/84'/0'/0'/0/5", pubkey: child.publicKey };

function spec(partial: Partial<PsbtInputSpec> & { address: string; amountSats: number }): PsbtInputSpec {
  return { txid: TXID_A, vout: 0, ...partial };
}

/** A real serialized transaction paying `amountSats` to `address`, txid = TXID via tweak. */
function makePrevTxHex(address: string, amountSats: number): { hex: string; txid: string } {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(new Uint8Array(32).fill(3), 1, 0xfffffffd);
  tx.addOutput(bitcoin.address.toOutputScript(address, net), BigInt(amountSats));
  return { hex: tx.toHex(), txid: tx.getId() };
}

describe('buildPsbt · P2WPKH', () => {
  it('builds a spend with change and correct fee math', () => {
    const res = buildPsbt({
      inputs: [
        spec({ address: p2wpkh.address!, amountSats: 100_000, derivation: DERIV }),
        spec({ txid: TXID_B, vout: 1, address: p2wpkh.address!, amountSats: 50_000 }),
      ],
      destinationAddress: DEST,
      amountSats: 120_000,
      feeRateSatVb: 5,
      changeAddress: CHANGE,
    });

    // vsize: 11 + 2*68 + 31 + 31 = 209 → fee = 209 * 5 = 1045
    expect(res.vsizeEstimate).toBe(209);
    expect(res.feeSats).toBe(1045);
    expect(res.changeSats).toBe(150_000 - 120_000 - 1045);
    expect(res.outputs).toEqual([
      { address: DEST, amountSats: 120_000, isChange: false },
      { address: CHANGE, amountSats: 150_000 - 120_000 - 1045, isChange: true },
    ]);

    const decoded = bitcoin.Psbt.fromBase64(res.psbtBase64, { network: net });
    expect(decoded.inputCount).toBe(2);
    expect(decoded.txOutputs[0].address).toBe(DEST);
    expect(decoded.txOutputs[0].value).toBe(BigInt(120_000));
    expect(decoded.txOutputs[1].address).toBe(CHANGE);
    // The first input carries witnessUtxo + bip32 derivation; the second only witnessUtxo.
    const input0 = decoded.data.inputs[0] as unknown as Record<string, unknown>;
    expect(input0.witnessUtxo).toBeTruthy();
    expect(input0.bip32Derivation).toBeTruthy();
    const input1 = decoded.data.inputs[1] as unknown as Record<string, unknown>;
    expect(input1.witnessUtxo).toBeTruthy();
  });

  it('send-max spends everything minus the fee and adds no change output', () => {
    const res = buildPsbt({
      inputs: [spec({ address: p2wpkh.address!, amountSats: 100_000 })],
      destinationAddress: DEST,
      feeRateSatVb: 2,
    });
    // vsize: 11 + 68 + 31 = 110 → fee 220
    expect(res.feeSats).toBe(220);
    expect(res.changeSats).toBe(0);
    expect(res.sendAmountSats).toBe(100_000 - 220);
    expect(res.outputs).toHaveLength(1);
  });

  it('folds dust change into the fee instead of creating a dust output', () => {
    // vsize with change: 11 + 68 + 31 + 31 = 141 → fee 705; pick an amount
    // that leaves 150 sats of change (< dust limit) so it folds into the fee.
    const res = buildPsbt({
      inputs: [spec({ address: p2wpkh.address!, amountSats: 100_000 })],
      destinationAddress: DEST,
      amountSats: 100_000 - 705 - 150,
      feeRateSatVb: 5,
      changeAddress: CHANGE,
    });
    expect(res.changeSats).toBe(0);
    expect(res.outputs).toHaveLength(1);
    expect(res.feeSats).toBe(705 + 150);
  });

  it('requires a change address when the spend leaves economical change', () => {
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 100_000 })],
        destinationAddress: DEST,
        amountSats: 50_000,
        feeRateSatVb: 5,
      }),
    ).toThrow(/change address/i);
  });

  it('rejects an overspend and a fee that exceeds the total', () => {
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 10_000 })],
        destinationAddress: DEST,
        amountSats: 20_000,
        feeRateSatVb: 5,
        changeAddress: CHANGE,
      }),
    ).toThrow(/exceeds the selected total/);
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 400 })],
        destinationAddress: DEST,
        feeRateSatVb: 5,
      }),
    ).toThrow(/does not cover the estimated fee/);
  });
});

describe('buildPsbt · other script types', () => {
  it('P2TR inputs attach witnessUtxo + taproot derivation', () => {
    const res = buildPsbt({
      inputs: [spec({ address: p2tr.address!, amountSats: 80_000, derivation: DERIV })],
      destinationAddress: DEST,
      feeRateSatVb: 3,
    });
    const decoded = bitcoin.Psbt.fromBase64(res.psbtBase64, { network: net });
    const input0 = decoded.data.inputs[0] as unknown as Record<string, unknown>;
    expect(input0.witnessUtxo).toBeTruthy();
    expect(input0.tapInternalKey).toBeTruthy();
    expect(input0.tapBip32Derivation).toBeTruthy();
  });

  it('P2SH-P2WPKH inputs attach the wrapped redeem script from the pubkey', () => {
    const res = buildPsbt({
      inputs: [spec({ address: p2shWrapped.address!, amountSats: 60_000, derivation: DERIV })],
      destinationAddress: DEST,
      feeRateSatVb: 4,
    });
    const decoded = bitcoin.Psbt.fromBase64(res.psbtBase64, { network: net });
    const input0 = decoded.data.inputs[0] as unknown as Record<string, unknown>;
    expect(input0.witnessUtxo).toBeTruthy();
    expect(input0.redeemScript).toBeTruthy();
  });

  it('P2SH inputs without derivation info fail explicitly (redeem script unknowable)', () => {
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2shWrapped.address!, amountSats: 60_000 })],
        destinationAddress: DEST,
        feeRateSatVb: 4,
      }),
    ).toThrow(/redeem script/i);
  });

  it('P2PKH inputs need the full previous transaction and verify its txid', () => {
    const prev = makePrevTxHex(p2pkh.address!, 90_000);
    const res = buildPsbt({
      inputs: [spec({ txid: prev.txid, address: p2pkh.address!, amountSats: 90_000, prevTxHex: prev.hex })],
      destinationAddress: DEST,
      feeRateSatVb: 2,
    });
    const decoded = bitcoin.Psbt.fromBase64(res.psbtBase64, { network: net });
    const input0 = decoded.data.inputs[0] as unknown as Record<string, unknown>;
    expect(input0.nonWitnessUtxo).toBeTruthy();

    // Missing hex → explicit error
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2pkh.address!, amountSats: 90_000 })],
        destinationAddress: DEST,
        feeRateSatVb: 2,
      }),
    ).toThrow(/full previous transaction/i);

    // Mismatched hex → explicit error
    const other = makePrevTxHex(DEST, 90_000);
    expect(() =>
      buildPsbt({
        inputs: [spec({ txid: TXID_A, address: p2pkh.address!, amountSats: 90_000, prevTxHex: other.hex })],
        destinationAddress: DEST,
        feeRateSatVb: 2,
      }),
    ).toThrow(/expected/i);
  });

  it('multisig vault inputs build with a warning instead of a script', () => {
    const p2wshVault = bitcoin.payments.p2wsh({
      redeem: bitcoin.payments.p2ms({
        m: 2,
        pubkeys: [node.derive(20).publicKey, node.derive(21).publicKey, node.derive(22).publicKey],
        network: net,
      }),
      network: net,
    });
    const res = buildPsbt({
      inputs: [spec({ address: p2wshVault.address!, amountSats: 70_000, vault: { isVaultXpub: true, m: 2, n: 3 } })],
      destinationAddress: DEST,
      feeRateSatVb: 1,
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/2-of-3 multisig/i);
    // Round-trips fine — the signer fills the script from its own descriptor.
    expect(bitcoin.Psbt.fromBase64(res.psbtBase64, { network: net }).inputCount).toBe(1);
  });
});

describe('buildPsbt · validation', () => {
  it('rejects an invalid destination, bad fee rate, and mixed networks', () => {
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 10_000 })],
        destinationAddress: 'not-an-address',
        feeRateSatVb: 5,
      }),
    ).toThrow(/Invalid or unsupported/);
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 10_000 })],
        destinationAddress: DEST,
        feeRateSatVb: 0,
      }),
    ).toThrow(/positive/);

    const testnetNode = bip32.fromSeed(new Uint8Array(64).fill(8), bitcoin.networks.testnet);
    const tbDest = bitcoin.payments.p2wpkh({ pubkey: testnetNode.publicKey, network: bitcoin.networks.testnet }).address!;
    expect(() =>
      buildPsbt({
        inputs: [spec({ address: p2wpkh.address!, amountSats: 10_000 })],
        destinationAddress: tbDest,
        feeRateSatVb: 5,
      }),
    ).toThrow(/different network/);
  });

  it('estimateVsize grows with inputs and a change output', () => {
    const one = estimateVsize([spec({ address: p2wpkh.address!, amountSats: 1 })], DEST);
    const two = estimateVsize(
      [spec({ address: p2wpkh.address!, amountSats: 1 }), spec({ address: p2wpkh.address!, amountSats: 1 })],
      DEST,
    );
    const twoWithChange = estimateVsize(
      [spec({ address: p2wpkh.address!, amountSats: 1 }), spec({ address: p2wpkh.address!, amountSats: 1 })],
      DEST,
      CHANGE,
    );
    expect(two).toBeGreaterThan(one);
    expect(twoWithChange).toBeGreaterThan(two);
  });
});

describe('suggestFreshChangeAddress', () => {
  const derive = (i: number) => `change-addr-${i}`;

  it('prefers the first tracked-but-unused change index', () => {
    const res = suggestFreshChangeAddress({
      changeRecords: [
        { inputString: 'change-addr-0', derivationPath: "m/84'/0'/0'/1/0", cachedTxCount: 3 },
        { inputString: 'change-addr-1', derivationPath: "m/84'/0'/0'/1/1", cachedTxCount: 0 },
        { inputString: 'change-addr-2', derivationPath: "m/84'/0'/0'/1/2", cachedTxCount: 1 },
      ],
      derive,
    });
    expect(res).toEqual({ address: 'change-addr-1', index: 1, isTracked: true });
  });

  it('falls one past the highest tracked index when all are used', () => {
    const res = suggestFreshChangeAddress({
      changeRecords: [
        { inputString: 'change-addr-0', derivationPath: "m/84'/0'/0'/1/0", cachedTxCount: 2 },
        { inputString: 'change-addr-1', derivationPath: "m/84'/0'/0'/1/1", cachedTxCount: 1 },
      ],
      derive,
    });
    expect(res).toEqual({ address: 'change-addr-2', index: 2, isTracked: false });
  });

  it('returns undefined when derivation yields nothing', () => {
    expect(
      suggestFreshChangeAddress({ changeRecords: [], derive: () => undefined, maxScan: 3 }),
    ).toBeUndefined();
  });
});

describe('hexToBytes', () => {
  it('round-trips and rejects junk', () => {
    expect(Array.from(hexToBytes('deadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(() => hexToBytes('xyz')).toThrow(/Invalid hex/);
    expect(() => hexToBytes('abc')).toThrow(/Invalid hex/);
  });
});
