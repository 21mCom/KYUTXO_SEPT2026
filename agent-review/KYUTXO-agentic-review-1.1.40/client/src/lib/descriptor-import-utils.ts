/**
 * Shared logic for the Descriptor Import flow:
 *
 * 1. analyzeDescriptorInput — one entry point that classifies pasted/dropped
 *    content (BSMS file, Sparrow JSON export, or raw descriptor), parses it,
 *    and returns either a parsed descriptor or a clear, actionable error.
 *    Both the dropzone and the paste handler use this so their behavior can
 *    never drift apart.
 *
 * 2. computeExistingRecordMerge — the pure merge policy applied when a
 *    derived address already exists in the vault: tags/categories are
 *    merged, scalar fields (owner, wallet name, seed name, software, notes)
 *    keep the existing value. Crucially it REPORTS which user-entered fields
 *    were kept-as-existing so the UI can tell the user instead of silently
 *    dropping their input.
 */
import { parseBSMS, isBSMSFile } from './bsms-parser';
import {
  parseDescriptor,
  parseSparrowExport,
  type ParsedDescriptor,
  type ParsedSingleSigDescriptor,
  type SingleSigScriptType,
  type DescriptorChainType,
} from './descriptor-parser';
import { convertExtendedKeyPrefix, type XpubPrefix } from './xpub';

export type DescriptorInputSource = 'bsms' | 'sparrow' | 'raw';

export interface DescriptorInputAnalysis {
  ok: boolean;
  source: DescriptorInputSource;
  /** Parsed descriptor when ok */
  descriptor?: ParsedDescriptor;
  /** The raw descriptor string that was (or failed to be) parsed */
  rawDescriptor?: string;
  /** BSMS line-4 verification address, when present */
  firstAddress?: string;
  /** Sparrow export label, when present */
  walletLabel?: string;
  /** Wallet software to preselect (e.g. Nunchuk for BSMS) */
  suggestedSoftware?: string;
  /**
   * Set when the input is a valid single-sig descriptor (wpkh/pkh/sh(wpkh)).
   * ok stays false — this flow can't save single-sig — but the UI should
   * offer an Address Importer handoff instead of a dead-end error.
   */
  singleSig?: ParsedSingleSigDescriptor;
  error?: string;
}

export function analyzeDescriptorInput(
  content: string,
  filename = '',
): DescriptorInputAnalysis {
  const trimmed = (content || '').trim();
  if (!trimmed) {
    return { ok: false, source: 'raw', error: 'Input is empty' };
  }

  if (isBSMSFile(content, filename)) {
    const bsms = parseBSMS(content);
    if (!bsms.success || !bsms.descriptor) {
      return {
        ok: false,
        source: 'bsms',
        error: bsms.error || 'Could not parse BSMS file',
      };
    }
    const parsed = parseDescriptor(bsms.descriptor);
    if (!parsed.success || !parsed.descriptor) {
      return {
        ok: false,
        source: 'bsms',
        rawDescriptor: bsms.descriptor,
        firstAddress: bsms.firstAddress,
        singleSig: parsed.singleSig,
        error: `The BSMS file was read, but its descriptor could not be parsed: ${parsed.error || 'unknown parse error'}`,
      };
    }
    return {
      ok: true,
      source: 'bsms',
      descriptor: parsed.descriptor,
      rawDescriptor: bsms.descriptor,
      firstAddress: bsms.firstAddress,
      suggestedSoftware: 'Nunchuk',
    };
  }

  const looksLikeJson = trimmed.startsWith('{');
  if (!looksLikeJson) {
    const parsed = parseDescriptor(trimmed);
    if (!parsed.success || !parsed.descriptor) {
      return {
        ok: false,
        source: 'raw',
        rawDescriptor: trimmed,
        singleSig: parsed.singleSig,
        error: parsed.error || 'Unknown parse error',
      };
    }
    return {
      ok: true,
      source: 'raw',
      descriptor: parsed.descriptor,
      rawDescriptor: trimmed,
    };
  }

  const sparrow = parseSparrowExport(content);
  if (sparrow.export) {
    const parsed = parseDescriptor(sparrow.export.descriptor);
    if (!parsed.success || !parsed.descriptor) {
      return {
        ok: false,
        source: 'sparrow',
        rawDescriptor: sparrow.export.descriptor,
        walletLabel: sparrow.export.label,
        singleSig: parsed.singleSig,
        error: parsed.error || 'Unknown parse error',
      };
    }
    return {
      ok: true,
      source: 'sparrow',
      descriptor: parsed.descriptor,
      rawDescriptor: sparrow.export.descriptor,
      walletLabel: sparrow.export.label,
    };
  }

  return {
    ok: false,
    source: 'sparrow',
    error:
      sparrow.error ||
      'Could not find a descriptor in this JSON file. Expected a Sparrow wallet export with a "descriptor" field.',
  };
}

// ── Single-sig → Address Importer handoff ──────────────────────────────────

/**
 * The SLIP-132 prefix whose derivation produces the script type the
 * descriptor specified (prefix drives address type in the Address Importer).
 */
export function singleSigTargetPrefix(
  scriptType: SingleSigScriptType,
  network: 'mainnet' | 'testnet',
): XpubPrefix {
  if (scriptType === 'p2wpkh') return network === 'testnet' ? 'vpub' : 'zpub';
  if (scriptType === 'p2sh-p2wpkh') return network === 'testnet' ? 'upub' : 'ypub';
  return network === 'testnet' ? 'tpub' : 'xpub';
}

export interface BulkImportHandoff {
  xpub: string;
  scriptType: SingleSigScriptType;
  chainType: DescriptorChainType;
  fingerprint?: string;
  derivationPath?: string;
}

/**
 * Builds the Address Importer URL for a parsed single-sig descriptor. The key
 * is re-encoded under the prefix matching the descriptor's script type so the
 * derived addresses match what the descriptor specifies.
 */
export function buildBulkImportHandoffUrl(descriptor: ParsedSingleSigDescriptor): string {
  const targetPrefix = singleSigTargetPrefix(descriptor.scriptType, descriptor.network);
  const xpub = convertExtendedKeyPrefix(descriptor.key.xpub, targetPrefix);
  const params = new URLSearchParams();
  params.set('source', 'descriptor');
  params.set('xpub', xpub);
  params.set('scriptType', descriptor.scriptType);
  params.set('chains', descriptor.chainType);
  if (descriptor.key.fingerprint && descriptor.key.fingerprint !== '00000000') {
    params.set('fingerprint', descriptor.key.fingerprint);
  }
  if (descriptor.key.derivationPath) {
    params.set('path', descriptor.key.derivationPath);
  }
  return `/import?${params.toString()}`;
}

/** Parses the handoff query params on the Address Importer side. */
export function parseBulkImportHandoffParams(search: string): BulkImportHandoff | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('source') !== 'descriptor') return null;
  const xpub = (params.get('xpub') || '').trim();
  if (!xpub) return null;
  const scriptTypeRaw = params.get('scriptType');
  const scriptType: SingleSigScriptType =
    scriptTypeRaw === 'p2pkh' || scriptTypeRaw === 'p2sh-p2wpkh' ? scriptTypeRaw : 'p2wpkh';
  const chainsRaw = params.get('chains');
  const chainType: DescriptorChainType =
    chainsRaw === 'receive-only' || chainsRaw === 'change-only' ? chainsRaw : 'dual-chain';
  return {
    xpub,
    scriptType,
    chainType,
    fingerprint: params.get('fingerprint') || undefined,
    derivationPath: params.get('path') || undefined,
  };
}

// ── Existing-record merge policy ────────────────────────────────────────────

export type MetadataFieldKey =
  | 'owner'
  | 'walletName'
  | 'seedName'
  | 'walletSoftware'
  | 'notes';

export const METADATA_FIELD_LABELS: Record<MetadataFieldKey, string> = {
  owner: 'Owner',
  walletName: 'Wallet name',
  seedName: 'Seed name',
  walletSoftware: 'Wallet software',
  notes: 'Notes',
};

const METADATA_FIELD_KEYS: MetadataFieldKey[] = [
  'owner',
  'walletName',
  'seedName',
  'walletSoftware',
  'notes',
];

export interface EnteredMetadata {
  owner?: string;
  walletName?: string;
  seedName?: string;
  walletSoftware?: string;
  notes?: string;
  tags: string[];
  categories: string[];
}

export interface ExistingRecordFields {
  owner?: string;
  walletName?: string;
  seedName?: string;
  walletSoftware?: string;
  notes?: string;
  tags?: string[];
  categories?: string[];
}

export interface ExistingRecordMerge {
  /** Values to write for the scalar metadata fields (existing wins). */
  fields: Partial<Record<MetadataFieldKey, string | undefined>>;
  /** Merged (union) tag / category lists. */
  tags: string[];
  categories: string[];
  /** User entered a value but the record's existing value was kept. */
  keptFields: MetadataFieldKey[];
  /** User's entry filled a previously blank field. */
  appliedFields: MetadataFieldKey[];
}

export function computeExistingRecordMerge(
  existing: ExistingRecordFields,
  entered: EnteredMetadata,
): ExistingRecordMerge {
  const keptFields: MetadataFieldKey[] = [];
  const appliedFields: MetadataFieldKey[] = [];
  const fields: Partial<Record<MetadataFieldKey, string | undefined>> = {};

  for (const key of METADATA_FIELD_KEYS) {
    const existingVal = (existing[key] || '').trim();
    const enteredVal = (entered[key] || '').trim();
    if (existingVal) {
      fields[key] = existing[key];
      if (enteredVal && enteredVal !== existingVal) {
        keptFields.push(key);
      }
    } else {
      fields[key] = enteredVal || undefined;
      if (enteredVal) {
        appliedFields.push(key);
      }
    }
  }

  const tags = Array.from(
    new Set([...(existing.tags || []), ...entered.tags.filter(t => t.trim() !== '')]),
  );
  const categories = Array.from(
    new Set([
      ...(existing.categories || []),
      ...entered.categories.filter(c => c.trim() !== ''),
    ]),
  );

  return { fields, tags, categories, keptFields, appliedFields };
}

/** Human-readable summary lines for kept-field counts, e.g. "Owner (3 addresses)". */
export function describeKeptFieldCounts(
  counts: Partial<Record<MetadataFieldKey, number>>,
): string[] {
  return (Object.keys(METADATA_FIELD_LABELS) as MetadataFieldKey[])
    .filter(key => (counts[key] || 0) > 0)
    .map(
      key =>
        `${METADATA_FIELD_LABELS[key]}: kept the existing value on ${counts[key]} address${counts[key] === 1 ? '' : 'es'}`,
    );
}
