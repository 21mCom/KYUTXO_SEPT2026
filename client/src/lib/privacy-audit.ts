import type { TransactionParticipant, BlockchainTransaction } from "@/lib/db-types";
import { getParticipantsByAddressesWithOutpointSpends } from "@/lib/data/record-queries";
import { getAllDustFlags } from "@/lib/data/dust-flags-crud";
import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { listVaultRows, queryVaultRows } from "@/lib/data/repository-helpers";
import { lookupEntities, ENTITY_CATEGORY_TAG_NAMES, ENTITY_CATEGORY_LABELS, ENTITY_CATEGORY_COLORS, type EntityCategory } from "@/lib/privacy-entity-list";

// ─── Severity ────────────────────────────────────────────────────────────────

export type PrivacySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

// ─── Finding types ────────────────────────────────────────────────────────────

export type PrivacyFindingType =
  // Legacy / existing
  | "SCRIPT_TYPE_MIXING"
  | "DUST"
  | "DUST_SPENDING"
  | "CONSOLIDATION_ORIGIN"
  | "EXCHANGE_ORIGIN"
  | "TAINTED_UTXO_MERGE"
  // New — Phase A
  | "ADDRESS_REUSE"
  | "ROUND_AMOUNT"
  | "COMMON_INPUT_OWNERSHIP"
  | "MULTI_OWNER_CO_SPEND"
  | "MULTI_OWNER_ADDRESS_REUSE"
  | "UNNECESSARY_INPUT"
  | "RECURRING_PAYMENT"
  | "HIGH_ACTIVITY"
  | "COINBASE_ORIGIN"
  | "MULTISIG_ESCROW"
  | "OP_RETURN_METADATA"
  | "UTXO_SET_EXPOSURE"
  // New — Phase A (structural)
  | "COINJOIN_WHIRLPOOL"
  | "COINJOIN_WASABI"
  | "COINJOIN_JOINMARKET"
  | "POST_MIX_SPENDING"
  | "PEEL_CHAIN"
  // New — Phase B (entity)
  | "ENTITY_EXCHANGE"
  | "ENTITY_MIXER"
  | "ENTITY_DARKNET"
  | "ENTITY_MINING_POOL"
  | "ENTITY_GAMBLING"
  | "ENTITY_P2P"
  | "ENTITY_SCAM"
  // New — Phase C (fingerprinting)
  | "FINGERPRINT_NVERSION"
  | "FINGERPRINT_NLOCKTIME"
  | "FINGERPRINT_RBF"
  | "FINGERPRINT_BIP69"
  | "FINGERPRINT_LOW_R"
  | "FINGERPRINT_WITNESS_INCONSISTENCY"
  // New — Phase D (entity proximity)
  | "PROXIMITY_EXCHANGE"
  | "PROXIMITY_MIXER"
  | "PROXIMITY_DARKNET"
  | "PROXIMITY_MINING_POOL"
  | "PROXIMITY_GAMBLING"
  | "PROXIMITY_P2P"
  | "PROXIMITY_SCAM";

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * A source citation for a flagged known-entity address. Surfaced in the
 * Privacy Audit UI so users can see *why* and *based on what public source*
 * a counterparty was tagged. The `sourceNote` may contain a URL — it is shown
 * as informational plain text and is never fetched at runtime (offline-first).
 */
export interface EntityCitation {
  name: string;
  address: string;
  categoryLabel: string;
  sourceNote?: string;
}

export interface PrivacyFinding {
  type: PrivacyFindingType;
  severity: PrivacySeverity;
  description: string;
  details: Record<string, unknown>;
  correction: string;
  txids: string[];
  addresses: string[];
  /** Score delta applied for this finding (negative = penalty) */
  scoreDelta?: number;
}

export interface ScoreWaterfallEntry {
  label: string;
  findingType: PrivacyFindingType | "BASE";
  delta: number;
  runningScore: number;
  count: number;
}

export interface PrivacyAuditResult {
  findings: PrivacyFinding[];
  warnings: PrivacyFinding[];
  transactionsAnalyzed: number;
  addressesScanned: number;
  isClean: boolean;
  /** Overall privacy score 0-100 */
  score: number;
  /** Letter grade derived from score */
  grade: string;
  /** Score waterfall for visualization */
  scoreWaterfall: ScoreWaterfallEntry[];
  /**
   * True when ANY transaction lacks fingerprint capture data.
   * Fingerprinting checks will be incomplete until those addresses are re-synced.
   */
  needsResync: boolean;
  /**
   * Fraction of analyzed transactions that have raw fingerprint data (0.0–1.0).
   * 1.0 = full coverage; < 1.0 = some txs were imported before fingerprint capture.
   */
  fingerprintCoverage: number;
}

export interface AuditContext {
  userAddresses: Set<string>;
  participants: TransactionParticipant[];
  participantsByTxid: Map<string, TransactionParticipant[]>;
  transactions: Map<string, BlockchainTransaction>;
  /**
   * Explicitly assigned owner name by address. This is intentionally populated
   * only from AddressOwnership rows in the `assigned` state; a missing entry
   * means the audit must not infer an owner from transaction structure.
   */
  confirmedOwnerByAddress?: Map<string, string>;
  /**
   * Outpoints ("txid:vout") the user explicitly flagged as dust (via the
   * Dusted page). Dust findings for these outputs are annotated + downgraded:
   * the user has already identified them and set them aside, so the residual
   * risk is only accidental spending.
   */
  dustFlaggedOutpoints?: Set<string>;
}

// ─── Scoring model ────────────────────────────────────────────────────────────

const SEVERITY_FIRST_PENALTY: Record<PrivacySeverity, number> = {
  CRITICAL: -25,
  HIGH: -15,
  MEDIUM: -8,
  LOW: -3,
};

const SEVERITY_SUBSEQUENT_PENALTY: Record<PrivacySeverity, number> = {
  CRITICAL: -12,
  HIGH: -6,
  MEDIUM: -3,
  LOW: -1,
};

/**
 * Finding types that represent privacy-positive actions (using CoinJoin is
 * beneficial). They appear in the waterfall with delta = 0 so users can see
 * them without being penalised for good privacy behaviour.
 */
const PRIVACY_POSITIVE_TYPES = new Set<PrivacyFindingType>([
  "COINJOIN_WHIRLPOOL",
  "COINJOIN_WASABI",
  "COINJOIN_JOINMARKET",
]);

export function computeScore(
  findings: PrivacyFinding[],
  warnings: PrivacyFinding[]
): { score: number; grade: string; waterfall: ScoreWaterfallEntry[] } {
  const all = [...findings, ...warnings];

  // Separate penalised findings from privacy-positive ones
  const penalised = all.filter((f) => !PRIVACY_POSITIVE_TYPES.has(f.type));
  const positive  = all.filter((f) => PRIVACY_POSITIVE_TYPES.has(f.type));

  const countBySeverity: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

  let score = 100;
  const waterfall: ScoreWaterfallEntry[] = [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
  ];

  // Group penalised findings by type
  const byType = new Map<PrivacyFindingType, PrivacyFinding[]>();
  for (const f of penalised) {
    const list = byType.get(f.type);
    if (list) list.push(f);
    else byType.set(f.type, [f]);
  }

  const sortedEntries = Array.from(byType.entries()).sort((a, b) => {
    const order: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const sevA = a[1][0]?.severity ?? "LOW";
    const sevB = b[1][0]?.severity ?? "LOW";
    return order[sevA] - order[sevB];
  });

  for (const [type, items] of sortedEntries) {
    const sev = items[0].severity;
    let delta = 0;
    for (let i = 0; i < items.length; i++) {
      if (i === 0 && countBySeverity[sev] === 0) {
        delta += SEVERITY_FIRST_PENALTY[sev];
      } else {
        delta += SEVERITY_SUBSEQUENT_PENALTY[sev];
      }
      countBySeverity[sev]++;
    }
    score = Math.min(100, Math.max(0, score + delta));
    waterfall.push({
      label: FINDING_TYPE_LABELS[type] ?? type,
      findingType: type,
      delta,
      runningScore: score,
      count: items.length,
    });

    for (const f of items) {
      f.scoreDelta = delta / items.length;
    }
  }

  // Append privacy-positive types as neutral waterfall entries (delta = 0)
  const byTypePos = new Map<PrivacyFindingType, PrivacyFinding[]>();
  for (const f of positive) {
    const list = byTypePos.get(f.type);
    if (list) list.push(f);
    else byTypePos.set(f.type, [f]);
  }
  for (const [type, items] of Array.from(byTypePos.entries())) {
    waterfall.push({
      label: (FINDING_TYPE_LABELS as Record<string, string>)[type] ?? type,
      findingType: type,
      delta: 0,
      runningScore: score,
      count: items.length,
    });
    for (const f of items) {
      f.scoreDelta = 0;
    }
  }

  const grade = scoreToGrade(score);
  return { score, grade, waterfall };
}

export function scoreToGrade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

// ─── Context builder ──────────────────────────────────────────────────────────

async function buildAuditContext(
  userAddresses: string[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<AuditContext> {
  const addressSet = new Set(userAddresses);

  onProgress?.("Loading transaction participants...");
  // Outpoint-aware load: Electrum-synced spend inputs carry a blank address,
  // so a pure address-keyed load would miss spend txs whose only link to an
  // owned address is such an input. The helper merges those rows in, so the
  // txid set below (and thus the whole audit) sees those spends too.
  const participants = await getParticipantsByAddressesWithOutpointSpends(userAddresses, signal);

  const ourTxids = new Set(participants.map((p: TransactionParticipant) => p.txid));

  onProgress?.("Loading full transaction data...");
  const allParticipantsForTxs: TransactionParticipant[] = [];
  const txidArray = Array.from(ourTxids);
  const BATCH = 500;
  for (let i = 0; i < txidArray.length; i += BATCH) {
    const batch = txidArray.slice(i, i + BATCH);
    const batchParticipants = (await Promise.all(batch.map((txid) =>
      queryVaultRows<TransactionParticipant>("transactionParticipants", "participants.byTxid", txid, 1000)))).flat();
    allParticipantsForTxs.push(...batchParticipants);
  }

  // Attribute blank-address (Electrum-synced) spend inputs back to the
  // address that owns the spent output. This is what a fully-resolved sync
  // would have produced (an input row carrying the owner's address), and it
  // lets the address-based heuristics (CIOH, address reuse, ...) see those
  // spends instead of skipping rows with an empty address.
  const addrByOutpoint = new Map<string, string>();
  for (const p of allParticipantsForTxs) {
    if (p.role === "output" && p.vout !== undefined && p.vout !== null && p.address) {
      addrByOutpoint.set(`${p.txid}:${p.vout}`, p.address);
    }
  }
  const attributeBlankInput = (p: TransactionParticipant): TransactionParticipant => {
    if (p.role === "input" && !p.address && p.prevTxid && p.prevVout !== undefined && p.prevVout !== null) {
      const owner = addrByOutpoint.get(`${p.prevTxid}:${p.prevVout}`);
      if (owner) return { ...p, address: owner };
    }
    return p;
  };

  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  for (const raw of allParticipantsForTxs) {
    const p = attributeBlankInput(raw);
    const list = participantsByTxid.get(p.txid);
    if (list) {
      list.push(p);
    } else {
      participantsByTxid.set(p.txid, [p]);
    }
  }

  // Load BlockchainTransaction records for metadata (fee, version, etc.)
  onProgress?.("Loading transaction metadata...");
  const txRecords = new Map<string, BlockchainTransaction>();
  for (let i = 0; i < txidArray.length; i += BATCH) {
    const batch = txidArray.slice(i, i + BATCH);
    const txs = (await Promise.all(batch.map((txid) =>
      queryVaultRows<BlockchainTransaction>("blockchainTransactions", "transactions.byTxid", txid, 1000)))).flat();
    for (const tx of txs) txRecords.set(tx.txid, tx);
  }

  onProgress?.("Loading dust flags...");
  const dustFlagRows = await getAllDustFlags();
  const dustFlaggedOutpoints = new Set(dustFlagRows.map((r) => r.outpoint));

  onProgress?.("Loading confirmed ownership...");
  const confirmedOwnerByAddress = await loadConfirmedOwnerByAddress(userAddresses);

  return {
    userAddresses: addressSet,
    participants: participants.map(attributeBlankInput),
    participantsByTxid,
    dustFlaggedOutpoints,
    transactions: txRecords,
    confirmedOwnerByAddress,
  };
}

const OWNERSHIP_RECORD_BATCH_SIZE = 1000;

/**
 * Returns confirmed ownership only. All reads go through the repository
 * vocabulary: the protected-vault renderer has no Dexie tables, and
 * listVaultRows deliberately pages its finite collection reads.
 */
export async function loadConfirmedOwnerByAddress(
  userAddresses: string[],
): Promise<Map<string, string>> {
  const records: Awaited<ReturnType<typeof getRecordsByInputStrings>> = [];
  for (let i = 0; i < userAddresses.length; i += OWNERSHIP_RECORD_BATCH_SIZE) {
    records.push(...await getRecordsByInputStrings(
      userAddresses.slice(i, i + OWNERSHIP_RECORD_BATCH_SIZE),
    ));
  }
  const addressByRecordId = new Map(records.flatMap((record) =>
    record.id == null || !record.inputString ? [] : [[record.id, record.inputString] as const],
  ));
  if (addressByRecordId.size === 0) return new Map();

  // No ownership/entity query is currently part of the protected query
  // vocabulary. Page these tables through the repository instead of reaching
  // around it to Dexie, then retain only rows relevant to this audit.
  const ownershipRows = await listVaultRows("addressOwnership");
  const assignedRows = ownershipRows.filter(
    (row) => addressByRecordId.has(row.recordId) && row.state === "assigned" && row.entityId != null,
  );
  const assignedEntityIds = new Set(assignedRows.flatMap((row) =>
    row.entityId == null ? [] : [row.entityId],
  ));
  if (assignedEntityIds.size === 0) return new Map();

  const entities = await listVaultRows("entities");
  const entityNameById = new Map(entities.flatMap((entity) =>
    entity.id == null || !assignedEntityIds.has(entity.id) ? [] : [[entity.id, entity.name] as const],
  ));
  const confirmedOwnerByAddress = new Map<string, string>();
  for (const row of assignedRows) {
    const address = addressByRecordId.get(row.recordId);
    const owner = row.entityId == null ? undefined : entityNameById.get(row.entityId);
    if (address && owner) confirmedOwnerByAddress.set(address, owner);
  }
  return confirmedOwnerByAddress;
}

// ─── Existing heuristics (preserved) ─────────────────────────────────────────

export function detectScriptTypeMixing(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const entries = Array.from(ctx.participantsByTxid.entries());

  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    const ourInputs = parts.filter(
      (p: TransactionParticipant) => p.role === "input" && ctx.userAddresses.has(p.address)
    );
    if (ourInputs.length < 2) continue;

    const typeSet = new Set<string>();
    for (const p of ourInputs) {
      if (p.scriptType && p.scriptType !== "unknown" && p.scriptType !== "op_return") {
        typeSet.add(p.scriptType);
      }
    }

    if (typeSet.size > 1) {
      const types = Array.from(typeSet);
      const addrSet = new Set<string>();
      for (const p of ourInputs) addrSet.add(p.address);
      findings.push({
        type: "SCRIPT_TYPE_MIXING",
        severity: "HIGH",
        description: `Transaction mixes ${types.length} different script types across inputs (${types.join(", ")}), creating a strong wallet fingerprint.`,
        details: { scriptTypes: types, inputCount: ourInputs.length },
        correction:
          "Avoid mixing different address types in a single transaction. Use coin control to select inputs of the same script type, or migrate funds to a single address type.",
        txids: [txid],
        addresses: Array.from(addrSet),
      });
    }
  }

  return findings;
}

const DUST_SATS = 1000;
const STRICT_DUST_SATS = 546;

export function detectDustUTXOs(ctx: AuditContext): { findings: PrivacyFinding[]; warnings: PrivacyFinding[] } {
  const findings: PrivacyFinding[] = [];
  const warnings: PrivacyFinding[] = [];

  const spentOutpoints = new Set<string>();
  const allParts = Array.from(ctx.participantsByTxid.values());
  for (let i = 0; i < allParts.length; i++) {
    const parts = allParts[i];
    for (const p of parts) {
      if (p.role === "input" && p.prevTxid && p.prevVout !== undefined) {
        spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
      }
    }
  }

  const currentDust: { address: string; txid: string; vout: number; sats: number }[] = [];
  const historicalDust: { address: string; txid: string; sats: number }[] = [];

  const entries = Array.from(ctx.participantsByTxid.entries());
  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    for (const p of parts) {
      if (p.role !== "output" || !ctx.userAddresses.has(p.address)) continue;
      const sats = Math.round(p.amount);
      if (sats > DUST_SATS) continue;

      const outpoint = `${txid}:${p.vout ?? 0}`;
      if (!spentOutpoints.has(outpoint)) {
        currentDust.push({ address: p.address, txid, vout: p.vout ?? 0, sats });
      } else {
        historicalDust.push({ address: p.address, txid, sats });
      }
    }
  }

  for (const d of currentDust) {
    const isStrict = d.sats <= STRICT_DUST_SATS;
    const isUserFlagged = ctx.dustFlaggedOutpoints?.has(`${d.txid}:${d.vout}`) ?? false;
    if (isUserFlagged) {
      // The user has already marked this output as dust (Dusted page), so the
      // main risk — unknowingly merging it into a spend — is mitigated.
      // Annotate + downgrade instead of penalising at full severity.
      findings.push({
        type: "DUST",
        severity: "LOW",
        description: `Unspent dust UTXO at ${d.address} (${d.sats} sats) — already marked as dust by you. Keep avoiding it when spending.`,
        details: { sats: d.sats, vout: d.vout, unspent: true, markedAsDust: true },
        correction:
          "You have flagged this output as dust. Continue to exclude it from spends; if you ever need to move it, use a CoinJoin transaction.",
        txids: [d.txid],
        addresses: [d.address],
      });
      continue;
    }
    findings.push({
      type: "DUST",
      severity: isStrict ? "CRITICAL" : "MEDIUM",
      description: `Unspent dust UTXO at ${d.address} (${d.sats} sats). ${isStrict ? "Below relay threshold — likely a dust attack." : "Small enough to be used as a tracking vector."}`,
      details: { sats: d.sats, vout: d.vout, unspent: true },
      correction:
        "Do not spend dust UTXOs with your other coins — this links your addresses. Either ignore the dust or spend it in a CoinJoin transaction, or mark it as dust on the Dusted page so it is tracked.",
      txids: [d.txid],
      addresses: [d.address],
    });
  }

  if (historicalDust.length > 0) {
    const grouped = new Map<string, Array<{ address: string; txid: string; sats: number }>>();
    for (const d of historicalDust) {
      const list = grouped.get(d.address);
      if (list) list.push(d);
      else grouped.set(d.address, [d]);
    }
    const groupEntries = Array.from(grouped.entries());
    for (let g = 0; g < groupEntries.length; g++) {
      const address = groupEntries[g][0];
      const items = groupEntries[g][1];
      warnings.push({
        type: "DUST",
        severity: "LOW",
        description: `${items.length} historical dust receipt(s) at ${address} (already spent).`,
        details: { count: items.length, sats: items.map((i: { sats: number }) => i.sats) },
        correction:
          "If the dust was spent alongside other UTXOs, your addresses may already be linked. Review the spending transaction for privacy impact.",
        txids: items.map((i: { txid: string }) => i.txid),
        addresses: [address],
      });
    }
  }

  const dustSpendingFindings = detectDustSpending(ctx);
  findings.push(...dustSpendingFindings);

  return { findings, warnings };
}

export function detectDustSpending(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const entries = Array.from(ctx.participantsByTxid.entries());

  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    const ourInputs = parts.filter(
      (p: TransactionParticipant) => p.role === "input" && ctx.userAddresses.has(p.address)
    );
    if (ourInputs.length < 2) continue;

    const dustInputs = ourInputs.filter((p: TransactionParticipant) => Math.round(p.amount) <= DUST_SATS);
    const normalInputs = ourInputs.filter((p: TransactionParticipant) => Math.round(p.amount) > DUST_SATS);

    if (dustInputs.length > 0 && normalInputs.length > 0) {
      const allAddrs = new Set<string>();
      for (const p of dustInputs) allAddrs.add(p.address);
      for (const p of normalInputs) allAddrs.add(p.address);

      findings.push({
        type: "DUST_SPENDING",
        severity: "HIGH",
        description: `Dust input(s) spent alongside normal inputs, actively linking ${dustInputs.length} dust address(es) to ${normalInputs.length} normal address(es).`,
        details: {
          dustAddresses: dustInputs.map((p: TransactionParticipant) => p.address),
          normalAddresses: normalInputs.map((p: TransactionParticipant) => p.address),
          dustAmounts: dustInputs.map((p: TransactionParticipant) => Math.round(p.amount)),
        },
        correction:
          "Never spend dust UTXOs with your regular coins. If you must spend dust, do so in a separate transaction or via CoinJoin.",
        txids: [txid],
        addresses: Array.from(allAddrs),
      });
    }
  }

  return findings;
}

export function detectConsolidationOrigin(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const entries = Array.from(ctx.participantsByTxid.entries());

  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    const inputs = parts.filter((p: TransactionParticipant) => p.role === "input");
    const outputs = parts.filter((p: TransactionParticipant) => p.role === "output");

    if (inputs.length < 3 || outputs.length > 2) continue;

    const ourInputs = inputs.filter((p: TransactionParticipant) => ctx.userAddresses.has(p.address));
    const ourRatio = ourInputs.length / inputs.length;
    if (ourRatio < 0.5) continue;

    const ourOutputs = outputs.filter((p: TransactionParticipant) => ctx.userAddresses.has(p.address));
    const addrSet = new Set<string>();
    for (const p of ourInputs) addrSet.add(p.address);
    for (const p of ourOutputs) addrSet.add(p.address);

    findings.push({
      type: "CONSOLIDATION_ORIGIN",
      severity: "MEDIUM",
      description: `Consolidation transaction merges ${inputs.length} inputs into ${outputs.length} output(s), linking ${ourInputs.length} of your addresses.`,
      details: {
        inputCount: inputs.length,
        outputCount: outputs.length,
        ourInputCount: ourInputs.length,
        totalConsolidated: ourInputs.reduce((s: number, p: TransactionParticipant) => s + p.amount, 0),
      },
      correction:
        "Avoid consolidating UTXOs in a single transaction as it publicly links all input addresses. If consolidation is needed, use CoinJoin or consolidate during periods of low mempool activity to reduce exposure.",
      txids: [txid],
      addresses: Array.from(addrSet),
    });
  }

  return findings;
}

export function detectExchangeOrigin(ctx: AuditContext): { findings: PrivacyFinding[]; warnings: PrivacyFinding[] } {
  const findings: PrivacyFinding[] = [];
  const warnings: PrivacyFinding[] = [];
  const entries = Array.from(ctx.participantsByTxid.entries());

  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    const outputs = parts.filter((p: TransactionParticipant) => p.role === "output");
    const inputs = parts.filter((p: TransactionParticipant) => p.role === "input");

    const ourOutputs = outputs.filter((p: TransactionParticipant) => ctx.userAddresses.has(p.address));
    if (ourOutputs.length === 0) continue;
    if (outputs.length < 5) continue;

    let signals = 0;
    const signalDetails: string[] = [];

    if (outputs.length >= 10) {
      signals++;
      signalDetails.push(`High output count (${outputs.length})`);
    }

    const uniqueRecipients = new Set<string>();
    for (const p of outputs) uniqueRecipients.add(p.address);
    if (uniqueRecipients.size >= 5) {
      signals++;
      signalDetails.push(`Many unique recipients (${uniqueRecipients.size})`);
    }

    const inputTotal = inputs.reduce((s: number, p: TransactionParticipant) => s + p.amount, 0);
    const outputAmounts = outputs.map((p: TransactionParticipant) => p.amount).sort((a: number, b: number) => a - b);
    const medianOutput = outputAmounts[Math.floor(outputAmounts.length / 2)];
    if (medianOutput > 0 && inputTotal / medianOutput > 10) {
      signals++;
      signalDetails.push("Large input relative to individual outputs");
    }

    const ourInputCount = inputs.filter((p: TransactionParticipant) => ctx.userAddresses.has(p.address)).length;
    if (ourInputCount === 0) {
      signals++;
      signalDetails.push("No user-owned inputs (receive-only)");
    }

    if (signals >= 2) {
      warnings.push({
        type: "EXCHANGE_ORIGIN",
        severity: "LOW",
        description: `Probable exchange batch withdrawal: ${signalDetails.join("; ")}.`,
        details: {
          signals: signalDetails,
          signalCount: signals,
          outputCount: outputs.length,
          uniqueRecipients: uniqueRecipients.size,
        },
        correction:
          "Exchange withdrawals reveal that you are a customer of that exchange. Consider withdrawing to an intermediate address first, or use a service that supports direct withdrawal to your own node via Lightning.",
        txids: [txid],
        addresses: ourOutputs.map((p: TransactionParticipant) => p.address),
      });
    }
  }

  return { findings, warnings };
}

export function detectTaintedUTXOMerge(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const entries = Array.from(ctx.participantsByTxid.entries());

  for (let e = 0; e < entries.length; e++) {
    const txid = entries[e][0];
    const parts = entries[e][1];
    const ourInputs = parts.filter(
      (p: TransactionParticipant) => p.role === "input" && ctx.userAddresses.has(p.address)
    );
    if (ourInputs.length < 2) continue;

    const fundingSources = new Set<string>();
    for (const inp of ourInputs) {
      if (inp.prevTxid) {
        fundingSources.add(inp.prevTxid);
      }
    }

    if (fundingSources.size < 2) continue;

    const distinctAddresses = new Set<string>();
    for (const p of ourInputs) distinctAddresses.add(p.address);
    if (distinctAddresses.size < 2) continue;

    findings.push({
      type: "TAINTED_UTXO_MERGE",
      severity: "HIGH",
      description: `${distinctAddresses.size} addresses from ${fundingSources.size} different funding sources merged in one transaction, propagating linkability across all inputs.`,
      details: {
        mergedAddressCount: distinctAddresses.size,
        fundingSourceCount: fundingSources.size,
        fundingTxids: Array.from(fundingSources),
      },
      correction:
        "Avoid merging UTXOs from different sources in a single transaction. Use coin control to keep funding sources separate, or use CoinJoin to break the link before merging.",
      txids: [txid],
      addresses: Array.from(distinctAddresses),
    });
  }

  return findings;
}

// ─── New Phase A heuristics ───────────────────────────────────────────────────

/** Address reuse: same address appears as both an output AND is later reused as input */
export function detectAddressReuse(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  // Count how many txids each user address appears in
  const addressTxids = new Map<string, Set<string>>();

  for (const [txid, parts] of ctx.participantsByTxid) {
    for (const p of parts) {
      if (!ctx.userAddresses.has(p.address)) continue;
      const s = addressTxids.get(p.address);
      if (s) s.add(txid);
      else addressTxids.set(p.address, new Set([txid]));
    }
  }

  for (const [address, txids] of addressTxids) {
    if (txids.size < 2) continue;
    // Check if the address appears as output in one tx and input in another (reuse)
    let hasReceive = false;
    let hasSpend = false;
    for (const txid of txids) {
      const parts = ctx.participantsByTxid.get(txid) ?? [];
      for (const p of parts) {
        if (p.address !== address) continue;
        if (p.role === "output") hasReceive = true;
        if (p.role === "input") hasSpend = true;
      }
    }
    if (hasReceive && hasSpend) {
      findings.push({
        type: "ADDRESS_REUSE",
        severity: "HIGH",
        description: `Address ${address.substring(0, 12)}… reused across ${txids.size} transactions (both receives and spends). Address reuse is the single biggest privacy risk — it clusters all your activity under one identifier.`,
        details: { txCount: txids.size, address },
        correction:
          "Generate a fresh address for every receive. Use a BIP32/84 HD wallet with gap limit. Never share the same address twice.",
        txids: Array.from(txids),
        addresses: [address],
      });
    }
  }

  return findings;
}

/**
 * Detects a transaction that co-spends inputs assigned to different confirmed
 * owners. Unknown/undetermined ownership is deliberately excluded rather than
 * being folded into an owner bucket.
 */
export function detectMultiOwnerCoSpend(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const owners = ctx.confirmedOwnerByAddress;
  if (!owners || owners.size === 0) return findings;

  for (const [txid, parts] of ctx.participantsByTxid) {
    const addressesByOwner = new Map<string, Set<string>>();
    for (const input of parts) {
      if (input.role !== "input") continue;
      const owner = owners.get(input.address);
      if (!owner) continue;
      const addresses = addressesByOwner.get(owner) ?? new Set<string>();
      addresses.add(input.address);
      addressesByOwner.set(owner, addresses);
    }
    if (addressesByOwner.size < 2) continue;

    const ownerEvidence = [...addressesByOwner.entries()].map(([owner, addresses]) => ({
      owner,
      addresses: [...addresses],
    }));
    findings.push({
      type: "MULTI_OWNER_CO_SPEND",
      severity: "HIGH",
      description: `Inputs assigned to ${addressesByOwner.size} confirmed owners were co-spent in one transaction, publicly linking those owners' funds.`,
      details: { ownerEvidence, ownerCount: addressesByOwner.size },
      correction: "Use coin control to keep confirmed owners' UTXOs separate. Do not combine funds across owners unless the resulting public linkage is intended.",
      txids: [txid],
      addresses: ownerEvidence.flatMap((e) => e.addresses),
    });
  }
  return findings;
}

/**
 * Detects a recipient address used by transactions funded by different
 * confirmed owners. This identifies shared/reused payment addresses without
 * assigning any meaning to inputs whose ownership is unknown.
 */
export function detectMultiOwnerAddressReuse(ctx: AuditContext): PrivacyFinding[] {
  const owners = ctx.confirmedOwnerByAddress;
  if (!owners || owners.size === 0) return [];

  const evidenceByAddress = new Map<string, {
    txids: Set<string>;
    owners: Map<string, Set<string>>;
    inputAddresses: Set<string>;
  }>();
  for (const [txid, parts] of ctx.participantsByTxid) {
    const knownInputs = parts.filter((part) => part.role === "input" && owners.has(part.address));
    if (knownInputs.length === 0) continue;
    for (const output of parts) {
      if (output.role !== "output" || !output.address) continue;
      const evidence = evidenceByAddress.get(output.address) ?? {
        txids: new Set<string>(),
        owners: new Map<string, Set<string>>(),
        inputAddresses: new Set<string>(),
      };
      evidence.txids.add(txid);
      for (const input of knownInputs) {
        const owner = owners.get(input.address)!;
        const addresses = evidence.owners.get(owner) ?? new Set<string>();
        addresses.add(input.address);
        evidence.owners.set(owner, addresses);
        evidence.inputAddresses.add(input.address);
      }
      evidenceByAddress.set(output.address, evidence);
    }
  }

  const findings: PrivacyFinding[] = [];
  for (const [address, evidence] of evidenceByAddress) {
    // A single multi-owner transaction is co-spend evidence, not address reuse.
    if (evidence.txids.size < 2 || evidence.owners.size < 2) continue;
    const ownerEvidence = [...evidence.owners.entries()].map(([owner, addresses]) => ({
      owner,
      addresses: [...addresses],
    }));
    findings.push({
      type: "MULTI_OWNER_ADDRESS_REUSE",
      severity: "HIGH",
      description: `Address ${address.substring(0, 12)}… was reused as a recipient by ${evidence.owners.size} confirmed owners, linking their payment activity.`,
      details: { ownerEvidence, ownerCount: evidence.owners.size, transactionCount: evidence.txids.size },
      correction: "Ask the recipient to provide a fresh address for each owner and payment. Avoid reusing a shared recipient address across distinct owners.",
      txids: [...evidence.txids],
      addresses: [address, ...evidence.inputAddresses],
    });
  }
  return findings;
}

/** Round amount detection: outputs with suspiciously round BTC amounts hint at payments vs change */
export function detectRoundAmounts(ctx: AuditContext, coinjoiTxids: Set<string>): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const ROUND_THRESHOLDS = [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000];

  for (const [txid, parts] of ctx.participantsByTxid) {
    if (coinjoiTxids.has(txid)) continue; // CoinJoin suppresses this
    const outputs = parts.filter(p => p.role === "output");
    const ourOutputs = outputs.filter(p => ctx.userAddresses.has(p.address));
    if (ourOutputs.length === 0) continue;

    for (const p of ourOutputs) {
      const sats = Math.round(p.amount);
      const isRound = ROUND_THRESHOLDS.some(t => sats === t || (sats > 0 && sats % t === 0));
      if (isRound && sats >= 100_000) {
        findings.push({
          type: "ROUND_AMOUNT",
          severity: "LOW",
          description: `Round output of ${(sats / 1e8).toFixed(8)} BTC (${sats.toLocaleString()} sats) in tx — round amounts strongly suggest this is the payment output (not change), revealing the payment amount to chain analysts.`,
          details: { sats, address: p.address },
          correction:
            "Avoid sending exactly round BTC amounts. Even a 1-sat difference breaks the round-amount heuristic. Use Lightning for amounts where the payment size must be exact.",
          txids: [txid],
          addresses: [p.address],
        });
      }
    }
  }

  return findings;
}

/** Common-input-ownership heuristic: multiple inputs from different addresses → same wallet */
export function detectCommonInputOwnership(ctx: AuditContext, coinjoiTxids: Set<string>, multisigTxids: Set<string>): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  for (const [txid, parts] of ctx.participantsByTxid) {
    if (coinjoiTxids.has(txid)) continue;   // CoinJoin suppresses CIOH
    if (multisigTxids.has(txid)) continue;  // Multisig may produce false CIOH

    const inputs = parts.filter(p => p.role === "input");
    if (inputs.length < 2) continue;

    const ourInputAddrs = inputs
      .filter(p => ctx.userAddresses.has(p.address))
      .map(p => p.address);
    const externalInputAddrs = inputs
      .filter(p => !ctx.userAddresses.has(p.address))
      .map(p => p.address);

    if (ourInputAddrs.length < 2) continue;
    if (externalInputAddrs.length > 0) continue; // Mixed ownership — skip

    // All inputs are ours and we have multiple → strong CIOH signal
    const uniqueOurAddrs = new Set(ourInputAddrs);
    if (uniqueOurAddrs.size < 2) continue;

    findings.push({
      type: "COMMON_INPUT_OWNERSHIP",
      severity: "MEDIUM",
      description: `${uniqueOurAddrs.size} of your addresses appear as inputs in the same transaction. The common-input-ownership heuristic lets observers cluster all these addresses as belonging to the same wallet.`,
      details: {
        inputCount: inputs.length,
        ourAddressCount: uniqueOurAddrs.size,
        addressList: Array.from(uniqueOurAddrs).slice(0, 5),
      },
      correction:
        "Use coin control to avoid co-spending multiple addresses in one transaction. CoinJoin explicitly breaks this heuristic by mixing coins from unrelated wallets.",
      txids: [txid],
      addresses: Array.from(uniqueOurAddrs),
    });
  }

  return findings;
}

/** Unnecessary input: tx has more inputs than needed to cover the output + fee */
export function detectUnnecessaryInput(ctx: AuditContext, coinjoiTxids: Set<string>): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  for (const [txid, parts] of ctx.participantsByTxid) {
    if (coinjoiTxids.has(txid)) continue;
    const inputs = parts.filter(p => p.role === "input");
    const outputs = parts.filter(p => p.role === "output");
    if (inputs.length < 2) continue;

    const totalOut = outputs.reduce((s, p) => s + p.amount, 0);
    const totalIn = inputs.reduce((s, p) => s + p.amount, 0);
    const fee = Math.max(0, totalIn - totalOut);

    const ourInputs = inputs
      .filter(p => ctx.userAddresses.has(p.address))
      .sort((a, b) => b.amount - a.amount);
    if (ourInputs.length < 2) continue;

    // Check if the largest single input would have covered the spend + fee
    if (ourInputs[0].amount >= totalOut + fee) {
      findings.push({
        type: "UNNECESSARY_INPUT",
        severity: "LOW",
        description: `Transaction uses ${ourInputs.length} inputs when 1 would have sufficed — the largest input (${Math.round(ourInputs[0].amount).toLocaleString()} sats) already covers the total output. Extra inputs unnecessarily link additional addresses.`,
        details: {
          inputCount: ourInputs.length,
          largestInput: Math.round(ourInputs[0].amount),
          totalOut: Math.round(totalOut),
          fee: Math.round(fee),
        },
        correction:
          "Use coin control to select only as many inputs as needed to cover the payment and fee. Avoid grabbing small UTXOs unnecessarily.",
        txids: [txid],
        addresses: ourInputs.map(p => p.address),
      });
    }
  }

  return findings;
}

/** High activity: addresses with very many transactions are easily tracked */
export function detectHighActivity(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const HIGH_TX_THRESHOLD = 50;

  const addrTxCount = new Map<string, number>();
  for (const parts of ctx.participantsByTxid.values()) {
    const seen = new Set<string>();
    for (const p of parts) {
      if (!ctx.userAddresses.has(p.address)) continue;
      if (seen.has(p.address)) continue;
      seen.add(p.address);
      addrTxCount.set(p.address, (addrTxCount.get(p.address) ?? 0) + 1);
    }
  }

  for (const [address, count] of addrTxCount) {
    if (count >= HIGH_TX_THRESHOLD) {
      findings.push({
        type: "HIGH_ACTIVITY",
        severity: "MEDIUM",
        description: `Address ${address.substring(0, 12)}… appears in ${count} transactions. High-volume addresses become public identifiers — observers can track payments, timing, and counterparties easily.`,
        details: { txCount: count, address },
        correction:
          "Use a fresh address for every receipt. High-activity addresses should be retired and funds migrated to a fresh HD wallet path.",
        txids: [],
        addresses: [address],
      });
    }
  }

  return findings;
}

/** OP_RETURN metadata: any tx with OP_RETURN outputs leaks data on-chain */
export function detectOpReturn(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const [txid, tx] of ctx.transactions) {
    if (!tx.hasOpReturn) continue;
    const parts = ctx.participantsByTxid.get(txid) ?? [];
    const ourAddrs = parts
      .filter(p => ctx.userAddresses.has(p.address))
      .map(p => p.address);
    if (ourAddrs.length === 0) continue;

    const opData = tx.opReturnData ?? [];
    const preview = opData[0]?.dataText ?? opData[0]?.dataHex?.substring(0, 32) ?? "unknown";

    findings.push({
      type: "OP_RETURN_METADATA",
      severity: "LOW",
      description: `Transaction includes an OP_RETURN output embedding arbitrary data ("${preview}…") — any data embedded in OP_RETURN is permanently public and immutable on the blockchain.`,
      details: {
        opReturnCount: opData.length,
        preview,
      },
      correction:
        "Be aware that OP_RETURN data is forever public. Do not embed personally identifiable or sensitive metadata in transactions.",
      txids: [txid],
      addresses: ourAddrs,
    });
  }
  return findings;
}

/** Multisig/escrow detection: p2sh or p2wsh with multisig spending patterns */
export function detectMultisigEscrow(ctx: AuditContext): { findings: PrivacyFinding[]; multisigTxids: Set<string> } {
  const findings: PrivacyFinding[] = [];
  const multisigTxids = new Set<string>();

  for (const [txid, parts] of ctx.participantsByTxid) {
    const ourInputs = parts.filter(
      p => p.role === "input" && ctx.userAddresses.has(p.address)
    );
    const multisigInputs = ourInputs.filter(
      p => p.scriptType === "multisig" || p.scriptType === "v0_p2wsh" || p.scriptType === "p2sh"
    );
    if (multisigInputs.length === 0) continue;
    multisigTxids.add(txid);

    findings.push({
      type: "MULTISIG_ESCROW",
      severity: "LOW",
      description: `Transaction spends a multisig/P2SH output. Multisig reveals the signing threshold and public keys when spent, reducing privacy compared to single-sig Taproot.`,
      details: {
        multisigInputCount: multisigInputs.length,
        scriptTypes: [...new Set(multisigInputs.map(p => p.scriptType))],
      },
      correction:
        "Consider migrating multisig setups to Taproot MuSig2 (P2TR) which reveals no threshold information on-chain when spending cooperatively.",
      txids: [txid],
      addresses: multisigInputs.map(p => p.address),
    });
  }

  return { findings, multisigTxids };
}

/** UTXO set exposure: many small unspent UTXOs that map to distinct addresses */
export function detectUTXOSetExposure(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const spentOutpoints = new Set<string>();

  for (const parts of ctx.participantsByTxid.values()) {
    for (const p of parts) {
      if (p.role === "input" && p.prevTxid && p.prevVout !== undefined) {
        spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
      }
    }
  }

  const unspentAddresses = new Set<string>();
  for (const [txid, parts] of ctx.participantsByTxid) {
    for (const p of parts) {
      if (p.role !== "output" || !ctx.userAddresses.has(p.address)) continue;
      const outpoint = `${txid}:${p.vout ?? 0}`;
      if (!spentOutpoints.has(outpoint)) {
        unspentAddresses.add(p.address);
      }
    }
  }

  if (unspentAddresses.size >= 10) {
    findings.push({
      type: "UTXO_SET_EXPOSURE",
      severity: "MEDIUM",
      description: `Your UTXO set spans ${unspentAddresses.size} distinct addresses. A large fragmented UTXO set increases on-chain footprint and creates more opportunities for chain analysts to cluster your activity.`,
      details: {
        unspentAddressCount: unspentAddresses.size,
      },
      correction:
        "Consider periodic consolidation via CoinJoin (not plain consolidation) to reduce UTXO set size without linking addresses. Avoid creating many tiny UTXOs from change outputs.",
      txids: [],
      addresses: Array.from(unspentAddresses).slice(0, 20),
    });
  }

  return findings;
}

// ─── CoinJoin / structural heuristics ────────────────────────────────────────

/**
 * Detect Whirlpool-style CoinJoin: exactly 5 equal outputs (0.001, 0.01, 0.05, 0.5 BTC pools)
 * or any tx with exactly 5 outputs of the exact same amount.
 */
export function detectCoinJoin(ctx: AuditContext): {
  whirlpool: PrivacyFinding[];
  wasabi: PrivacyFinding[];
  joinmarket: PrivacyFinding[];
  coinjoinTxids: Set<string>;
} {
  const whirlpool: PrivacyFinding[] = [];
  const wasabi: PrivacyFinding[] = [];
  const joinmarket: PrivacyFinding[] = [];
  const coinjoinTxids = new Set<string>();

  const WHIRLPOOL_POOL_AMOUNTS = new Set([100_000, 1_000_000, 5_000_000, 50_000_000]); // 0.001, 0.01, 0.05, 0.5 BTC

  for (const [txid, parts] of ctx.participantsByTxid) {
    const outputs = parts.filter(p => p.role === "output" && p.scriptType !== "op_return");
    const inputs = parts.filter(p => p.role === "input");
    const ourParts = parts.filter(p => ctx.userAddresses.has(p.address));
    if (ourParts.length === 0) continue;

    // Whirlpool: exactly 5 equal outputs, all in a known pool denomination
    if (outputs.length === 5) {
      const amounts = outputs.map(p => Math.round(p.amount));
      const allEqual = amounts.every(a => a === amounts[0]);
      if (allEqual && WHIRLPOOL_POOL_AMOUNTS.has(amounts[0])) {
        coinjoinTxids.add(txid);
        whirlpool.push({
          type: "COINJOIN_WHIRLPOOL",
          severity: "LOW",
          description: `Whirlpool CoinJoin detected (${outputs.length} equal outputs of ${(amounts[0] / 1e8).toFixed(8)} BTC). This is privacy-enhancing. Warning: post-mix spending without further mixing reduces the benefit.`,
          details: { outputCount: outputs.length, denomination: amounts[0] },
          correction: "Continue to use fresh addresses for post-mix spending and avoid consolidating post-mix UTXOs.",
          txids: [txid],
          addresses: ourParts.map(p => p.address),
        });
        continue;
      }
    }

    // WabiSabi (Wasabi 2.0): 20+ inputs AND 20+ outputs (large coordinated CoinJoin)
    if (inputs.length >= 20 && outputs.length >= 20) {
      const amounts = outputs.map(p => Math.round(p.amount));
      const uniqueAmounts = new Set(amounts);
      const hasEqualOutputs = uniqueAmounts.size < outputs.length * 0.5;
      if (hasEqualOutputs) {
        coinjoinTxids.add(txid);
        wasabi.push({
          type: "COINJOIN_WASABI",
          severity: "LOW",
          description: `WabiSabi-style CoinJoin detected (${inputs.length} inputs, ${outputs.length} outputs with clustered denominations). This is privacy-enhancing.`,
          details: { inputCount: inputs.length, outputCount: outputs.length },
          correction: "Post-mix: use PayJoin or Lightning for the next spend to avoid linking your CoinJoin output.",
          txids: [txid],
          addresses: ourParts.map(p => p.address),
        });
        continue;
      }
    }

    // JoinMarket heuristic: 2+ inputs from different wallets, 2 equal outputs + change outputs
    if (inputs.length >= 2 && outputs.length >= 3) {
      const amounts = outputs.map(p => Math.round(p.amount));
      const sortedAmounts = [...amounts].sort((a, b) => a - b);
      // Look for at least 2 equal outputs (maker + taker receive equal amounts)
      let equalPairFound = false;
      for (let i = 0; i < sortedAmounts.length - 1; i++) {
        if (sortedAmounts[i] === sortedAmounts[i + 1] && sortedAmounts[i] > DUST_SATS * 10) {
          equalPairFound = true;
          break;
        }
      }
      if (equalPairFound) {
        const ourInputs = inputs.filter(p => ctx.userAddresses.has(p.address));
        const externalInputs = inputs.filter(p => !ctx.userAddresses.has(p.address));
        if (ourInputs.length > 0 && externalInputs.length > 0) {
          coinjoinTxids.add(txid);
          joinmarket.push({
            type: "COINJOIN_JOINMARKET",
            severity: "LOW",
            description: `JoinMarket-style CoinJoin detected (equal outputs from multiple parties). This is privacy-enhancing.`,
            details: { inputCount: inputs.length, outputCount: outputs.length },
            correction: "Avoid merging JoinMarket outputs with non-mixed UTXOs.",
            txids: [txid],
            addresses: ourParts.map(p => p.address),
          });
        }
      }
    }
  }

  return { whirlpool, wasabi, joinmarket, coinjoinTxids };
}

/** Post-mix spending: spending a CoinJoin output directly in a non-CoinJoin tx */
export function detectPostMixSpending(ctx: AuditContext, coinjoinTxids: Set<string>): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  // Find outputs of CoinJoin txs that are our addresses
  const cjOutputAddresses = new Set<string>();
  for (const txid of coinjoinTxids) {
    const parts = ctx.participantsByTxid.get(txid) ?? [];
    for (const p of parts) {
      if (p.role === "output" && ctx.userAddresses.has(p.address)) {
        cjOutputAddresses.add(p.address);
      }
    }
  }

  if (cjOutputAddresses.size === 0) return findings;

  // Find non-CoinJoin txs where these addresses appear as inputs
  for (const [txid, parts] of ctx.participantsByTxid) {
    if (coinjoinTxids.has(txid)) continue;
    const cjInputs = parts.filter(
      p => p.role === "input" && cjOutputAddresses.has(p.address)
    );
    if (cjInputs.length === 0) continue;

    // Check if co-spent with non-CJ outputs (reduces privacy)
    const otherInputs = parts.filter(
      p => p.role === "input" && !cjOutputAddresses.has(p.address) && ctx.userAddresses.has(p.address)
    );

    findings.push({
      type: "POST_MIX_SPENDING",
      severity: otherInputs.length > 0 ? "HIGH" : "MEDIUM",
      description: otherInputs.length > 0
        ? `Post-mix UTXO co-spent with non-mixed coins — this undoes the CoinJoin privacy benefit by linking ${cjInputs.length} mixed address(es) to ${otherInputs.length} unmixed address(es).`
        : `CoinJoin output spent without further mixing. Chain analysts can still track the post-mix spend path.`,
      details: {
        mixedInputs: cjInputs.map(p => p.address),
        unmixedInputs: otherInputs.map(p => p.address),
      },
      correction:
        "Never co-spend post-mix UTXOs with unmixed UTXOs. Use Stonewall, Stowaway, or Lightning for post-mix payments.",
      txids: [txid],
      addresses: [...cjInputs, ...otherInputs].map(p => p.address),
    });
  }

  return findings;
}

/** Peel chain: a sequence of txs with 2 outputs where one is change (peel-chain pattern) */
export function detectPeelChain(ctx: AuditContext, coinjoinTxids: Set<string>): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  // Build a map of txid → single-our-output address (change address)
  const changeOutputs = new Map<string, string>(); // txid → change address
  for (const [txid, parts] of ctx.participantsByTxid) {
    if (coinjoinTxids.has(txid)) continue;
    const outputs = parts.filter(p => p.role === "output");
    if (outputs.length !== 2) continue;
    const ourOutputs = outputs.filter(p => ctx.userAddresses.has(p.address));
    if (ourOutputs.length !== 1) continue;
    // The smaller output is likely change
    const ourOut = ourOutputs[0];
    const theirOut = outputs.find(p => !ctx.userAddresses.has(p.address));
    if (!theirOut) continue;
    if (ourOut.amount < theirOut.amount) {
      changeOutputs.set(txid, ourOut.address);
    }
  }

  // Find chains of 3+ consecutive peel txs
  const chainMembers = new Map<string, string[]>(); // root txid → chain of txids
  for (const [txid] of changeOutputs) {
    // Check if this tx's inputs came from another peel tx output
    const parts = ctx.participantsByTxid.get(txid) ?? [];
    const ourInput = parts.find(p => p.role === "input" && ctx.userAddresses.has(p.address));
    if (!ourInput?.prevTxid) continue;
    if (changeOutputs.has(ourInput.prevTxid)) {
      const chain = chainMembers.get(ourInput.prevTxid);
      if (chain) {
        chain.push(txid);
        chainMembers.set(txid, chain);
        chainMembers.delete(ourInput.prevTxid);
      } else {
        chainMembers.set(txid, [ourInput.prevTxid, txid]);
      }
    }
  }

  for (const [, chain] of chainMembers) {
    if (chain.length < 3) continue;
    const addrs = new Set<string>();
    for (const txid of chain) {
      const addr = changeOutputs.get(txid);
      if (addr) addrs.add(addr);
    }
    findings.push({
      type: "PEEL_CHAIN",
      severity: "MEDIUM",
      description: `Peel chain detected: ${chain.length} consecutive transactions each peeling off a payment and returning change to a new address. Analysts can reconstruct the entire chain with high confidence.`,
      details: { chainLength: chain.length, changeAddresses: Array.from(addrs).slice(0, 5) },
      correction:
        "Avoid using the same wallet for many consecutive payments. Mix your coins or use different wallets for different payment streams.",
      txids: chain,
      addresses: Array.from(addrs),
    });
  }

  return findings;
}

// ─── Phase B: Entity detection ────────────────────────────────────────────────

export function detectEntityContacts(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  // Collect all non-user addresses in our transactions
  const externalAddresses = new Set<string>();
  for (const parts of ctx.participantsByTxid.values()) {
    for (const p of parts) {
      if (!ctx.userAddresses.has(p.address) && p.address) {
        externalAddresses.add(p.address);
      }
    }
  }

  const entityMatches = lookupEntities(Array.from(externalAddresses));

  interface EntityMatch { name: string; txids: string[]; addrs: string[]; sourceNote?: string }
  const byCategory = new Map<EntityCategory, EntityMatch[]>();

  for (const [address, entity] of entityMatches) {
    const txids: string[] = [];
    for (const [txid, parts] of ctx.participantsByTxid) {
      if (parts.some(p => p.address === address)) txids.push(txid);
    }
    const list = byCategory.get(entity.category) ?? [];
    list.push({ name: entity.name, txids, addrs: [address], sourceNote: entity.sourceNote });
    byCategory.set(entity.category, list);
  }

  const categoryFindingType: Record<EntityCategory, PrivacyFindingType> = {
    exchange: "ENTITY_EXCHANGE",
    "payment-service": "ENTITY_EXCHANGE",
    gambling: "ENTITY_GAMBLING",
    scam: "ENTITY_SCAM",
    darknet: "ENTITY_DARKNET",
    "mining-pool": "ENTITY_MINING_POOL",
    mixer: "ENTITY_MIXER",
    "p2p-exchange": "ENTITY_P2P",
  };

  const categorySeverity: Record<EntityCategory, PrivacySeverity> = {
    exchange: "MEDIUM",
    "payment-service": "LOW",
    gambling: "MEDIUM",
    scam: "CRITICAL",
    darknet: "CRITICAL",
    "mining-pool": "LOW",
    mixer: "LOW",
    "p2p-exchange": "LOW",
  };

  for (const [category, items] of byCategory) {
    const names = [...new Set(items.map(i => i.name))];
    const txids = [...new Set(items.flatMap(i => i.txids))];
    const addrs = [...new Set(items.flatMap(i => i.addrs))];
    const sev = categorySeverity[category];

    // Build per-entity source citations (name, category label, and the public
    // attribution note). Deduped by address so each flagged counterparty shows
    // exactly why and based on what public source it was tagged. URLs in the
    // sourceNote are informational text only — never fetched at runtime.
    const seenAddrs = new Set<string>();
    const citations: EntityCitation[] = [];
    for (const item of items) {
      const address = item.addrs[0];
      if (!address || seenAddrs.has(address)) continue;
      seenAddrs.add(address);
      citations.push({
        name: item.name,
        address,
        categoryLabel: ENTITY_CATEGORY_LABELS[category],
        sourceNote: item.sourceNote,
      });
    }

    findings.push({
      type: categoryFindingType[category],
      severity: sev,
      description: `Your transactions interact with ${names.length} known ${ENTITY_CATEGORY_LABELS[category]} address(es): ${names.join(", ")}. This creates a public on-chain link between your wallet and these entities.`,
      details: { category, entities: names, txCount: txids.length, citations },
      correction:
        category === "scam" || category === "darknet"
          ? "Transactions linking your wallet to scam or darknet addresses may create legal and privacy risks. Review these transactions carefully."
          : `Transactions with ${ENTITY_CATEGORY_LABELS[category]} entities are recorded on-chain. Consider using Lightning or intermediate wallets to reduce on-chain linkability.`,
      txids,
      addresses: addrs,
    });
  }

  return findings;
}

// ─── Phase B2: Entity proximity (BFS) ────────────────────────────────────────

/**
 * Maximum number of transaction hops explored when searching for nearby entity
 * addresses. Hop 1 = direct contact (already captured by detectEntityContacts).
 * We report hops 2–MAX_PROXIMITY_HOPS as indirect-proximity findings.
 */
const MAX_PROXIMITY_HOPS = 4;

/**
 * Per-owned-address BFS node cap. Prevents runaway computation on very large
 * vaults (thousands of addresses all connected through a busy exchange tx).
 */
const MAX_BFS_NODES_PER_ADDRESS = 800;

/** Severity decreases as the hop-distance to the entity increases. */
const PROXIMITY_HOP_SEVERITY: Record<number, PrivacySeverity> = {
  2: "HIGH",
  3: "MEDIUM",
  4: "LOW",
};

const PROXIMITY_CATEGORY_FINDING_TYPE: Record<EntityCategory, PrivacyFindingType> = {
  exchange: "PROXIMITY_EXCHANGE",
  "payment-service": "PROXIMITY_EXCHANGE",
  gambling: "PROXIMITY_GAMBLING",
  scam: "PROXIMITY_SCAM",
  darknet: "PROXIMITY_DARKNET",
  "mining-pool": "PROXIMITY_MINING_POOL",
  mixer: "PROXIMITY_MIXER",
  "p2p-exchange": "PROXIMITY_P2P",
};

/**
 * Run a bounded BFS from every owned address through the local transaction
 * graph (`ctx.participantsByTxid`) to find the shortest hop-distance to any
 * address in the active entity list. Operates entirely on in-memory data —
 * zero network access.
 *
 * Emits one finding per (entity-category × hop-distance) pair so severity can
 * scale correctly. Only indirect contacts (hop ≥ 2) are emitted; direct
 * counterparties (hop 1) are already handled by detectEntityContacts.
 */

/**
 * Walk the BFS parent links back from `target` to `start`, returning the path
 * ordered start → … → target (owned address first, entity address last) along
 * with the connecting txid for each consecutive hop. `txids[i]` is the
 * transaction that links `path[i]` to `path[i + 1]`, so `txids` always has one
 * fewer element than `path`.
 */
function reconstructPath(
  parentOf: Map<string, string>,
  parentTxidOf: Map<string, string>,
  start: string,
  target: string,
): { path: string[]; txids: string[] } {
  const path: string[] = [target];
  const txids: string[] = [];
  let current = target;
  // Guard against cycles with a bounded walk.
  for (let i = 0; i < MAX_BFS_NODES_PER_ADDRESS && current !== start; i++) {
    const parent = parentOf.get(current);
    if (parent === undefined) break;
    const txid = parentTxidOf.get(current);
    path.push(parent);
    if (txid !== undefined) txids.push(txid);
    current = parent;
  }
  path.reverse();
  txids.reverse();
  return { path, txids };
}

export function detectEntityProximity(ctx: AuditContext): PrivacyFinding[] {
  // Build address → [txid, …] index from the already-loaded participant map.
  const addressToTxids = new Map<string, string[]>();
  for (const [txid, parts] of ctx.participantsByTxid) {
    for (const p of parts) {
      if (!p.address) continue;
      const list = addressToTxids.get(p.address);
      if (list) list.push(txid);
      else addressToTxids.set(p.address, [txid]);
    }
  }

  // Which entity addresses exist somewhere in the local graph?
  const allGraphAddresses = Array.from(addressToTxids.keys());
  const entityInGraph = lookupEntities(allGraphAddresses);

  if (entityInGraph.size === 0) return [];

  // BFS per owned address → collect the nearest entity per category.
  // key: `${category}::${hopDistance}`
  const grouped = new Map<string, {
    category: EntityCategory;
    hopDistance: number;
    entityNames: Set<string>;
    entityAddresses: string[];
    ownedAddresses: string[];
    /** Representative shortest path: owned → intermediary… → entity. */
    hopPath: string[];
    /** Connecting txid per hop; hopTxids[i] links hopPath[i] → hopPath[i+1]. */
    hopTxids: string[];
    /**
     * Per-entity source citations (name, category label, public attribution
     * note) for the indirect counterparties in this group, deduped by address —
     * mirrors detectEntityContacts so indirect (proximity) findings surface the
     * same "why was this flagged" attribution as direct ones.
     */
    citations: EntityCitation[];
    /** Addresses already represented in `citations` (dedupe guard). */
    citationAddrs: Set<string>;
  }>();

  for (const ownedAddr of ctx.userAddresses) {
    if (!addressToTxids.has(ownedAddr)) continue;

    // BFS state
    const visited = new Set<string>([ownedAddr]);
    const visitedTxids = new Set<string>();
    let frontier: string[] = [ownedAddr];
    // parentOf[child] = the address through which `child` was first reached.
    // Used to reconstruct the shortest path back to ownedAddr.
    const parentOf = new Map<string, string>();
    // parentTxidOf[child] = the txid through which `child` was first reached.
    // Used to surface the transaction connecting each hop.
    const parentTxidOf = new Map<string, string>();

    // Track the closest hop we found per category so we don't emit two
    // distances for the same category from the same owned address.
    const closestPerCategory = new Map<EntityCategory, number>();

    for (let hop = 1; hop <= MAX_PROXIMITY_HOPS && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];

      for (const addr of frontier) {
        const txids = addressToTxids.get(addr) ?? [];
        for (const txid of txids) {
          if (visitedTxids.has(txid)) continue;
          visitedTxids.add(txid);
          const parts = ctx.participantsByTxid.get(txid) ?? [];

          for (const p of parts) {
            if (!p.address || visited.has(p.address)) continue;
            visited.add(p.address);
            if (addr !== p.address) {
              parentOf.set(p.address, addr);
              parentTxidOf.set(p.address, txid);
            }

            const entity = entityInGraph.get(p.address);
            if (entity) {
              // Only report indirect contacts; direct (hop 1) is detectEntityContacts.
              if (hop >= 2 && !closestPerCategory.has(entity.category)) {
                closestPerCategory.set(entity.category, hop);

                const { path: hopPath, txids: hopTxids } = reconstructPath(
                  parentOf,
                  parentTxidOf,
                  ownedAddr,
                  p.address,
                );
                const key = `${entity.category}::${hop}`;
                const citation: EntityCitation = {
                  name: entity.name,
                  address: p.address,
                  categoryLabel: ENTITY_CATEGORY_LABELS[entity.category],
                  sourceNote: entity.sourceNote,
                };
                const existing = grouped.get(key);
                if (existing) {
                  existing.entityNames.add(entity.name);
                  if (!existing.entityAddresses.includes(p.address)) {
                    existing.entityAddresses.push(p.address);
                  }
                  if (!existing.ownedAddresses.includes(ownedAddr)) {
                    existing.ownedAddresses.push(ownedAddr);
                  }
                  if (!existing.citationAddrs.has(p.address)) {
                    existing.citationAddrs.add(p.address);
                    existing.citations.push(citation);
                  }
                } else {
                  grouped.set(key, {
                    category: entity.category,
                    hopDistance: hop,
                    entityNames: new Set([entity.name]),
                    entityAddresses: [p.address],
                    ownedAddresses: [ownedAddr],
                    hopPath,
                    hopTxids,
                    citations: [citation],
                    citationAddrs: new Set([p.address]),
                  });
                }
              }
              // Don't explore through entity addresses (dead end for our purposes)
            } else {
              nextFrontier.push(p.address);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (visited.size > MAX_BFS_NODES_PER_ADDRESS) break;
    }
  }

  if (grouped.size === 0) return [];

  // De-duplicate entity addresses across hop distances: if the same risky
  // address was reached at hop 2 from one owned address AND at hop 3 from
  // another, it must appear only in the closer-hop finding. Sort groups by
  // ascending hop distance so closer hops claim their entity addresses first,
  // then strip already-claimed addresses from farther hops.
  const sortedGroups = Array.from(grouped.values()).sort(
    (a, b) => a.hopDistance - b.hopDistance,
  );
  const claimedEntityAddresses = new Set<string>();
  for (const group of sortedGroups) {
    // Remove entity addresses already reported at a closer hop.
    group.entityAddresses = group.entityAddresses.filter(
      (addr) => !claimedEntityAddresses.has(addr),
    );
    group.citations = group.citations.filter(
      (c) => !claimedEntityAddresses.has(c.address),
    );
    // Rebuild entityNames from the surviving citations.
    group.entityNames = new Set(group.citations.map((c) => c.name));
    // Claim the survivors so farther hops don't repeat them.
    for (const addr of group.entityAddresses) claimedEntityAddresses.add(addr);
  }

  const findings: PrivacyFinding[] = [];

  for (const group of sortedGroups) {
    // Skip a group that had all its entity addresses claimed by a closer hop.
    if (group.entityAddresses.length === 0) continue;

    const severity = PROXIMITY_HOP_SEVERITY[group.hopDistance] ?? "LOW";
    const findingType = PROXIMITY_CATEGORY_FINDING_TYPE[group.category];
    const categoryLabel = ENTITY_CATEGORY_LABELS[group.category];
    const entityNames = Array.from(group.entityNames);
    const nameSnippet =
      entityNames.slice(0, 3).join(", ") +
      (entityNames.length > 3 ? ` +${entityNames.length - 3} more` : "");

    findings.push({
      type: findingType,
      severity,
      description: `${group.ownedAddresses.length} address(es) are ${group.hopDistance} transaction hop(s) away from a known ${categoryLabel}: ${nameSnippet}. This indirect link is visible to blockchain analysts.`,
      details: {
        hopDistance: group.hopDistance,
        entityCategory: group.category,
        entityNames,
        entityAddresses: group.entityAddresses,
        hopPath: group.hopPath,
        hopTxids: group.hopTxids,
        isProximity: true,
        citations: group.citations,
      },
      correction:
        group.category === "scam" || group.category === "darknet"
          ? `An indirect on-chain link to a ${categoryLabel} address may attract scrutiny in a source-of-funds analysis. Review how funds flowed through the intermediate transactions.`
          : `Indirect proximity to ${categoryLabel} entities creates on-chain linkage. Consider using Lightning or separate wallets to reduce on-chain traceability.`,
      txids: [],
      addresses: group.ownedAddresses,
    });
  }

  return findings;
}

/**
 * Build the `proximity:<category>-<n>hop` tag name for a proximity finding.
 * Returns undefined for non-proximity finding types.
 */
export function getProximityTagName(finding: PrivacyFinding): string | undefined {
  const details = finding.details as {
    isProximity?: boolean;
    entityCategory?: EntityCategory;
    hopDistance?: number;
  };
  if (!details?.isProximity || !details.entityCategory || !details.hopDistance) return undefined;
  return `proximity:${details.entityCategory}-${details.hopDistance}hop`;
}

/**
 * Color for the proximity tag (mirrors entity category colors, slightly muted).
 */
export function getProximityTagColor(entityCategory: EntityCategory): string {
  return ENTITY_CATEGORY_COLORS[entityCategory] ?? "#64748b";
}

export const PROXIMITY_FINDING_TYPES = new Set<PrivacyFindingType>([
  "PROXIMITY_EXCHANGE",
  "PROXIMITY_MIXER",
  "PROXIMITY_DARKNET",
  "PROXIMITY_MINING_POOL",
  "PROXIMITY_GAMBLING",
  "PROXIMITY_P2P",
  "PROXIMITY_SCAM",
]);

// ─── Phase C: Wallet fingerprinting ──────────────────────────────────────────

export function detectFingerprintingIssues(ctx: AuditContext): {
  findings: PrivacyFinding[];
  hasFingerprintData: boolean;
  needsResync: boolean;
  fingerprintCoverage: number;
} {
  const findings: PrivacyFinding[] = [];
  let hasFingerprintData = false;
  let needsResync = false;
  let txsWithoutData = 0;
  let txsTotal = 0;

  for (const [txid, tx] of ctx.transactions) {
    txsTotal++;
    const rawTx = tx as BlockchainTransaction & {
      nVersion?: number;
      nLockTime?: number;
      hasRbf?: boolean;
      isBip69Ordered?: boolean;
      hasLowRSig?: boolean;
      hasMixedWitness?: boolean;
      rawFingerprintCaptured?: boolean;
    };

    if (!rawTx.rawFingerprintCaptured) {
      txsWithoutData++;
      continue;
    }

    hasFingerprintData = true;
    const parts = ctx.participantsByTxid.get(txid) ?? [];
    const ourAddrs = parts.filter(p => ctx.userAddresses.has(p.address)).map(p => p.address);
    if (ourAddrs.length === 0) continue;

    // nVersion anomaly (version 1 is less common for modern wallets)
    if (rawTx.nVersion !== undefined && rawTx.nVersion === 1) {
      findings.push({
        type: "FINGERPRINT_NVERSION",
        severity: "LOW",
        description: `Transaction uses nVersion=1. Modern wallets typically use nVersion=2. Using v1 can fingerprint the signing software.`,
        details: { nVersion: rawTx.nVersion },
        correction: "Use a wallet that creates v2 transactions (standard for BIP68 relative locktime support).",
        txids: [txid],
        addresses: ourAddrs,
      });
    }

    // nLockTime anomaly: non-zero values that aren't the current block height fingerprint the wallet
    if (rawTx.nLockTime !== undefined && rawTx.nLockTime > 0) {
      // Anti-fee-sniping wallets set nLockTime ≈ current block height (< 500_000_000).
      // Timestamps (≥ 500_000_000) and any other fixed non-zero values are wallet fingerprints.
      const isTimestampLock = rawTx.nLockTime >= 500_000_000;
      const blockHeight = rawTx.blockHeight ?? 0;
      // Allow ± 2 blocks tolerance for anti-fee-sniping wallets
      const isLikelyAntiFeeSnipe =
        !isTimestampLock && blockHeight > 0 && Math.abs(rawTx.nLockTime - blockHeight) <= 2;
      if (!isLikelyAntiFeeSnipe) {
        findings.push({
          type: "FINGERPRINT_NLOCKTIME",
          severity: "LOW",
          description: isTimestampLock
            ? `Transaction uses a UNIX-timestamp nLockTime (${rawTx.nLockTime}), which is unusual and fingerprints the signing software.`
            : `Transaction uses a non-standard nLockTime of ${rawTx.nLockTime} (expected 0 or current block height for anti-fee-sniping). This reveals the wallet software.`,
          details: { nLockTime: rawTx.nLockTime },
          correction: "Use a wallet that sets nLockTime to the current block height (anti-fee-sniping) or 0.",
          txids: [txid],
          addresses: ourAddrs,
        });
      }
    }

    // RBF signaling
    if (rawTx.hasRbf === false) {
      findings.push({
        type: "FINGERPRINT_RBF",
        severity: "LOW",
        description: `Transaction does not signal RBF (replace-by-fee). Not signaling RBF identifies your wallet software — most modern wallets signal RBF by default.`,
        details: { hasRbf: false },
        correction: "Use a wallet that signals RBF (nSequence < 0xFFFFFFFE) for all transactions.",
        txids: [txid],
        addresses: ourAddrs,
      });
    }

    // BIP69 ordering check
    if (rawTx.isBip69Ordered === false) {
      findings.push({
        type: "FINGERPRINT_BIP69",
        severity: "LOW",
        description: `Transaction inputs/outputs are not in BIP69 lexicographic order. Non-BIP69 ordering reveals the wallet software and change output position.`,
        details: { bip69: false },
        correction: "Use a wallet that implements BIP69 deterministic input/output ordering.",
        txids: [txid],
        addresses: ourAddrs,
      });
    }

    // Low-R DER signature
    // hasLowRSig is derived from witness hex at parse time.
    // false = witness data present but no low-R sig found → non-Bitcoin-Core wallet.
    // undefined = no witness data available (legacy or non-segwit tx) → skip check.
    if (rawTx.hasLowRSig === false) {
      findings.push({
        type: "FINGERPRINT_LOW_R",
        severity: "LOW",
        description: `Transaction uses SegWit inputs but the DER signatures are NOT low-R. Bitcoin Core and privacy-focused wallets use low-R signature grinding — absence of low-R reveals the signing software.`,
        details: { hasLowRSig: false },
        correction: "Use Bitcoin Core or a wallet that implements low-R DER signature grinding (reduces signature size and prevents fingerprinting).",
        txids: [txid],
        addresses: ourAddrs,
      });
    }

    // Mixed witness inputs: some inputs have SegWit witness data, some do not.
    // This reveals that the wallet is co-spending legacy and native SegWit UTXOs
    // in the same transaction, which is a distinctive wallet fingerprint.
    if (rawTx.hasMixedWitness === true) {
      findings.push({
        type: "FINGERPRINT_WITNESS_INCONSISTENCY",
        severity: "LOW",
        description: `Transaction mixes SegWit inputs (with witness data) and legacy inputs (without witness data) in the same transaction. This mixed-witness pattern fingerprints the signing software and reveals wallet UTXO pool composition.`,
        details: { hasMixedWitness: true },
        correction: "Consolidate UTXOs to a single script type (native SegWit / Taproot) before spending, or use coin control to avoid co-spending legacy and SegWit UTXOs together.",
        txids: [txid],
        addresses: ourAddrs,
      });
    }
  }

  // Flag needsResync whenever ANY tx lacks fingerprint capture data.
  // This ensures users know their fingerprint analysis is partial, not silently incomplete.
  if (txsTotal > 0 && txsWithoutData > 0) {
    needsResync = true;
  }

  const fingerprintCoverage = txsTotal > 0 ? (txsTotal - txsWithoutData) / txsTotal : 1;

  return { findings, hasFingerprintData, needsResync, fingerprintCoverage };
}

// ─── Phase D: Recurring payment detection ─────────────────────────────────────

/**
 * Detects external addresses that appear as outputs across 3+ distinct
 * transactions, indicating possible recurring payment patterns that leak
 * behavioral metadata to an observer watching those recipient addresses.
 */
export function detectRecurringPayments(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  // Map external-address → Set of txids it appears as an output in
  const externalOutputCount = new Map<string, Set<string>>();

  for (const [txid, participants] of ctx.participantsByTxid) {
    for (const p of participants) {
      if (p.role !== "output") continue;
      if (!p.address || ctx.userAddresses.has(p.address)) continue;
      let set = externalOutputCount.get(p.address);
      if (!set) { set = new Set(); externalOutputCount.set(p.address, set); }
      set.add(txid);
    }
  }

  const THRESHOLD = 3;
  const recurring: Array<{ address: string; txids: string[] }> = [];
  for (const [address, txSet] of externalOutputCount) {
    if (txSet.size >= THRESHOLD) {
      recurring.push({ address, txids: [...txSet] });
    }
  }

  if (recurring.length === 0) return findings;

  const allTxids = [...new Set(recurring.flatMap(r => r.txids))];
  const addrList = recurring.map(r => r.address);

  findings.push({
    type: "RECURRING_PAYMENT",
    severity: "LOW",
    description: `${recurring.length} external address(es) appear as recipients in ${THRESHOLD}+ of your transactions, suggesting recurring payments (subscriptions, salary, regular bills). An observer monitoring those addresses can track your payment cadence.`,
    details: { recipientCount: recurring.length, transactionCount: allTxids.length },
    correction: "Use a different address for each payment (Lightning Network or one-time on-chain addresses) to break payment-cadence linkability.",
    txids: allTxids.slice(0, 20),
    addresses: addrList.slice(0, 20),
  });

  return findings;
}

// ─── Phase E: Coinbase origin detection ───────────────────────────────────────

/**
 * Detects when a user's addresses received funds directly from a coinbase
 * (block reward) transaction. Coinbase outputs are publicly associated with
 * mining pools and carry strong provenance metadata.
 */
export function detectCoinbaseOrigin(ctx: AuditContext): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  for (const [txid, tx] of ctx.transactions) {
    const rawTx = tx as BlockchainTransaction & { hasCoinbaseInput?: boolean };
    if (!rawTx.hasCoinbaseInput) continue;

    const participants = ctx.participantsByTxid.get(txid) ?? [];
    const ourOutputs = participants.filter(
      p => p.role === "output" && ctx.userAddresses.has(p.address)
    );
    if (ourOutputs.length === 0) continue;

    const ourAddrs = ourOutputs.map(p => p.address);
    findings.push({
      type: "COINBASE_ORIGIN",
      severity: "LOW",
      description: `Your address(es) received funds directly from a coinbase (block-reward) transaction. Coinbase outputs are tied to mining pools and are publicly traceable, creating strong provenance metadata on your funds.`,
      details: { txid, outputCount: ourOutputs.length },
      correction: "If privacy is important, consider using a CoinJoin or Lightning channel to break the direct link between coinbase outputs and your wallet.",
      txids: [txid],
      addresses: ourAddrs,
    });
  }

  return findings;
}

// ─── Main audit runner ────────────────────────────────────────────────────────

export async function runPrivacyAudit(
  userAddresses: string[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<PrivacyAuditResult> {
  if (userAddresses.length === 0) {
    return {
      findings: [],
      warnings: [],
      transactionsAnalyzed: 0,
      addressesScanned: 0,
      isClean: true,
      score: 100,
      grade: "A+",
      scoreWaterfall: [{ label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 }],
      needsResync: false,
      fingerprintCoverage: 1,
    };
  }

  const ctx = await buildAuditContext(userAddresses, onProgress, signal);

  onProgress?.("Detecting CoinJoin transactions...");
  const coinJoinResult = detectCoinJoin(ctx);
  const coinjoinTxids = coinJoinResult.coinjoinTxids;

  onProgress?.("Detecting multisig/escrow patterns...");
  const { findings: multisigFindings, multisigTxids } = detectMultisigEscrow(ctx);

  onProgress?.("Detecting script type mixing...");
  const scriptMixing = detectScriptTypeMixing(ctx);

  onProgress?.("Detecting dust UTXOs...");
  const dust = detectDustUTXOs(ctx);

  onProgress?.("Detecting consolidation patterns...");
  const consolidation = detectConsolidationOrigin(ctx);

  onProgress?.("Detecting exchange origin patterns...");
  const exchange = detectExchangeOrigin(ctx);

  onProgress?.("Detecting UTXO merge patterns...");
  const taintMerge = detectTaintedUTXOMerge(ctx);

  onProgress?.("Detecting address reuse...");
  const addressReuse = detectAddressReuse(ctx);

  onProgress?.("Detecting multi-owner co-spends...");
  const multiOwnerCoSpends = detectMultiOwnerCoSpend(ctx);

  onProgress?.("Detecting multi-owner address reuse...");
  const multiOwnerAddressReuse = detectMultiOwnerAddressReuse(ctx);

  onProgress?.("Detecting round amounts...");
  const roundAmounts = detectRoundAmounts(ctx, coinjoinTxids);

  onProgress?.("Detecting common-input-ownership...");
  const cioh = detectCommonInputOwnership(ctx, coinjoinTxids, multisigTxids);

  onProgress?.("Detecting unnecessary inputs...");
  const unnecessary = detectUnnecessaryInput(ctx, coinjoinTxids);

  onProgress?.("Detecting high-activity addresses...");
  const highActivity = detectHighActivity(ctx);

  onProgress?.("Detecting OP_RETURN metadata...");
  const opReturn = detectOpReturn(ctx);

  onProgress?.("Detecting UTXO set exposure...");
  const utxoExposure = detectUTXOSetExposure(ctx);

  onProgress?.("Detecting peel chains...");
  const peelChain = detectPeelChain(ctx, coinjoinTxids);

  onProgress?.("Detecting post-mix spending...");
  const postMix = detectPostMixSpending(ctx, coinjoinTxids);

  onProgress?.("Checking entity contacts...");
  const entityFindings = detectEntityContacts(ctx);

  onProgress?.("Computing entity proximity (BFS)...");
  const proximityFindings = detectEntityProximity(ctx);

  onProgress?.("Checking wallet fingerprinting...");
  const { findings: fpFindings, needsResync, fingerprintCoverage } = detectFingerprintingIssues(ctx);

  onProgress?.("Detecting recurring payment patterns...");
  const recurringPayments = detectRecurringPayments(ctx);

  onProgress?.("Detecting coinbase origin transactions...");
  const coinbaseOrigin = detectCoinbaseOrigin(ctx);

  // Aggregate all findings
  const allFindings: PrivacyFinding[] = [
    ...scriptMixing,
    ...dust.findings,
    ...consolidation,
    ...exchange.findings,
    ...taintMerge,
    ...addressReuse,
    ...multiOwnerCoSpends,
    ...multiOwnerAddressReuse,
    ...cioh,
    ...unnecessary,
    ...highActivity,
    ...utxoExposure,
    ...peelChain,
    ...postMix,
    ...entityFindings,
    ...proximityFindings,
    ...fpFindings,
    ...multisigFindings,
    ...recurringPayments,
    ...coinbaseOrigin,
  ];

  const allWarnings: PrivacyFinding[] = [
    ...dust.warnings,
    ...exchange.warnings,
    ...roundAmounts,
    ...opReturn,
    // CoinJoin findings are informational (positive privacy actions)
    ...coinJoinResult.whirlpool,
    ...coinJoinResult.wasabi,
    ...coinJoinResult.joinmarket,
  ];

  const severityOrder: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  allFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const { score, grade, waterfall } = computeScore(allFindings, allWarnings);

  return {
    findings: allFindings,
    warnings: allWarnings,
    transactionsAnalyzed: ctx.participantsByTxid.size,
    addressesScanned: ctx.userAddresses.size,
    isClean: allFindings.length === 0,
    score,
    grade,
    scoreWaterfall: waterfall,
    needsResync,
    fingerprintCoverage,
  };
}

// ─── Tag map ──────────────────────────────────────────────────────────────────

export const PRIVACY_TAG_MAP: Partial<Record<PrivacyFindingType, { tagName: string; color: string }>> = {
  SCRIPT_TYPE_MIXING: { tagName: "privacy:script-mixing", color: "#f97316" },
  DUST: { tagName: "privacy:dust", color: "#eab308" },
  DUST_SPENDING: { tagName: "privacy:dust-spending", color: "#ef4444" },
  CONSOLIDATION_ORIGIN: { tagName: "privacy:consolidation", color: "#8b5cf6" },
  EXCHANGE_ORIGIN: { tagName: "privacy:exchange-origin", color: "#3b82f6" },
  TAINTED_UTXO_MERGE: { tagName: "privacy:taint-merge", color: "#ef4444" },
  ADDRESS_REUSE: { tagName: "privacy:address-reuse", color: "#ef4444" },
  ROUND_AMOUNT: { tagName: "privacy:round-amount", color: "#f59e0b" },
  COMMON_INPUT_OWNERSHIP: { tagName: "privacy:cioh", color: "#f97316" },
  MULTI_OWNER_CO_SPEND: { tagName: "privacy:multi-owner-co-spend", color: "#ef4444" },
  MULTI_OWNER_ADDRESS_REUSE: { tagName: "privacy:multi-owner-address-reuse", color: "#ef4444" },
  UNNECESSARY_INPUT: { tagName: "privacy:unnecessary-input", color: "#64748b" },
  RECURRING_PAYMENT: { tagName: "privacy:recurring", color: "#0ea5e9" },
  HIGH_ACTIVITY: { tagName: "privacy:high-activity", color: "#8b5cf6" },
  COINBASE_ORIGIN: { tagName: "privacy:coinbase", color: "#22c55e" },
  MULTISIG_ESCROW: { tagName: "privacy:multisig", color: "#64748b" },
  OP_RETURN_METADATA: { tagName: "privacy:op-return", color: "#64748b" },
  UTXO_SET_EXPOSURE: { tagName: "privacy:utxo-exposure", color: "#8b5cf6" },
  COINJOIN_WHIRLPOOL: { tagName: "privacy:coinjoin-whirlpool", color: "#22c55e" },
  COINJOIN_WASABI: { tagName: "privacy:coinjoin-wasabi", color: "#22c55e" },
  COINJOIN_JOINMARKET: { tagName: "privacy:coinjoin-joinmarket", color: "#22c55e" },
  POST_MIX_SPENDING: { tagName: "privacy:post-mix-spending", color: "#f97316" },
  PEEL_CHAIN: { tagName: "privacy:peel-chain", color: "#f97316" },
  ENTITY_EXCHANGE: { tagName: "privacy:entity-exchange", color: "#3b82f6" },
  ENTITY_MIXER: { tagName: "privacy:entity-mixer", color: "#ec4899" },
  ENTITY_DARKNET: { tagName: "privacy:entity-darknet", color: "#7c3aed" },
  ENTITY_MINING_POOL: { tagName: "privacy:entity-mining-pool", color: "#64748b" },
  ENTITY_GAMBLING: { tagName: "privacy:entity-gambling", color: "#f59e0b" },
  ENTITY_P2P: { tagName: "privacy:entity-p2p", color: "#0ea5e9" },
  ENTITY_SCAM: { tagName: "privacy:entity-scam", color: "#ef4444" },
  FINGERPRINT_NVERSION: { tagName: "privacy:fingerprint-nversion", color: "#64748b" },
  FINGERPRINT_NLOCKTIME: { tagName: "privacy:fingerprint-nlocktime", color: "#64748b" },
  FINGERPRINT_RBF: { tagName: "privacy:fingerprint-rbf", color: "#64748b" },
  FINGERPRINT_BIP69: { tagName: "privacy:fingerprint-bip69", color: "#64748b" },
  FINGERPRINT_LOW_R: { tagName: "privacy:fingerprint-low-r", color: "#64748b" },
  FINGERPRINT_WITNESS_INCONSISTENCY: { tagName: "privacy:fingerprint-witness", color: "#64748b" },
};

export const PRIVACY_TAG_NAMES = new Set(
  Object.values(PRIVACY_TAG_MAP)
    .filter((v): v is { tagName: string; color: string } => !!v)
    .map((v) => v.tagName)
);

// ─── Finding type label map ───────────────────────────────────────────────────

export const FINDING_TYPE_LABELS: Partial<Record<PrivacyFindingType, string>> = {
  SCRIPT_TYPE_MIXING: "Script Type Mixing",
  DUST: "Dust UTXO",
  DUST_SPENDING: "Dust Spending",
  CONSOLIDATION_ORIGIN: "Consolidation",
  EXCHANGE_ORIGIN: "Exchange Origin",
  TAINTED_UTXO_MERGE: "UTXO Merge",
  ADDRESS_REUSE: "Address Reuse",
  ROUND_AMOUNT: "Round Amount",
  COMMON_INPUT_OWNERSHIP: "Common Input Ownership",
  MULTI_OWNER_CO_SPEND: "Multi-Owner Co-Spend",
  MULTI_OWNER_ADDRESS_REUSE: "Multi-Owner Address Reuse",
  UNNECESSARY_INPUT: "Unnecessary Input",
  RECURRING_PAYMENT: "Recurring Payment",
  HIGH_ACTIVITY: "High Activity Address",
  COINBASE_ORIGIN: "Coinbase Origin",
  MULTISIG_ESCROW: "Multisig/Escrow",
  OP_RETURN_METADATA: "OP_RETURN Metadata",
  UTXO_SET_EXPOSURE: "UTXO Set Exposure",
  COINJOIN_WHIRLPOOL: "Whirlpool CoinJoin",
  COINJOIN_WASABI: "WabiSabi CoinJoin",
  COINJOIN_JOINMARKET: "JoinMarket CoinJoin",
  POST_MIX_SPENDING: "Post-Mix Spending",
  PEEL_CHAIN: "Peel Chain",
  ENTITY_EXCHANGE: "Exchange Contact",
  ENTITY_MIXER: "Mixer Contact",
  ENTITY_DARKNET: "Darknet Contact",
  ENTITY_MINING_POOL: "Mining Pool Contact",
  ENTITY_GAMBLING: "Gambling Contact",
  ENTITY_P2P: "P2P Exchange Contact",
  ENTITY_SCAM: "Scam Address Contact",
  PROXIMITY_EXCHANGE: "Exchange Proximity",
  PROXIMITY_MIXER: "Mixer Proximity",
  PROXIMITY_DARKNET: "Darknet Proximity",
  PROXIMITY_MINING_POOL: "Mining Pool Proximity",
  PROXIMITY_GAMBLING: "Gambling Proximity",
  PROXIMITY_P2P: "P2P Exchange Proximity",
  PROXIMITY_SCAM: "Scam Address Proximity",
  FINGERPRINT_NVERSION: "Wallet Fingerprint (nVersion)",
  FINGERPRINT_NLOCKTIME: "Wallet Fingerprint (nLockTime)",
  FINGERPRINT_RBF: "Wallet Fingerprint (RBF)",
  FINGERPRINT_BIP69: "Wallet Fingerprint (BIP69)",
  FINGERPRINT_LOW_R: "Wallet Fingerprint (low-R)",
  FINGERPRINT_WITNESS_INCONSISTENCY: "Wallet Fingerprint (Mixed Witness)",
};
