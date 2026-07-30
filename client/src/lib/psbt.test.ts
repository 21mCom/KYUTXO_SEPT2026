import { describe, it, expect } from 'vitest';
import * as ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import BIP32Factory from 'bip32';
import {
  buildUnsignedPsbt,
  decodePsbtSummary,
  estimateTxVbytes,
  inputVbytes,
  bytesToHex,
  hexToBytes,
  DUST_LIMIT_SATS,
  type PsbtInputSpec,
} from './psbt';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

// BIP-84 test-vector wallet (mnemonic "abandon … about", root fp 73c5da0a).
// The mnemonic is public test-vector material, so deriving REAL private keys
// here is safe and lets us prove the built PSBTs actually sign + finalize.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = bip32.fromSeed(bip39.mnemonicToSeedSync(MNEMONIC));
const MASTER_FP = '73c5da0a';

const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0
const ADDR_W0_PUBKEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c';
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/84'/0'/0'/0/1
const ADDR_CHANGE0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/84'/0'/0'/1/0
// BIP-86 test vector (same mnemonic).
const ADDR_TR0 = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const TR0_INTERNAL_PUBKEY = 'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
// Genesis P2PKH address (valid base58check) — used only for rejection tests.
const ADDR_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);

const validator = (pubkey: Uint8Array, msghash: Uint8Array, signature: Uint8Array) =>
  ecc.verify(msghash, pubkey, signature);

function wpkhInput(overrides: Partial<PsbtInputSpec> = {}): PsbtInputSpec {
  return {
    txid: TXID_A,
    vout: 0,
    address: ADDR_W0,
    amountSats: 100_000,
    scriptType: 'P2WPKH',
    ...overrides,
  };
}

function sendMaxParams(input: PsbtInputSpec, destination = ADDR_W1) {
  const vbytes = estimateTxVbytes([input], ['P2WPKH']);
  const fee = Math.ceil(2 * vbytes);
  return {
    inputs: [input],
    destinationAddress: destination,
    sendAmountSats: input.amountSats - fee,
    feeRateSatsPerVb: 2,
  };
}

describe('estimateTxVbytes', () => {
  it('estimates a 1-in 1-out P2WPKH tx close to the canonical ~110 vB', () => {
    const v = estimateTxVbytes([wpkhInput()], ['P2WPKH']);
    expect(v).toBe(Math.ceil(10.5 + 68 + 31));
  });

  it('uses larger estimates for legacy and multisig inputs', () => {
    expect(inputVbytes('P2PKH')).toBe(148);
    expect(inputVbytes('P2SH-P2WPKH')).toBe(91);
    expect(inputVbytes('P2WSH')).toBeGreaterThan(inputVbytes('P2WPKH'));
    expect(inputVbytes('P2SH-P2WSH')).toBeGreaterThan(inputVbytes('P2WSH'));
    expect(inputVbytes('Unknown')).toBe(148);
  });
});

describe('buildUnsignedPsbt', () => {
  it('builds a send-max style single-input PSBT and round-trips through decode', () => {
    const vbytes = estimateTxVbytes([wpkhInput()], ['P2WPKH']);
    const fee = Math.ceil(2 * vbytes);
    const result = buildUnsignedPsbt({
      inputs: [wpkhInput()],
      destinationAddress: ADDR_W1,
      sendAmountSats: 100_000 - fee,
      feeRateSatsPerVb: 2,
    });

    expect(result.changeSats).toBe(0);
    expect(result.feeSats).toBe(fee);
    expect(result.outputs).toEqual([
      { address: ADDR_W1, amountSats: 100_000 - fee, isChange: false },
    ]);

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(decoded.inputCount).toBe(1);
    const input0 = decoded.data.inputs[0];
    expect(input0.witnessUtxo?.value).toBe(BigInt(100_000));
    expect(bytesToHex(input0.witnessUtxo!.script)).toBe(
      bytesToHex(bitcoin.address.toOutputScript(ADDR_W0, bitcoin.networks.bitcoin)),
    );
    expect(decoded.txOutputs.length).toBe(1);
    expect(decoded.txOutputs[0].value).toBe(BigInt(100_000 - fee));
    expect(decoded.txOutputs[0].address).toBe(ADDR_W1);
    // Unsigned: no signatures anywhere.
    expect(input0.partialSig ?? []).toHaveLength(0);
  });

  it('builds a custom-amount PSBT with a change output', () => {
    const vbytes = estimateTxVbytes([wpkhInput()], ['P2WPKH', 'P2WPKH']);
    const fee = Math.ceil(5 * vbytes);
    const result = buildUnsignedPsbt({
      inputs: [wpkhInput()],
      destinationAddress: ADDR_W1,
      sendAmountSats: 50_000,
      feeRateSatsPerVb: 5,
      changeAddress: ADDR_CHANGE0,
    });

    expect(result.feeSats).toBe(fee);
    expect(result.changeSats).toBe(100_000 - 50_000 - fee);
    expect(result.changeAddress).toBe(ADDR_CHANGE0);
    expect(result.outputs[1]).toEqual({
      address: ADDR_CHANGE0,
      amountSats: 100_000 - 50_000 - fee,
      isChange: true,
    });

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(decoded.txOutputs.length).toBe(2);
    expect(decoded.txOutputs[1].address).toBe(ADDR_CHANGE0);
  });

  it('folds below-dust change into the fee with a warning', () => {
    const vbytes = estimateTxVbytes([wpkhInput()], ['P2WPKH', 'P2WPKH']);
    const fee = Math.ceil(1 * vbytes);
    // Leave 100 sats of change: below the 546 dust limit.
    const send = 100_000 - fee - 100;
    const result = buildUnsignedPsbt({
      inputs: [wpkhInput()],
      destinationAddress: ADDR_W1,
      sendAmountSats: send,
      feeRateSatsPerVb: 1,
      changeAddress: ADDR_CHANGE0,
    });

    expect(result.changeSats).toBe(0);
    expect(result.feeSats).toBe(fee + 100);
    expect(result.warnings.some((w) => w.includes('dust limit'))).toBe(true);
    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(decoded.txOutputs.length).toBe(1);
  });

  it('attaches BIP-32 derivation info for a P2WPKH input', () => {
    const vbytes = estimateTxVbytes([wpkhInput()], ['P2WPKH']);
    const fee = Math.ceil(2 * vbytes);
    const result = buildUnsignedPsbt({
      inputs: [
        wpkhInput({
          derivation: {
            pubkeyHex: ADDR_W0_PUBKEY,
            masterFingerprintHex: MASTER_FP,
            path: "m/84'/0'/0'/0/0",
          },
        }),
      ],
      destinationAddress: ADDR_W1,
      sendAmountSats: 100_000 - fee,
      feeRateSatsPerVb: 2,
    });

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    const deriv = decoded.data.inputs[0].bip32Derivation;
    expect(deriv).toHaveLength(1);
    expect(bytesToHex(deriv![0].pubkey)).toBe(ADDR_W0_PUBKEY);
    expect(bytesToHex(deriv![0].masterFingerprint)).toBe(MASTER_FP);
    expect(deriv![0].path).toBe("m/84'/0'/0'/0/0");
  });

  it('attaches taproot derivation info as tapBip32Derivation', () => {
    const trInput: PsbtInputSpec = {
      txid: TXID_A,
      vout: 1,
      address: ADDR_TR0,
      amountSats: 80_000,
      scriptType: 'P2TR',
      derivation: {
        pubkeyHex: TR0_INTERNAL_PUBKEY,
        masterFingerprintHex: MASTER_FP,
        path: "m/86'/0'/0'/0/0",
      },
    };
    const vbytes = estimateTxVbytes([trInput], ['P2WPKH']);
    const fee = Math.ceil(2 * vbytes);
    const result = buildUnsignedPsbt({
      inputs: [trInput],
      destinationAddress: ADDR_W1,
      sendAmountSats: 80_000 - fee,
      feeRateSatsPerVb: 2,
    });

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    const input0 = decoded.data.inputs[0];
    expect(bytesToHex(input0.tapInternalKey!)).toBe(TR0_INTERNAL_PUBKEY);
    expect(input0.tapBip32Derivation).toHaveLength(1);
    expect(bytesToHex(input0.tapBip32Derivation![0].pubkey)).toBe(TR0_INTERNAL_PUBKEY);
    expect(input0.tapBip32Derivation![0].path).toBe("m/86'/0'/0'/0/0");
  });

  it('embeds witnessScript for multisig inputs and verifies it against the address', () => {
    const keyA = root.derivePath("m/84'/0'/0'/0/0");
    const keyB = root.derivePath("m/84'/0'/0'/0/1");
    const p2ms = bitcoin.payments.p2ms({
      m: 2,
      pubkeys: [keyA.publicKey, keyB.publicKey],
      network: bitcoin.networks.bitcoin,
    });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: bitcoin.networks.bitcoin });
    const vaultAddress = p2wsh.address!;
    const witnessScriptHex = bytesToHex(p2wsh.redeem!.output!);

    const vaultInput: PsbtInputSpec = {
      txid: TXID_A,
      vout: 0,
      address: vaultAddress,
      amountSats: 150_000,
      scriptType: 'P2WSH',
      witnessScriptHex,
    };
    const result = buildUnsignedPsbt(sendMaxParams(vaultInput));

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(bytesToHex(decoded.data.inputs[0].witnessScript!)).toBe(witnessScriptHex);
  });

  it('embeds witnessScript + redeemScript for wrapped multisig inputs', () => {
    const keyA = root.derivePath("m/84'/0'/0'/0/0");
    const keyB = root.derivePath("m/84'/0'/0'/0/1");
    const p2ms = bitcoin.payments.p2ms({
      m: 2,
      pubkeys: [keyA.publicKey, keyB.publicKey],
      network: bitcoin.networks.bitcoin,
    });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: bitcoin.networks.bitcoin });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wsh, network: bitcoin.networks.bitcoin });

    const wrappedInput: PsbtInputSpec = {
      txid: TXID_A,
      vout: 0,
      address: p2sh.address!,
      amountSats: 150_000,
      scriptType: 'P2SH-P2WSH',
      witnessScriptHex: bytesToHex(p2wsh.redeem!.output!),
      redeemScriptHex: bytesToHex(p2sh.redeem!.output!),
    };
    const result = buildUnsignedPsbt(sendMaxParams(wrappedInput));

    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(bytesToHex(decoded.data.inputs[0].witnessScript!)).toBe(bytesToHex(p2wsh.redeem!.output!));
    expect(bytesToHex(decoded.data.inputs[0].redeemScript!)).toBe(bytesToHex(p2sh.redeem!.output!));
  });

  it('decodePsbtSummary reports the saved shape and that nothing is signed', () => {
    const result = buildUnsignedPsbt(sendMaxParams(wpkhInput()));
    const summary = decodePsbtSummary(result.psbtBase64);
    expect(summary).toEqual({
      inputCount: 1,
      outputCount: 1,
      allInputsHaveWitnessUtxo: true,
      hasSignatures: false,
    });
    expect(() => decodePsbtSummary('not-a-psbt')).toThrow();
  });

  it('combines multiple selected inputs in outpoint order', () => {
    const inputs = [
      wpkhInput(),
      wpkhInput({ txid: TXID_B, vout: 2, address: ADDR_W1, amountSats: 60_000 }),
    ];
    const vbytes = estimateTxVbytes(inputs, ['P2WPKH']);
    const fee = Math.ceil(4 * vbytes);
    const result = buildUnsignedPsbt({
      inputs,
      destinationAddress: ADDR_CHANGE0,
      sendAmountSats: 160_000 - fee,
      feeRateSatsPerVb: 4,
    });
    expect(result.totalInputSats).toBe(160_000);
    const decoded = bitcoin.Psbt.fromBase64(result.psbtBase64);
    expect(decoded.inputCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Signability gate: inputs a signer could never sign are hard-rejected.
  // -------------------------------------------------------------------------
  describe('signability gate', () => {
    it('rejects legacy P2PKH inputs (nonWitnessUtxo unavailable)', () => {
      const p2pkhInput: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: ADDR_P2PKH,
        amountSats: 200_000,
        scriptType: 'P2PKH',
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(p2pkhInput))).toThrow(/legacy P2PKH/);
    });

    it('rejects bare legacy P2SH inputs', () => {
      const legacySh = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2pk({ pubkey: hexToBytes(ADDR_W0_PUBKEY) }),
        network: bitcoin.networks.bitcoin,
      });
      const shInput: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: legacySh.address!,
        amountSats: 150_000,
        scriptType: 'P2SH',
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(shInput))).toThrow(/legacy P2SH/);
    });

    it('rejects multisig inputs without a stored witnessScript', () => {
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: 1,
          pubkeys: [hexToBytes(ADDR_W0_PUBKEY)],
          network: bitcoin.networks.bitcoin,
        }),
        network: bitcoin.networks.bitcoin,
      });
      const vaultInput: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: p2wsh.address!,
        amountSats: 150_000,
        scriptType: 'P2WSH',
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(vaultInput))).toThrow(/witness script/i);
    });

    it('rejects a witnessScript that does not reproduce the input address', () => {
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: 1,
          pubkeys: [hexToBytes(ADDR_W0_PUBKEY)],
          network: bitcoin.networks.bitcoin,
        }),
        network: bitcoin.networks.bitcoin,
      });
      const otherScript = bitcoin.payments.p2ms({
        m: 1,
        pubkeys: [root.derivePath("m/84'/0'/0'/0/2").publicKey],
        network: bitcoin.networks.bitcoin,
      }).output!;
      const vaultInput: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: p2wsh.address!,
        amountSats: 150_000,
        scriptType: 'P2WSH',
        witnessScriptHex: bytesToHex(otherScript),
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(vaultInput))).toThrow(/does not reproduce/);
    });

    it('rejects wrapped multisig inputs missing either script', () => {
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: bitcoin.payments.p2ms({
          m: 1,
          pubkeys: [hexToBytes(ADDR_W0_PUBKEY)],
          network: bitcoin.networks.bitcoin,
        }),
        network: bitcoin.networks.bitcoin,
      });
      const p2sh = bitcoin.payments.p2sh({ redeem: p2wsh, network: bitcoin.networks.bitcoin });
      const base: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: p2sh.address!,
        amountSats: 150_000,
        scriptType: 'P2SH-P2WSH',
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(base))).toThrow(/witness\/redeem scripts/);
      expect(() =>
        buildUnsignedPsbt(
          sendMaxParams({ ...base, witnessScriptHex: bytesToHex(p2wsh.redeem!.output!) }),
        ),
      ).toThrow(/witness\/redeem scripts/);
    });

    it('rejects wrapped SegWit inputs without verified derivation (pubkey unknown)', () => {
      const key = root.derivePath("m/49'/0'/0'/0/0");
      const p2sh = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.bitcoin }),
        network: bitcoin.networks.bitcoin,
      });
      const wrappedInput: PsbtInputSpec = {
        txid: TXID_A,
        vout: 0,
        address: p2sh.address!,
        amountSats: 150_000,
        scriptType: 'P2SH-P2WPKH',
      };
      expect(() => buildUnsignedPsbt(sendMaxParams(wrappedInput))).toThrow(/pubkey is unknown/);
    });

    it('rejects unrecognized script types', () => {
      expect(() =>
        buildUnsignedPsbt(sendMaxParams(wpkhInput({ scriptType: 'Unknown' }))),
      ).toThrow(/unrecognized/);
    });
  });

  describe('validation errors', () => {
    const base = {
      destinationAddress: ADDR_W1,
      feeRateSatsPerVb: 2,
    };

    it('rejects an invalid destination address', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput()], sendAmountSats: 50_000, destinationAddress: 'bc1qnotanaddress' }),
      ).toThrow(/destination/i);
    });

    it('rejects a destination on the wrong network', () => {
      expect(() =>
        buildUnsignedPsbt({
          ...base,
          inputs: [wpkhInput()],
          sendAmountSats: 50_000,
          destinationAddress: 'tb1qfm5fkr0d3n9u9y8z4k4qqqqqqqqqqqqqqqqqqq',
        }),
      ).toThrow(/destination/i);
    });

    it('rejects a fee rate below the relay minimum', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput()], sendAmountSats: 50_000, feeRateSatsPerVb: 0 }),
      ).toThrow(/fee rate/i);
    });

    it('rejects duplicate outpoints', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput(), wpkhInput()], sendAmountSats: 50_000 }),
      ).toThrow(/twice/i);
    });

    it('rejects sends that exceed inputs plus fee', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput()], sendAmountSats: 99_999, feeRateSatsPerVb: 50 }),
      ).toThrow(/insufficient funds/i);
    });

    it('rejects a below-dust send amount', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput()], sendAmountSats: DUST_LIMIT_SATS - 1 }),
      ).toThrow(/dust/i);
    });

    it('requires a change address when there is leftover', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput()], sendAmountSats: 50_000 }),
      ).toThrow(/change address/i);
    });

    it('rejects an invalid input address', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput({ address: 'not-an-address' })], sendAmountSats: 50_000 }),
      ).toThrow(/input/i);
    });

    it('rejects malformed txids', () => {
      expect(() =>
        buildUnsignedPsbt({ ...base, inputs: [wpkhInput({ txid: 'xyz' })], sendAmountSats: 50_000 }),
      ).toThrow(/transaction id/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Sign + finalize: prove an external signer can actually sign what we build.
// Keys are derived from the public BIP-84 test mnemonic — no real funds.
// ---------------------------------------------------------------------------
describe('signability (sign + finalize round trip)', () => {
  it('a P2WPKH PSBT signs, validates, finalizes, and extracts', () => {
    const key = root.derivePath("m/84'/0'/0'/0/0");
    expect(bytesToHex(key.publicKey)).toBe(ADDR_W0_PUBKEY); // sanity: key matches the address

    const result = buildUnsignedPsbt(
      sendMaxParams(
        wpkhInput({
          derivation: {
            pubkeyHex: bytesToHex(key.publicKey),
            masterFingerprintHex: MASTER_FP,
            path: "m/84'/0'/0'/0/0",
          },
        }),
      ),
    );

    const psbt = bitcoin.Psbt.fromBase64(result.psbtBase64);
    psbt.signInput(0, key);
    expect(psbt.validateSignaturesOfInput(0, validator)).toBe(true);
    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    expect(tx.ins).toHaveLength(1);
    expect(bytesToHex(tx.ins[0].hash)).toBe(TXID_A);
    expect(tx.ins[0].witness.length).toBe(2); // signature + pubkey
    expect(tx.outs[0].value).toBe(BigInt(result.sendAmountSats));
    expect(tx.virtualSize()).toBeLessThanOrEqual(result.estimatedVbytes);
  });

  it('a wrapped SegWit (P2SH-P2WPKH) PSBT gets its redeemScript from derivation and signs', () => {
    const key = root.derivePath("m/49'/0'/0'/0/0");
    const p2sh = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.bitcoin }),
      network: bitcoin.networks.bitcoin,
    });

    const wrappedInput: PsbtInputSpec = {
      txid: TXID_A,
      vout: 0,
      address: p2sh.address!,
      amountSats: 120_000,
      scriptType: 'P2SH-P2WPKH',
      derivation: {
        pubkeyHex: bytesToHex(key.publicKey),
        masterFingerprintHex: MASTER_FP,
        path: "m/49'/0'/0'/0/0",
      },
    };
    const result = buildUnsignedPsbt(sendMaxParams(wrappedInput));

    const psbt = bitcoin.Psbt.fromBase64(result.psbtBase64);
    // The gate reconstructed the redeemScript from the verified pubkey.
    expect(psbt.data.inputs[0].redeemScript).toBeDefined();
    psbt.signInput(0, key);
    expect(psbt.validateSignaturesOfInput(0, validator)).toBe(true);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    expect(tx.ins[0].script.length).toBeGreaterThan(0); // wrapped: scriptSig carries the redeem script
    expect(tx.ins[0].witness.length).toBe(2);
  });

  it('a 2-of-2 multisig P2WSH PSBT signs with both keys and finalizes', () => {
    const keyA = root.derivePath("m/84'/0'/0'/0/0");
    const keyB = root.derivePath("m/84'/0'/0'/0/1");
    const p2ms = bitcoin.payments.p2ms({
      m: 2,
      pubkeys: [keyA.publicKey, keyB.publicKey],
      network: bitcoin.networks.bitcoin,
    });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: bitcoin.networks.bitcoin });

    const vaultInput: PsbtInputSpec = {
      txid: TXID_A,
      vout: 0,
      address: p2wsh.address!,
      amountSats: 150_000,
      scriptType: 'P2WSH',
      witnessScriptHex: bytesToHex(p2wsh.redeem!.output!),
    };
    const result = buildUnsignedPsbt(sendMaxParams(vaultInput));

    const psbt = bitcoin.Psbt.fromBase64(result.psbtBase64);
    psbt.signInput(0, keyA);
    psbt.signInput(0, keyB);
    expect(psbt.validateSignaturesOfInput(0, validator)).toBe(true);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    // witness: dummy + sig A + sig B + witnessScript
    expect(tx.ins[0].witness.length).toBe(4);
  });
});
