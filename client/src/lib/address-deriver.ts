// Address Deriver: paste-only, display-only address derivation.
//
// Classifies a pasted extended public key (xpub/ypub/zpub/tpub/upub/vpub) or
// wallet descriptor (single-sig wpkh/pkh/sh(wpkh), taproot tr(...), or
// multisig wsh/sh(wsh)/sh with multi/sortedmulti), then derives addresses with
// the existing xpub/descriptor utilities. NOTHING here touches the vault
// database — every function is pure derivation over the pasted input.

import {
  analyzeXpub,
  validateExtendedPublicKey,
  deriveAddressesForChain,
  deriveTaprootDualChain,
  deriveMultisigDualChain,
  convertExtendedKeyPrefix,
  getBipDescription,
  getMultisigScriptTypeDescription,
  type BipStandard,
  type MultisigScriptType,
} from "./xpub";
import {
  parseDescriptor,
  descriptorKeysToXpubEntries,
  type ParsedDescriptor,
  type ParsedSingleSigDescriptor,
  type DescriptorChainType,
} from "./descriptor-parser";
import { singleSigTargetPrefix } from "./descriptor-import-utils";
import { csvField, csvEscape } from "./csv-export";

// Maximum addresses derived per chain in one run (matches the underlying
// derivation utilities' own 500-address window).
export const ADDRESS_DERIVER_MAX_COUNT = 500;

export type DeriverInputKind =
  | "extended-key"
  | "single-sig-descriptor"
  | "taproot-descriptor"
  | "multisig-descriptor";

export interface DeriverInputAnalysis {
  ok: boolean;
  kind?: DeriverInputKind;
  network?: "mainnet" | "testnet";
  /** Human-readable script type / BIP standard line for the detected-input summary. */
  scriptTypeLabel?: string;
  /** BIP standard for bare extended keys (BIP44/49/84). */
  bipStandard?: BipStandard;
  /** Which chain(s) the input covers; bare keys are always dual-chain. */
  chainType?: DescriptorChainType;
  /** Multisig threshold / signer count (multisig descriptors only). */
  threshold?: number;
  keyCount?: number;
  /** Optional caveat from key analysis (e.g. non-standard header, Electrum-style key). */
  note?: string;
  error?: string;

  // Parsed internals consumed by deriveDeriverAddresses (not for display).
  extendedKey?: string;
  isChainLevelKey?: boolean;
  singleSig?: ParsedSingleSigDescriptor;
  descriptor?: ParsedDescriptor;
}

const DESCRIPTOR_START = /^(wpkh|pkh|sh|wsh|tr)\s*\(/i;

/**
 * Classifies pasted input as a bare extended key or one of the supported
 * descriptor kinds. Returns a discriminated result the UI can render directly:
 * `ok` + display labels on success, `error` with a clear message otherwise.
 */
export function analyzeDeriverInput(rawInput: string): DeriverInputAnalysis {
  const trimmed = (rawInput || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Paste an extended public key or a wallet descriptor to derive addresses." };
  }

  const looksLikeDescriptor = DESCRIPTOR_START.test(trimmed) || trimmed.includes("(");
  if (looksLikeDescriptor) {
    const parsed = parseDescriptor(trimmed);

    if (parsed.success && parsed.descriptor) {
      const d = parsed.descriptor;
      if (d.isTaproot) {
        return {
          ok: true,
          kind: "taproot-descriptor",
          network: d.network,
          scriptTypeLabel: "Taproot (P2TR, BIP86)",
          chainType: d.chainType,
          descriptor: d,
        };
      }
      return {
        ok: true,
        kind: "multisig-descriptor",
        network: d.network,
        scriptTypeLabel: `${getMultisigScriptTypeDescription(d.scriptType as MultisigScriptType)} — ${d.threshold}-of-${d.keys.length} ${d.isSortedMulti ? "sortedmulti" : "multi"}`,
        chainType: d.chainType,
        threshold: d.threshold,
        keyCount: d.keys.length,
        descriptor: d,
      };
    }

    if (parsed.singleSig) {
      const s = parsed.singleSig;
      const labels: Record<string, string> = {
        p2wpkh: "Native SegWit (P2WPKH, BIP84)",
        "p2sh-p2wpkh": "Nested SegWit (P2SH-P2WPKH, BIP49)",
        p2pkh: "Legacy (P2PKH, BIP44)",
      };
      return {
        ok: true,
        kind: "single-sig-descriptor",
        network: s.network,
        scriptTypeLabel: labels[s.scriptType] || s.scriptType,
        chainType: s.chainType,
        singleSig: s,
      };
    }

    return {
      ok: false,
      error: parsed.error || "Could not parse this descriptor.",
    };
  }

  const validation = validateExtendedPublicKey(trimmed);
  if (!validation.valid) {
    return {
      ok: false,
      error: `Not a recognized extended public key or descriptor. ${validation.error || ""}`.trim(),
    };
  }

  let info;
  try {
    info = analyzeXpub(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not analyze this extended public key.",
    };
  }

  if (info.needsAdvancedMode) {
    return {
      ok: false,
      error: `This key is at depth ${info.depth} and needs a custom derivation path, which the Address Deriver does not support. Use an account-level (depth 3), chain-level (depth 4), or Electrum-style key.`,
    };
  }

  return {
    ok: true,
    kind: "extended-key",
    network: info.network,
    bipStandard: info.bipStandard,
    scriptTypeLabel: getBipDescription(info.bipStandard),
    chainType: info.isChainLevel ? "receive-only" : "dual-chain",
    note: info.reason,
    extendedKey: trimmed,
    isChainLevelKey: info.isChainLevel,
  };
}

export interface DerivedAddressRow {
  address: string;
  chain: "receive" | "change";
  index: number;
  path: string;
}

// Resolves which chains to derive given the input's own chain coverage and the
// user's include-change toggle. Single-chain descriptors always derive their
// one chain; dual-chain inputs follow the toggle.
function resolveChains(
  chainType: DescriptorChainType,
  includeChange: boolean,
  singleChainOnly: boolean,
): { wantReceive: boolean; wantChange: boolean } {
  if (singleChainOnly) {
    // Chain-level key: one chain only, reported as receive.
    return { wantReceive: true, wantChange: false };
  }
  if (chainType === "receive-only") return { wantReceive: true, wantChange: false };
  if (chainType === "change-only") return { wantReceive: false, wantChange: true };
  return { wantReceive: true, wantChange: includeChange };
}

function validateCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Enter a whole number of addresses (at least 1).");
  }
  if (count > ADDRESS_DERIVER_MAX_COUNT) {
    throw new Error(`Maximum ${ADDRESS_DERIVER_MAX_COUNT} addresses per chain can be derived at once.`);
  }
}

/**
 * Derives `count` addresses per selected chain for a previously analyzed
 * input. Returns one normalized row list (receive rows first, then change).
 */
export async function deriveDeriverAddresses(
  analysis: DeriverInputAnalysis,
  count: number,
  includeChange: boolean,
): Promise<DerivedAddressRow[]> {
  validateCount(count);
  if (!analysis.ok || !analysis.kind) {
    throw new Error(analysis.error || "Input is not valid.");
  }

  if (analysis.kind === "extended-key") {
    const key = analysis.extendedKey!;
    const { wantReceive, wantChange } = resolveChains(
      analysis.chainType || "dual-chain",
      includeChange,
      !!analysis.isChainLevelKey,
    );
    const rows: DerivedAddressRow[] = [];
    if (wantReceive) {
      for (const a of await deriveAddressesForChain(key, 0, 0, count - 1)) {
        rows.push({ address: a.address, chain: "receive", index: a.index, path: a.path });
      }
    }
    if (wantChange) {
      for (const a of await deriveAddressesForChain(key, 1, 0, count - 1)) {
        rows.push({ address: a.address, chain: "change", index: a.index, path: a.path });
      }
    }
    return rows;
  }

  if (analysis.kind === "single-sig-descriptor") {
    const d = analysis.singleSig!;
    const convertedKey = convertExtendedKeyPrefix(
      d.key.xpub,
      singleSigTargetPrefix(d.scriptType, d.network),
    );
    // A chain-level (depth 4) key can only produce its own single chain even
    // when the descriptor says dual-chain.
    let atChainLevel = false;
    try {
      atChainLevel = analyzeXpub(convertedKey).isChainLevel;
    } catch {
      atChainLevel = false;
    }
    const { wantReceive, wantChange } = resolveChains(d.chainType, includeChange, atChainLevel);
    const rows: DerivedAddressRow[] = [];
    if (wantReceive) {
      for (const a of await deriveAddressesForChain(convertedKey, 0, 0, count - 1)) {
        rows.push({ address: a.address, chain: "receive", index: a.index, path: a.path });
      }
    }
    if (wantChange) {
      for (const a of await deriveAddressesForChain(convertedKey, 1, 0, count - 1)) {
        rows.push({ address: a.address, chain: "change", index: a.index, path: a.path });
      }
    }
    return rows;
  }

  if (analysis.kind === "taproot-descriptor") {
    const d = analysis.descriptor!;
    const key = d.keys[0];
    const rawPath = key.rawChainPath || key.chainPath || "/*";
    const skipChainDerivation = rawPath === "/*";
    const { wantReceive, wantChange } = resolveChains(
      d.chainType,
      includeChange,
      skipChainDerivation,
    );
    const result = await deriveTaprootDualChain(
      key.xpub,
      key.fingerprint,
      key.derivationPath,
      0,
      wantReceive ? count - 1 : -1,
      0,
      wantChange ? count - 1 : -1,
      d.network,
      skipChainDerivation,
    );
    const rows: DerivedAddressRow[] = [];
    for (const a of result.receive) {
      rows.push({ address: a.address, chain: "receive", index: a.index, path: a.path });
    }
    for (const a of result.change) {
      rows.push({ address: a.address, chain: "change", index: a.index, path: a.path });
    }
    return rows;
  }

  // multisig-descriptor
  const d = analysis.descriptor!;
  const { wantReceive, wantChange } = resolveChains(d.chainType, includeChange, false);
  const result = await deriveMultisigDualChain(
    {
      xpubs: descriptorKeysToXpubEntries(d.keys),
      m: d.threshold,
      n: d.keys.length,
      scriptType: d.scriptType as MultisigScriptType,
    },
    0,
    wantReceive ? count - 1 : -1,
    0,
    wantChange ? count - 1 : -1,
  );
  const rows: DerivedAddressRow[] = [];
  for (const a of result.receive) {
    rows.push({ address: a.address, chain: "receive", index: a.index, path: `0/${a.index}` });
  }
  for (const a of result.change) {
    rows.push({ address: a.address, chain: "change", index: a.index, path: `1/${a.index}` });
  }
  return rows;
}

// ── CSV export ──────────────────────────────────────────────────────────────

export const ADDRESS_DERIVER_CSV_HEADER = ["Address", "Chain", "Index", "Derivation Path"] as const;

// One CSV row. Address/chain/path come from key material the user pasted, so
// every string cell goes through the formula-safe csvField helper; the index
// is serialized from a number and only needs RFC 4180 escaping.
export function deriverRowToCsv(row: DerivedAddressRow): string {
  return [
    csvField(row.address),
    csvField(row.chain),
    csvEscape(String(row.index)),
    csvField(row.path),
  ].join(",");
}

// Full CSV document (header + CRLF rows) ready for a Blob.
export function deriverRowsToCsv(rows: DerivedAddressRow[]): string {
  const lines = [ADDRESS_DERIVER_CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(deriverRowToCsv(row));
  }
  return lines.join("\r\n") + "\r\n";
}

export function addressDeriverCsvFilename(analysis: DeriverInputAnalysis, rowCount: number): string {
  const network = analysis.network || "unknown";
  const kind = analysis.kind || "addresses";
  return `derived-addresses-${kind}-${network}-${rowCount}.csv`;
}
