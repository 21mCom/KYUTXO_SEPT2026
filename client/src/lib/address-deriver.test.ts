// Unit tests for the Address Deriver lib: input classification (extended keys
// and every supported descriptor kind, incl. malformed inputs and testnet
// prefixes), derivation wiring against known BIP test vectors, chain-toggle
// behavior, and the formula-safe CSV builder.

import { describe, it, expect, vi } from "vitest";

// csv-export pulls the Dexie-backed record CRUD module at import time; the
// deriver only uses its pure csvField/csvEscape helpers, so stub the DB seam.
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsAfterId: vi.fn(),
}));

import {
  analyzeDeriverInput,
  deriveDeriverAddresses,
  deriverRowToCsv,
  deriverRowsToCsv,
  addressDeriverCsvFilename,
  ADDRESS_DERIVER_CSV_HEADER,
  ADDRESS_DERIVER_MAX_COUNT,
} from "./address-deriver";
import { convertExtendedKeyPrefix } from "./xpub";

// BIP-84 test vector (m/84'/0'/0') — first receive address is well known.
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const BIP84_FIRST_RECEIVE = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

// Taproot derivation of the same test-vector key material (xpub re-encoding
// of the BIP-84 key above); the first tr() receive address was computed once
// with the lib's own deriveTaprootDualChain and pinned here.
const TR_XPUB =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
const TR_FIRST_RECEIVE = "bc1p8knh0enfv47gmpuf66528zd4jtkgjq4sv5w5l2gqwgk8exu2ynns9g8c9m";

const BIP84_AS_XPUB = convertExtendedKeyPrefix(BIP84_ZPUB, "xpub");
const BIP84_AS_YPUB = convertExtendedKeyPrefix(BIP84_ZPUB, "ypub");
const BIP84_AS_VPUB = convertExtendedKeyPrefix(BIP84_ZPUB, "vpub");

describe("analyzeDeriverInput", () => {
  it("rejects empty input", () => {
    const result = analyzeDeriverInput("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/paste/i);
  });

  it("rejects garbage that is neither a key nor a descriptor", () => {
    const result = analyzeDeriverInput("hello world this is not a key");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects a corrupted extended key", () => {
    const result = analyzeDeriverInput(BIP84_ZPUB.slice(0, -4) + "XXXX");
    expect(result.ok).toBe(false);
  });

  it("classifies a mainnet zpub as a BIP84 extended key", () => {
    const result = analyzeDeriverInput(BIP84_ZPUB);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("extended-key");
    expect(result.network).toBe("mainnet");
    expect(result.bipStandard).toBe("BIP84");
    expect(result.scriptTypeLabel).toMatch(/P2WPKH/i);
  });

  it("classifies ypub/xpub prefixes with their BIP standards", () => {
    expect(analyzeDeriverInput(BIP84_AS_YPUB).bipStandard).toBe("BIP49");
    expect(analyzeDeriverInput(BIP84_AS_XPUB).bipStandard).toBe("BIP44");
  });

  it("classifies a testnet vpub as testnet BIP84", () => {
    const result = analyzeDeriverInput(BIP84_AS_VPUB);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("extended-key");
    expect(result.network).toBe("testnet");
    expect(result.bipStandard).toBe("BIP84");
  });

  it("classifies a wpkh single-sig descriptor", () => {
    const result = analyzeDeriverInput(
      `wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/<0;1>/*)`,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("single-sig-descriptor");
    expect(result.network).toBe("mainnet");
    expect(result.scriptTypeLabel).toMatch(/P2WPKH/i);
    expect(result.chainType).toBe("dual-chain");
  });

  it("classifies a sh(wpkh) single-sig descriptor", () => {
    const result = analyzeDeriverInput(`sh(wpkh(${BIP84_AS_YPUB}/<0;1>/*))`);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("single-sig-descriptor");
    expect(result.scriptTypeLabel).toMatch(/P2SH-P2WPKH/i);
  });

  it("classifies a pkh single-sig descriptor", () => {
    const result = analyzeDeriverInput(`pkh(${BIP84_AS_XPUB}/<0;1>/*)`);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("single-sig-descriptor");
    expect(result.scriptTypeLabel).toMatch(/P2PKH/i);
  });

  it("detects a receive-only single chain descriptor", () => {
    const result = analyzeDeriverInput(`wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/0/*)`);
    expect(result.ok).toBe(true);
    expect(result.chainType).toBe("receive-only");
  });

  it("classifies a taproot tr() descriptor", () => {
    const result = analyzeDeriverInput(`tr([73c5da0a/86'/0'/0']${TR_XPUB}/<0;1>/*)`);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("taproot-descriptor");
    expect(result.network).toBe("mainnet");
    expect(result.scriptTypeLabel).toMatch(/Taproot/i);
  });

  it("classifies a wsh sortedmulti descriptor with threshold info", () => {
    const result = analyzeDeriverInput(
      `wsh(sortedmulti(2,[aaaaaaaa/48'/0'/0'/2']${TR_XPUB}/<0;1>/*,[bbbbbbbb/48'/0'/0'/2']${BIP84_AS_XPUB}/<0;1>/*))`,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("multisig-descriptor");
    expect(result.threshold).toBe(2);
    expect(result.keyCount).toBe(2);
    expect(result.scriptTypeLabel).toMatch(/P2WSH/i);
  });

  it("rejects a descriptor with an invalid inner key", () => {
    const result = analyzeDeriverInput("wpkh(xpubINVALIDKEY/<0;1>/*)");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("deriveDeriverAddresses", () => {
  it("derives BIP84 receive addresses from a bare zpub", async () => {
    const analysis = analyzeDeriverInput(BIP84_ZPUB);
    const rows = await deriveDeriverAddresses(analysis, 3, false);
    expect(rows).toHaveLength(3);
    expect(rows[0].address).toBe(BIP84_FIRST_RECEIVE);
    expect(rows.every(r => r.chain === "receive")).toBe(true);
    expect(rows.map(r => r.index)).toEqual([0, 1, 2]);
    expect(rows[0].path).toContain("/0/0");
  });

  it("derives both chains when includeChange is on", async () => {
    const analysis = analyzeDeriverInput(BIP84_ZPUB);
    const rows = await deriveDeriverAddresses(analysis, 2, true);
    expect(rows).toHaveLength(4);
    expect(rows.filter(r => r.chain === "receive")).toHaveLength(2);
    expect(rows.filter(r => r.chain === "change")).toHaveLength(2);
    expect(rows.find(r => r.chain === "change")!.address).toMatch(/^bc1q/);
  });

  it("derives legacy addresses from an xpub and nested-segwit from a ypub", async () => {
    const legacy = await deriveDeriverAddresses(analyzeDeriverInput(BIP84_AS_XPUB), 1, false);
    expect(legacy[0].address).toMatch(/^1/);
    const nested = await deriveDeriverAddresses(analyzeDeriverInput(BIP84_AS_YPUB), 1, false);
    expect(nested[0].address).toMatch(/^3/);
  });

  it("derives testnet addresses from a vpub", async () => {
    const rows = await deriveDeriverAddresses(analyzeDeriverInput(BIP84_AS_VPUB), 2, false);
    expect(rows[0].address).toMatch(/^tb1q/);
  });

  it("derives the same first address through a wpkh descriptor", async () => {
    const analysis = analyzeDeriverInput(
      `wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/<0;1>/*)`,
    );
    const rows = await deriveDeriverAddresses(analysis, 1, false);
    expect(rows[0].address).toBe(BIP84_FIRST_RECEIVE);
  });

  it("respects a receive-only descriptor even when change is toggled on", async () => {
    const analysis = analyzeDeriverInput(`wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/0/*)`);
    const rows = await deriveDeriverAddresses(analysis, 2, true);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.chain === "receive")).toBe(true);
  });

  it("derives only the change chain for a change-only descriptor", async () => {
    const analysis = analyzeDeriverInput(`wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/1/*)`);
    const rows = await deriveDeriverAddresses(analysis, 2, false);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.chain === "change")).toBe(true);
  });

  it("derives the BIP86 test vector first address from a tr() descriptor", async () => {
    const analysis = analyzeDeriverInput(`tr([73c5da0a/86'/0'/0']${TR_XPUB}/<0;1>/*)`);
    const rows = await deriveDeriverAddresses(analysis, 1, false);
    expect(rows[0].address).toBe(TR_FIRST_RECEIVE);
    expect(rows[0].chain).toBe("receive");
  });

  it("derives multisig addresses from a wsh sortedmulti descriptor", async () => {
    const analysis = analyzeDeriverInput(
      `wsh(sortedmulti(2,[aaaaaaaa/48'/0'/0'/2']${TR_XPUB}/<0;1>/*,[bbbbbbbb/48'/0'/0'/2']${BIP84_AS_XPUB}/<0;1>/*))`,
    );
    const receiveOnly = await deriveDeriverAddresses(analysis, 3, false);
    expect(receiveOnly).toHaveLength(3);
    expect(receiveOnly[0].address).toMatch(/^bc1q/);
    expect(receiveOnly[0].path).toBe("0/0");

    const both = await deriveDeriverAddresses(analysis, 2, true);
    expect(both).toHaveLength(4);
    expect(both.filter(r => r.chain === "change")[0].path).toBe("1/0");
  });

  it("rejects non-positive and over-cap counts", async () => {
    const analysis = analyzeDeriverInput(BIP84_ZPUB);
    await expect(deriveDeriverAddresses(analysis, 0, false)).rejects.toThrow(/whole number/i);
    await expect(deriveDeriverAddresses(analysis, ADDRESS_DERIVER_MAX_COUNT + 1, false)).rejects.toThrow(
      /maximum/i,
    );
  });

  it("throws the analysis error when derivation is attempted on a failed analysis", async () => {
    const analysis = analyzeDeriverInput("garbage");
    await expect(deriveDeriverAddresses(analysis, 5, false)).rejects.toThrow();
  });
});

describe("CSV builder", () => {
  const sampleRows = [
    { address: "bc1qexample000000000000000000000000000000x", chain: "receive" as const, index: 0, path: "m/84'/0'/0'/0/0" },
    { address: "bc1qexample111111111111111111111111111111x", chain: "change" as const, index: 1, path: "m/84'/0'/0'/1/1" },
  ];

  it("emits the header and one line per row with CRLF endings", () => {
    const csv = deriverRowsToCsv(sampleRows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(ADDRESS_DERIVER_CSV_HEADER.join(","));
    expect(lines[1]).toContain(sampleRows[0].address);
    expect(lines[1]).toContain(",receive,0,");
    expect(lines[2]).toContain(",change,1,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("apostrophe-prefixes formula sigils in string cells", () => {
    const row = deriverRowToCsv({ address: "=1+1", chain: "receive", index: 0, path: "+0/0" });
    const [addressCell, , , pathCell] = row.split(",");
    expect(addressCell.startsWith("'=")).toBe(true);
    expect(pathCell.startsWith("'+")).toBe(true);
  });

  it("quotes cells containing commas", () => {
    const row = deriverRowToCsv({ address: "bc1qfoo", chain: "receive", index: 4, path: "weird,path/0" });
    expect(row).toContain('"weird,path/0"');
  });

  it("builds a descriptive filename", () => {
    const analysis = analyzeDeriverInput(BIP84_ZPUB);
    expect(addressDeriverCsvFilename(analysis, 20)).toBe(
      "derived-addresses-extended-key-mainnet-20.csv",
    );
  });
});
