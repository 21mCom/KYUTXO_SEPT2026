import { db } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";
import { getParticipantsByAddresses } from "@/lib/data/record-queries";

export type PrivacySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type PrivacyFindingType =
  | "SCRIPT_TYPE_MIXING"
  | "DUST"
  | "DUST_SPENDING"
  | "CONSOLIDATION_ORIGIN"
  | "EXCHANGE_ORIGIN"
  | "TAINTED_UTXO_MERGE";

export interface PrivacyFinding {
  type: PrivacyFindingType;
  severity: PrivacySeverity;
  description: string;
  details: Record<string, unknown>;
  correction: string;
  txids: string[];
  addresses: string[];
}

export interface PrivacyAuditResult {
  findings: PrivacyFinding[];
  warnings: PrivacyFinding[];
  transactionsAnalyzed: number;
  addressesScanned: number;
  isClean: boolean;
}

export interface AuditContext {
  userAddresses: Set<string>;
  participants: TransactionParticipant[];
  participantsByTxid: Map<string, TransactionParticipant[]>;
}

async function buildAuditContext(
  userAddresses: string[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<AuditContext> {
  const addressSet = new Set(userAddresses);

  onProgress?.("Loading transaction participants...");
  const participants = await getParticipantsByAddresses(userAddresses, signal);

  const ourTxids = new Set(participants.map((p: TransactionParticipant) => p.txid));

  onProgress?.("Loading full transaction data...");
  const allParticipantsForTxs: TransactionParticipant[] = [];
  const txidArray = Array.from(ourTxids);
  const BATCH = 500;
  for (let i = 0; i < txidArray.length; i += BATCH) {
    const batch = txidArray.slice(i, i + BATCH);
    const batchParticipants = await db.transactionParticipants
      .where("txid")
      .anyOf(batch)
      .toArray();
    allParticipantsForTxs.push(...batchParticipants);
  }

  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  for (const p of allParticipantsForTxs) {
    const list = participantsByTxid.get(p.txid);
    if (list) {
      list.push(p);
    } else {
      participantsByTxid.set(p.txid, [p]);
    }
  }

  return {
    userAddresses: addressSet,
    participants,
    participantsByTxid,
  };
}

function detectScriptTypeMixing(ctx: AuditContext): PrivacyFinding[] {
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

function detectDustUTXOs(ctx: AuditContext): { findings: PrivacyFinding[]; warnings: PrivacyFinding[] } {
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
    findings.push({
      type: "DUST",
      severity: isStrict ? "CRITICAL" : "MEDIUM",
      description: `Unspent dust UTXO at ${d.address} (${d.sats} sats). ${isStrict ? "Below relay threshold — likely a dust attack." : "Small enough to be used as a tracking vector."}`,
      details: { sats: d.sats, vout: d.vout, unspent: true },
      correction:
        "Do not spend dust UTXOs with your other coins — this links your addresses. Either ignore the dust or spend it in a CoinJoin transaction.",
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

function detectDustSpending(ctx: AuditContext): PrivacyFinding[] {
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

function detectConsolidationOrigin(ctx: AuditContext): PrivacyFinding[] {
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

function detectExchangeOrigin(ctx: AuditContext): { findings: PrivacyFinding[]; warnings: PrivacyFinding[] } {
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

function detectTaintedUTXOMerge(ctx: AuditContext): PrivacyFinding[] {
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
    };
  }

  const ctx = await buildAuditContext(userAddresses, onProgress, signal);

  onProgress?.("Detecting script type mixing...");
  const scriptMixing = detectScriptTypeMixing(ctx);

  onProgress?.("Detecting dust UTXOs...");
  const dust = detectDustUTXOs(ctx);

  onProgress?.("Detecting consolidation patterns...");
  const consolidation = detectConsolidationOrigin(ctx);

  onProgress?.("Detecting exchange origin...");
  const exchange = detectExchangeOrigin(ctx);

  onProgress?.("Detecting UTXO merge patterns...");
  const taintMerge = detectTaintedUTXOMerge(ctx);

  const allFindings = [
    ...scriptMixing,
    ...dust.findings,
    ...consolidation,
    ...exchange.findings,
    ...taintMerge,
  ];

  const allWarnings = [...dust.warnings, ...exchange.warnings];

  allFindings.sort((a: PrivacyFinding, b: PrivacyFinding) => {
    const order: Record<PrivacySeverity, number> = {
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
    };
    return order[a.severity] - order[b.severity];
  });

  return {
    findings: allFindings,
    warnings: allWarnings,
    transactionsAnalyzed: ctx.participantsByTxid.size,
    addressesScanned: ctx.userAddresses.size,
    isClean: allFindings.length === 0,
  };
}

export const PRIVACY_TAG_MAP: Record<PrivacyFindingType, { tagName: string; color: string }> = {
  SCRIPT_TYPE_MIXING: { tagName: "privacy:script-mixing", color: "#f97316" },
  DUST: { tagName: "privacy:dust", color: "#eab308" },
  DUST_SPENDING: { tagName: "privacy:dust-spending", color: "#ef4444" },
  CONSOLIDATION_ORIGIN: { tagName: "privacy:consolidation", color: "#8b5cf6" },
  EXCHANGE_ORIGIN: { tagName: "privacy:exchange-origin", color: "#3b82f6" },
  TAINTED_UTXO_MERGE: { tagName: "privacy:taint-merge", color: "#ef4444" },
};

export const PRIVACY_TAG_NAMES = new Set(
  Object.values(PRIVACY_TAG_MAP).map((v: { tagName: string }) => v.tagName)
);
