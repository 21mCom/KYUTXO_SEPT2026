import { useState, useCallback, useMemo, Fragment, useRef, useEffect } from "react";
import {
  Eye,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Tag,
  Shield,
  Fingerprint,
  Combine,
  Building2,
  Merge,
  TrendingDown,
  Activity,
  Repeat2,
  Layers,
  Lock,
  Shuffle,
  ArrowRightLeft,
  ArrowDown,
  CornerDownRight,
  Zap,
  Network,
  ScanSearch,
  Info,
  List,
  GitBranch,
  RotateCw,
  Download,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
  Sankey,
} from "recharts";
import { useLiveQuery } from "dexie-react-hooks";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { beginBulkOperation, endBulkOperation, db } from "@/lib/database";
import type { Record as DbRecord, PrivacyAuditHistoryEntry, TransactionParticipant } from "@/lib/database";
import { addPrivacyAuditHistoryEntry, clearPrivacyAuditHistory, setPrivacyAuditHistoryAdversary } from "@/lib/data/privacy-history-crud";
import {
  buildPrivacyHistoryCsv,
  buildPrivacyHistoryPdf,
  computePrivacyHistoryScopeLabel,
} from "@/lib/privacy-history-export";
import { formatScoreDelta } from "@/lib/privacy-report-export";
import { createTag } from "@/lib/data/vocabulary-crud";
import { updateRecord, countRecordsByType, getRecordsPageByTypeIdReverseKeyset, getRecordsByInputStrings } from "@/lib/data/record-crud";
import { getTransactionByTxid, getParticipantsByTxids } from "@/lib/data/transaction-crud";
import { useSettings, updatePeelChainViewMode, updateShowScoreBreakdown } from "@/hooks/use-settings";
import { useTags } from "@/hooks/use-tags";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { AddressLink } from "@/components/AddressLink";
import { TxidLink } from "@/components/TxidLink";
import { classifyBehavior, BEHAVIOR_LABEL_DISPLAY, type BehaviorProfile } from "@/lib/behavior-profile";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import {
  runPrivacyAudit,
  PRIVACY_TAG_MAP,
  PRIVACY_TAG_NAMES,
  FINDING_TYPE_LABELS,
  PROXIMITY_FINDING_TYPES,
  getProximityTagName,
  getProximityTagColor,
  type PrivacyAuditResult,
  type PrivacyFinding,
  type EntityCitation,
  type PrivacyFindingType,
  type PrivacySeverity,
  type ScoreWaterfallEntry,
} from "@/lib/privacy-audit";
import {
  runAdversaryView,
  type AdversaryViewResult,
  type AdversaryFinding,
  type ContextMergeWarning,
} from "@/lib/adversary-view";
import {
  loadAuditSession,
  beginAuditSession,
  saveAuditResult,
  saveAdversaryResult,
  clearAdversaryPending,
  clearAuditSession,
} from "@/lib/data/privacy-audit-session-store";
import { formatEntropy, type BoltzmannInput, type BoltzmannOutput } from "@/lib/boltzmann";
import type { BoltzmannResult } from "@/lib/boltzmann";
import { ScoreGauge, WaterfallChart } from "./privacy-audit/score-visualizations";
import { BoltzmannHeatmap } from "./privacy-audit/boltzmann-heatmap";
import { SANKEY_NODE_FILL, SANKEY_LINK_STROKE, buildSankey, type SankeyData } from "./privacy-audit/sankey-helpers";
import { WORKER_IDLE_TEARDOWN_MS, type DeepDiveData, summariseError, TransactionDeepDive, DeepDiveDialog } from "./privacy-audit/transaction-deep-dive";
import { type PeelStep, PEEL_PAYMENT_COLOR, PEEL_CHANGE_COLOR, PEEL_COINJOIN_COLOR, shortPeelAddr, shortPeelTxid, PeelChainView } from "./privacy-audit/peel-chain";
import { formatHistoryDate, PrivacyHistoryCard } from "./privacy-audit/privacy-history-card";
import { FindingCard } from "./privacy-audit/finding-card";
export { FindingCard } from "./privacy-audit/finding-card";
import { AdversaryViewPanel } from "./privacy-audit/adversary-view-panel";

// Re-exports so existing imports (tests + other pages) keep working without
// changing their import paths.
export { renderSourceNote };
export { contrastRatio, probColor, cellTextColor } from "./privacy-audit/boltzmann-heatmap";
export { TransactionDeepDive, DeepDiveDialog } from "./privacy-audit/transaction-deep-dive";
export { buildSankey, SANKEY_NODE_FILL, SANKEY_LINK_STROKE } from "./privacy-audit/sankey-helpers";
export type { SankeyData } from "./privacy-audit/sankey-helpers";
export { PeelChainView } from "./privacy-audit/peel-chain";
export { PrivacyHistoryCard } from "./privacy-audit/privacy-history-card";

type ScanState = "idle" | "analyzing" | "tagging" | "complete";

const AUDIT_INPUT_BATCH = 1000;
const TAG_FETCH_BATCH = 500;

// ─── Icon mapping ─────────────────────────────────────────────────────────────

const FINDING_TYPE_ICONS: Record<string, typeof Shield> = {
  SCRIPT_TYPE_MIXING: Fingerprint,
  DUST: AlertTriangle,
  DUST_SPENDING: AlertTriangle,
  CONSOLIDATION_ORIGIN: Combine,
  EXCHANGE_ORIGIN: Building2,
  TAINTED_UTXO_MERGE: Merge,
  ADDRESS_REUSE: Repeat2,
  ROUND_AMOUNT: Layers,
  COMMON_INPUT_OWNERSHIP: Network,
  UNNECESSARY_INPUT: Layers,
  RECURRING_PAYMENT: Repeat2,
  HIGH_ACTIVITY: Activity,
  COINBASE_ORIGIN: Zap,
  MULTISIG_ESCROW: Lock,
  OP_RETURN_METADATA: Info,
  UTXO_SET_EXPOSURE: Shield,
  COINJOIN_WHIRLPOOL: Shuffle,
  COINJOIN_WASABI: Shuffle,
  COINJOIN_JOINMARKET: Shuffle,
  POST_MIX_SPENDING: ArrowRightLeft,
  PEEL_CHAIN: TrendingDown,
  ENTITY_EXCHANGE: Building2,
  ENTITY_MIXER: Shuffle,
  ENTITY_DARKNET: ShieldAlert,
  ENTITY_MINING_POOL: Zap,
  ENTITY_GAMBLING: Activity,
  ENTITY_P2P: ArrowRightLeft,
  ENTITY_SCAM: ShieldAlert,
  PROXIMITY_EXCHANGE: Network,
  PROXIMITY_MIXER: Network,
  PROXIMITY_DARKNET: Network,
  PROXIMITY_MINING_POOL: Network,
  PROXIMITY_GAMBLING: Network,
  PROXIMITY_P2P: Network,
  PROXIMITY_SCAM: Network,
  FINGERPRINT_NVERSION: ScanSearch,
  FINGERPRINT_NLOCKTIME: ScanSearch,
  FINGERPRINT_RBF: ScanSearch,
  FINGERPRINT_BIP69: ScanSearch,
  FINGERPRINT_LOW_R: ScanSearch,
  FINGERPRINT_WITNESS_INCONSISTENCY: ScanSearch,
};

function getIcon(type: string): typeof Shield {
  return FINDING_TYPE_ICONS[type] ?? Shield;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

function getSeverityBadgeProps(severity: PrivacySeverity): {
  variant?: "destructive" | "default" | "secondary" | "outline";
  className?: string;
} {
  switch (severity) {
    case "CRITICAL":
      return { variant: "destructive" };
    case "HIGH":
      return { className: "bg-orange-500 text-white no-default-hover-elevate no-default-active-elevate" };
    case "MEDIUM":
      return { className: "bg-yellow-500 text-black no-default-hover-elevate no-default-active-elevate" };
    case "LOW":
      return { className: "bg-blue-500 text-white no-default-hover-elevate no-default-active-elevate" };
    default:
      return { variant: "secondary" };
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PrivacyAudit() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [result, setResult] = useState<PrivacyAuditResult | null>(null);
  const [adversaryResult, setAdversaryResult] = useState<AdversaryViewResult | null>(null);
  const [adversaryRunning, setAdversaryRunning] = useState(false);
  const [adversaryStatusMessage, setAdversaryStatusMessage] = useState("");
  const [adversaryCancelled, setAdversaryCancelled] = useState(false);
  const adversaryAbortRef = useRef<AbortController | null>(null);
  // History entry id for the audit whose adversary analysis is currently
  // running; used to mark that entry "cancelled" if the user aborts the run.
  const adversaryHistoryIdRef = useRef<number | null>(null);
  // Monotonic audit-run generation. Each runAudit invocation bumps this and the
  // async adversary handler captures its own generation, so a superseded run
  // can never attach its (stale, possibly differently-scoped) adversary summary
  // to history after a newer audit has started — even if it slips past the
  // abort-signal check while awaiting an intermediate persist step.
  const auditGenerationRef = useRef(0);

  const cancelAdversaryView = useCallback(() => {
    const controller = adversaryAbortRef.current;
    if (!controller) return;
    controller.abort();
    adversaryAbortRef.current = null;
    setAdversaryRunning(false);
    setAdversaryStatusMessage("");
    setAdversaryCancelled(true);
    // Record the cancellation on this run's history entry so the history card
    // and CSV/PDF exports show "cancelled" instead of a blank that would be
    // indistinguishable from "never ran".
    const historyId = adversaryHistoryIdRef.current;
    adversaryHistoryIdRef.current = null;
    if (historyId != null) {
      setPrivacyAuditHistoryAdversary(historyId, { status: "cancelled" }).catch(
        (err) => {
          console.error(
            "Failed to record adversary cancellation in audit history:",
            err,
          );
        },
      );
    }
  }, []);
  const [restoredNotice, setRestoredNotice] = useState<
    "restored" | "audit-interrupted" | "adversary-interrupted" | null
  >(null);
  const [restoredSavedAt, setRestoredSavedAt] = useState<number | null>(null);
  const rehydratedRef = useRef(false);

  // Rehydrate the last audit + adversary results after a page refresh so a
  // completed analysis isn't silently discarded.
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    let cancelled = false;
    loadAuditSession()
      .then((session) => {
        if (cancelled || !session) return;
        if (session.phase === "auditing") {
          // Refresh happened mid-analysis — nothing was saved for this run.
          setRestoredNotice("audit-interrupted");
          return;
        }
        if (session.result) {
          setRestoredSavedAt(session.savedAt ?? null);
          // Note: the owner/wallet filter dropdowns are deliberately NOT
          // restored — the user may already be changing them, and the saved
          // result stands on its own.
          setResult(session.result);
          setScanState("complete");
          if (session.adversaryResult) {
            setAdversaryResult(session.adversaryResult);
            setRestoredNotice("restored");
          } else if (session.adversaryPending) {
            // Main audit was saved but the adversary analysis never finished.
            setRestoredNotice("adversary-interrupted");
          } else {
            setRestoredNotice("restored");
          }
        }
      })
      .catch((err) => {
        console.error("Failed to restore privacy audit session:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [taggingProgress, setTaggingProgress] = useState({ current: 0, total: 0 });
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
  const [selectedWallet, setSelectedWallet] = useState<string>("all");
  const [openTypes, setOpenTypes] = useState<Record<string, boolean>>({});
  const { showScoreBreakdown } = useSettings();
  const showWaterfall = showScoreBreakdown;
  const setShowWaterfall = (next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(showWaterfall) : next;
    void updateShowScoreBreakdown(value);
  };

  const { tags } = useTags();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();

  const runAudit = useCallback(async () => {
    try {
      // Abort a previous adversary view still running from an earlier audit.
      // That aborted run is a cancellation too — mark its history entry so it
      // isn't left blank ("never ran") in history/exports.
      if (adversaryAbortRef.current) {
        adversaryAbortRef.current.abort();
        adversaryAbortRef.current = null;
        const staleHistoryId = adversaryHistoryIdRef.current;
        if (staleHistoryId != null) {
          setPrivacyAuditHistoryAdversary(staleHistoryId, { status: "cancelled" }).catch(
            (err) => {
              console.error(
                "Failed to record adversary cancellation in audit history:",
                err,
              );
            },
          );
        }
      }
      adversaryHistoryIdRef.current = null;
      const runGeneration = ++auditGenerationRef.current;
      setResult(null);
      setAdversaryResult(null);
      setAdversaryRunning(false);
      setAdversaryCancelled(false);
      setRestoredNotice(null);
      setRestoredSavedAt(null);
      setStatusMessage("Loading address records...");
      setScanState("analyzing");

      // Mark the run as in progress so a mid-analysis refresh is detectable
      // (the page shows an "interrupted — run again" notice on reload).
      try {
        await beginAuditSession(selectedOwner, selectedWallet);
      } catch (persistError) {
        console.error("Failed to persist audit session start:", persistError);
      }

      const totalAddresses = await countRecordsByType("address");

      if (totalAddresses === 0) {
        toast({ title: "No Records", description: "No address records found to audit." });
        setScanState("idle");
        await clearAuditSession().catch(() => {});
        return;
      }

      const userAddresses: string[] = [];
      let beforeIdExclusive: number | undefined = undefined;
      let scanned = 0;
      while (true) {
        const batch = await getRecordsPageByTypeIdReverseKeyset("address", {
          limit: AUDIT_INPUT_BATCH,
          beforeIdExclusive,
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          if (selectedOwner !== "all" && r.owner !== selectedOwner) continue;
          if (selectedWallet !== "all" && r.walletName !== selectedWallet) continue;
          if (r.inputString) userAddresses.push(r.inputString);
        }
        scanned += batch.length;
        setStatusMessage(
          `Loading address records… ${scanned.toLocaleString()} / ${totalAddresses.toLocaleString()}`
        );
        beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
        if (batch.length < AUDIT_INPUT_BATCH || beforeIdExclusive == null) break;
        await new Promise((r) => setTimeout(r, 0));
      }

      if (userAddresses.length === 0) {
        toast({ title: "No Matching Records", description: "No address records match the selected filters." });
        setScanState("idle");
        await clearAuditSession().catch(() => {});
        return;
      }

      const auditResult = await runPrivacyAudit(userAddresses, (msg) => setStatusMessage(msg));
      setResult(auditResult);
      setScanState("complete");

      // Persist the completed result so a page refresh restores it instead of
      // discarding it. The adversary result is attached when it finishes.
      try {
        await saveAuditResult(selectedOwner, selectedWallet, auditResult);
      } catch (persistError) {
        console.error("Failed to persist audit result:", persistError);
      }

      // Persist a snapshot so users can track their score over time. Saved
      // before the async adversary view launches so its summary can be
      // attached to this same entry once the analysis completes.
      let historyEntryId: number | null = null;
      try {
        const allItems = [...auditResult.findings, ...auditResult.warnings];
        const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        const findingTypeCounts: { [type: string]: number } = {};
        for (const f of allItems) {
          severityCounts[f.severity] += 1;
          findingTypeCounts[f.type] = (findingTypeCounts[f.type] ?? 0) + 1;
        }
        historyEntryId = await addPrivacyAuditHistoryEntry({
          timestamp: Date.now(),
          score: auditResult.score,
          grade: auditResult.grade,
          totalFindings: allItems.length,
          transactionsAnalyzed: auditResult.transactionsAnalyzed,
          addressesScanned: auditResult.addressesScanned,
          severityCounts,
          findingTypeCounts,
          owner: selectedOwner !== "all" ? selectedOwner : undefined,
          walletName: selectedWallet !== "all" ? selectedWallet : undefined,
        });
      } catch (historyError) {
        console.error("Failed to save privacy audit history:", historyError);
      }
      adversaryHistoryIdRef.current = historyEntryId;

      // Fire the adversary view asynchronously so the user sees main findings
      // immediately. It builds its own context from the same DB data. When it
      // completes, attach its summary to this run's history entry so exposure
      // can be tracked over time in the history card and CSV/PDF exports.
      setAdversaryRunning(true);
      setAdversaryStatusMessage("Starting adversary view\u2026");
      const advController = new AbortController();
      adversaryAbortRef.current = advController;
      runAdversaryView(
        userAddresses,
        (msg) => {
          if (!advController.signal.aborted) setAdversaryStatusMessage(msg);
        },
        advController.signal,
      )
        .then(async (advResult) => {
          if (advController.signal.aborted) return;
          if (adversaryAbortRef.current === advController) adversaryAbortRef.current = null;
          if (adversaryHistoryIdRef.current === historyEntryId) adversaryHistoryIdRef.current = null;
          setAdversaryResult(advResult);
          setAdversaryRunning(false);
          setAdversaryStatusMessage("");
          try {
            await saveAdversaryResult(advResult);
          } catch (persistError) {
            console.error("Failed to persist adversary view result:", persistError);
          }
          // Re-check right before the history write: a newer audit may have
          // started while awaiting saveAdversaryResult above, and its history
          // entry must not be confused with this (now superseded) run's data.
          if (auditGenerationRef.current !== runGeneration || advController.signal.aborted) {
            return;
          }
          if (historyEntryId != null) {
            try {
              await setPrivacyAuditHistoryAdversary(historyEntryId, {
                exposureCount: advResult.summary.exposureCount,
                addressesExposed: advResult.summary.addressesExposed,
                separationCount: advResult.summary.separationCount,
                confusionCount: advResult.summary.confusionCount,
                contextMergeCount: advResult.summary.contextMergeCount,
              });
            } catch (advHistoryError) {
              console.error(
                "Failed to save adversary view summary to audit history:",
                advHistoryError,
              );
            }
          }
        })
        .catch((advErr) => {
          if (adversaryAbortRef.current === advController) adversaryAbortRef.current = null;
          if (advController.signal.aborted) return;
          if (adversaryHistoryIdRef.current === historyEntryId) adversaryHistoryIdRef.current = null;
          console.error("Adversary view failed:", advErr);
          setAdversaryRunning(false);
          setAdversaryStatusMessage("");
          void clearAdversaryPending().catch(() => {});
        });

      toast({
        title: auditResult.isClean ? "All Clear" : "Audit Complete",
        description: auditResult.isClean
          ? `${auditResult.transactionsAnalyzed} transactions analyzed — no privacy issues found. Score: ${auditResult.score}/100 (${auditResult.grade})`
          : `Score: ${auditResult.score}/100 (${auditResult.grade}) — ${auditResult.findings.length} finding(s), ${auditResult.warnings.length} warning(s).`,
      });
    } catch (error) {
      console.error("Privacy audit failed:", error);
      toast({
        variant: "destructive",
        title: "Audit Failed",
        description: error instanceof Error ? error.message : "An error occurred during the audit.",
      });
      setScanState("idle");
    }
  }, [selectedOwner, selectedWallet, toast]);

  const hasProximityFindings = useMemo(() => {
    if (!result) return false;
    return [...result.findings, ...result.warnings].some(f => PROXIMITY_FINDING_TYPES.has(f.type));
  }, [result]);

  const tagProximityFindings = useCallback(async () => {
    if (!result) return;

    // Collect proximity findings only
    const proximityItems = [...result.findings, ...result.warnings].filter(f =>
      PROXIMITY_FINDING_TYPES.has(f.type)
    );

    if (proximityItems.length === 0) {
      toast({ title: "Nothing to Tag", description: "No proximity findings found." });
      return;
    }

    // Map owned address → Set<proximity tag names>
    const addressToProximityTags = new Map<string, Set<string>>();
    for (const f of proximityItems) {
      const tagName = getProximityTagName(f);
      if (!tagName) continue;
      for (const addr of f.addresses) {
        const existing = addressToProximityTags.get(addr);
        if (existing) existing.add(tagName);
        else addressToProximityTags.set(addr, new Set([tagName]));
      }
    }

    if (addressToProximityTags.size === 0) {
      toast({ title: "Nothing to Tag", description: "No addresses found in proximity findings." });
      return;
    }

    setScanState("tagging");
    setTaggingProgress({ current: 0, total: addressToProximityTags.size });

    try {
      // Ensure all required proximity tags exist in the vocabulary
      const existingTagNames = new Set(tags.map(t => t.name));
      const allProximityTagNames = new Set<string>();
      for (const tagSet of addressToProximityTags.values()) {
        for (const t of tagSet) allProximityTagNames.add(t);
      }
      for (const tagName of allProximityTagNames) {
        if (!existingTagNames.has(tagName)) {
          // Derive category from the tag name: proximity:<category>-<n>hop
          const match = tagName.match(/^proximity:([^-]+(?:-[^-]+)*)-(\d+)hop$/);
          const color = match
            ? getProximityTagColor(match[1] as Parameters<typeof getProximityTagColor>[0])
            : "#64748b";
          try {
            await createTag(tagName, color);
          } catch {
            // Already exists — safe to ignore
          }
        }
      }

      const tagAddresses = Array.from(addressToProximityTags.keys());
      const addressToRecord = new Map<string, DbRecord>();
      for (let i = 0; i < tagAddresses.length; i += TAG_FETCH_BATCH) {
        const slice = tagAddresses.slice(i, i + TAG_FETCH_BATCH);
        const found = await getRecordsByInputStrings(slice);
        for (const r of found) {
          if (r.inputString) addressToRecord.set(r.inputString, r);
        }
      }

      // Collect all proximity tag names for stripping old ones before re-applying
      const proximityTagPrefix = "proximity:";

      beginBulkOperation();
      try {
        const entries = Array.from(addressToProximityTags.entries());
        for (let idx = 0; idx < entries.length; idx++) {
          const [address, tagNames] = entries[idx];
          const record = addressToRecord.get(address);
          if (record?.id) {
            const existingTags = (record.tags || []).filter(
              (t: string) => !t.startsWith(proximityTagPrefix)
            );
            await updateRecord(record.id, { tags: [...existingTags, ...Array.from(tagNames)] });
          }
          setTaggingProgress({ current: idx + 1, total: entries.length });
          if (idx % 10 === 9) await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        endBulkOperation();
      }

      setScanState("complete");
      toast({
        title: "Proximity Tags Applied",
        description: `Applied proximity tags to ${addressToProximityTags.size} address record(s).`,
      });
    } catch (error) {
      console.error("Proximity tagging failed:", error);
      toast({
        variant: "destructive",
        title: "Tagging Failed",
        description: error instanceof Error ? error.message : "An error occurred during proximity tagging.",
      });
      setScanState("complete");
    }
  }, [result, tags, toast]);

  const tagFindings = useCallback(async () => {
    if (!result) return;

    const allItems = [...result.findings, ...result.warnings];
    const addressToFindings = new Map<string, Set<string>>();
    for (const f of allItems) {
      const tagInfo = PRIVACY_TAG_MAP[f.type];
      if (!tagInfo) continue;
      for (const addr of f.addresses) {
        const existing = addressToFindings.get(addr);
        if (existing) existing.add(tagInfo.tagName);
        else addressToFindings.set(addr, new Set([tagInfo.tagName]));
      }
    }

    if (addressToFindings.size === 0) {
      toast({ title: "Nothing to Tag", description: "No addresses found in the findings." });
      return;
    }

    setScanState("tagging");
    setTaggingProgress({ current: 0, total: addressToFindings.size });

    try {
      const existingTagNames = new Set(tags.map((t) => t.name));
      for (const info of Object.values(PRIVACY_TAG_MAP)) {
        if (info && !existingTagNames.has(info.tagName)) {
          await createTag(info.tagName, info.color);
        }
      }

      const tagAddresses = Array.from(addressToFindings.keys());
      const addressToRecord = new Map<string, DbRecord>();
      for (let i = 0; i < tagAddresses.length; i += TAG_FETCH_BATCH) {
        const slice = tagAddresses.slice(i, i + TAG_FETCH_BATCH);
        const found = await getRecordsByInputStrings(slice);
        for (const r of found) {
          if (r.inputString) addressToRecord.set(r.inputString, r);
        }
      }

      beginBulkOperation();
      try {
        const tagEntries = Array.from(addressToFindings.entries());
        for (let idx = 0; idx < tagEntries.length; idx++) {
          const address = tagEntries[idx][0];
          const tagNames = tagEntries[idx][1];
          const record = addressToRecord.get(address);
          if (record?.id) {
            const existingTags = (record.tags || []).filter((t: string) => !PRIVACY_TAG_NAMES.has(t));
            await updateRecord(record.id, { tags: [...existingTags, ...Array.from(tagNames)] });
          }
          setTaggingProgress({ current: idx + 1, total: tagEntries.length });
          if (idx % 10 === 9) await new Promise((r) => setTimeout(r, 0));
        }
      } finally {
        endBulkOperation();
      }

      setScanState("complete");
      toast({
        title: "Tagging Complete",
        description: `Applied privacy tags to ${addressToFindings.size} address record(s).`,
      });
    } catch (error) {
      console.error("Tagging failed:", error);
      toast({
        variant: "destructive",
        title: "Tagging Failed",
        description: error instanceof Error ? error.message : "An error occurred during tagging.",
      });
      setScanState("complete");
    }
  }, [result, tags, toast]);

  const groupedFindings = useMemo(() => {
    if (!result) return [];
    const allItems = [...result.findings, ...result.warnings];
    const groups = new Map<PrivacyFindingType, PrivacyFinding[]>();
    for (const f of allItems) {
      const list = groups.get(f.type);
      if (list) list.push(f);
      else groups.set(f.type, [f]);
    }
    return Array.from(groups.entries()).map(([type, items]) => ({
      type,
      items,
      label: FINDING_TYPE_LABELS[type] ?? type,
      Icon: getIcon(type),
      highestSeverity: items.reduce<PrivacySeverity>((best, f) => {
        const order: Record<PrivacySeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return order[f.severity] < order[best] ? f.severity : best;
      }, "LOW"),
    }));
  }, [result]);

  const allFindingTxids = useMemo(() => {
    if (!result) return [];
    const seen = new Set<string>();
    const txids: string[] = [];
    for (const f of [...result.findings, ...result.warnings]) {
      for (const t of f.txids) {
        if (!seen.has(t)) { seen.add(t); txids.push(t); }
      }
    }
    return txids;
  }, [result]);

  const coinjoinWarningTxids = useMemo(() => {
    if (!result) return [];
    const seen = new Set<string>();
    const txids: string[] = [];
    for (const f of result.warnings) {
      if (!f.type.startsWith("COINJOIN_")) continue;
      for (const t of f.txids) {
        if (!seen.has(t)) { seen.add(t); txids.push(t); }
      }
    }
    return txids;
  }, [result]);

  const coinjoinWarningSet = useMemo(() => new Set(coinjoinWarningTxids), [coinjoinWarningTxids]);

  const countBySeverity = (severity: PrivacySeverity) => {
    if (!result) return 0;
    return [...result.findings, ...result.warnings].filter((f) => f.severity === severity).length;
  };

  const progressPercent =
    scanState === "tagging" && taggingProgress.total > 0
      ? Math.round((taggingProgress.current / taggingProgress.total) * 100)
      : 0;

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4 max-w-4xl mx-auto">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Privacy Audit
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-description">
            Scan your transaction history for privacy vulnerabilities using on-chain heuristics, entity detection,
            wallet fingerprinting, and Boltzmann linkability analysis. Everything runs fully offline.
          </p>
        </div>

        {/* Config card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit Configuration</CardTitle>
            <CardDescription>Select filters to scope the audit, then run the scan.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="space-y-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">Owner</label>
                <Select value={selectedOwner} onValueChange={setSelectedOwner}>
                  <SelectTrigger data-testid="select-owner">
                    <SelectValue placeholder="All Owners" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Owners</SelectItem>
                    {owners.map((o) => (
                      <SelectItem key={o.name} value={o.name}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">Wallet</label>
                <Select value={selectedWallet} onValueChange={setSelectedWallet}>
                  <SelectTrigger data-testid="select-wallet">
                    <SelectValue placeholder="All Wallets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Wallets</SelectItem>
                    {walletNames.map((w) => (
                      <SelectItem key={w.name} value={w.name}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={runAudit}
                disabled={scanState !== "idle" && scanState !== "complete"}
                data-testid="button-run-audit"
              >
                {scanState === "idle" || scanState === "complete" ? (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Run Audit
                  </>
                ) : (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {scanState === "analyzing" ? "Analyzing…" : "Tagging…"}
                  </>
                )}
              </Button>
            </div>

            {scanState === "tagging" && (
              <div className="space-y-1">
                <Progress value={progressPercent} className="h-2" data-testid="progress-audit" />
                <p className="text-xs text-muted-foreground" data-testid="text-progress-status">
                  Applying tags… {taggingProgress.current} / {taggingProgress.total}
                </p>
              </div>
            )}

            {scanState === "analyzing" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span data-testid="text-analyzing-status">{statusMessage || "Analyzing transactions…"}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {restoredNotice === "audit-interrupted" && (
          <Card className="border-amber-500/40 bg-amber-500/5" data-testid="banner-audit-interrupted">
            <CardContent className="p-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  The last audit was interrupted
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The page was refreshed while an audit was still running, so no results were
                  saved. Run the audit again to get fresh results.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {restoredNotice === "adversary-interrupted" && (
          <Card className="border-amber-500/40 bg-amber-500/5" data-testid="banner-adversary-interrupted">
            <CardContent className="p-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  Adversary View analysis was interrupted
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The audit results below were restored from your last run, but the page was
                  refreshed before the Adversary View analysis finished. Run the audit again to
                  include it.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {restoredNotice === "restored" && result && (
          <Card className="border-blue-500/30 bg-blue-500/5" data-testid="banner-audit-restored">
            <CardContent className="p-3 flex items-start gap-3">
              <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                Showing results restored from your last audit run
                {restoredSavedAt != null && (
                  <span data-testid="text-restored-saved-at">
                    {" "}(saved {new Date(restoredSavedAt).toLocaleString()})
                  </span>
                )}
                . Run the audit again for up-to-date results.
              </p>
            </CardContent>
          </Card>
        )}

        <PrivacyHistoryCard />

        {result?.needsResync && (
          <Card className="border-amber-500/40 bg-amber-500/5" data-testid="banner-needs-resync">
            <CardContent className="p-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Fingerprinting data incomplete</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {result.fingerprintCoverage != null && result.fingerprintCoverage < 1
                    ? `${Math.round(result.fingerprintCoverage * 100)}% of synced transactions have raw fingerprint data — `
                    : "Some synced transactions are missing raw fingerprint data — "}
                  wallet fingerprinting checks (nVersion, RBF, BIP69, low-R, mixed witness) are partial until those
                  addresses are re-synced via Transaction Sync.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {result && (
          <>
            {/* Score summary */}
            <Card data-testid="container-score-summary">
              <CardContent className="p-4">
                <div className="flex flex-wrap gap-4 items-start justify-between">
                  <ScoreGauge score={result.score} grade={result.grade} />
                  <div className="flex-1 min-w-[200px] grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-total">
                        {result.findings.length + result.warnings.length}
                      </div>
                      <div className="text-xs text-muted-foreground">Total Issues</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-txs">
                        {result.transactionsAnalyzed.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">Txs Analyzed</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold" data-testid="text-stat-addresses">
                        {result.addressesScanned.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">Addresses Scanned</div>
                    </div>
                    <div className="col-span-2 sm:col-span-3 flex flex-wrap gap-1" data-testid="container-severity-summary">
                      {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as PrivacySeverity[]).map((sev) => {
                        const count = countBySeverity(sev);
                        if (count === 0) return null;
                        return (
                          <Badge
                            key={sev}
                            {...getSeverityBadgeProps(sev)}
                            data-testid={`badge-severity-${sev.toLowerCase()}`}
                          >
                            {count} {sev}
                          </Badge>
                        );
                      })}
                      {result.isClean && (
                        <Badge className="bg-green-500 text-white no-default-hover-elevate no-default-active-elevate" data-testid="text-clean-badge">
                          <ShieldCheck className="h-3 w-3 mr-1" /> Clean
                        </Badge>
                      )}
                    </div>
                  </div>

                  {result.scoreWaterfall.length > 1 && (
                    <div className="w-full mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowWaterfall(v => !v)}
                        data-testid="button-toggle-waterfall"
                      >
                        <ChevronDown className={`h-3 w-3 mr-1 transition-transform ${showWaterfall ? "rotate-180" : ""}`} />
                        {showWaterfall ? "Hide" : "Show"} Score Breakdown
                      </Button>
                      {showWaterfall && (
                        <div className="mt-2">
                          <WaterfallChart entries={result.scoreWaterfall} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Proximity data-sparsity caveat — mandatory whenever the audit ran */}
            <Card className="border-blue-500/30 bg-blue-500/5" data-testid="banner-proximity-caveat">
              <CardContent className="p-3 flex items-start gap-3">
                <Network className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                    Entity proximity is measured over locally synced data only
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    The proximity scores above reflect the shortest path to known entities
                    <strong> through transactions already imported into KYUTXO</strong>. If an address
                    has never been synced, no path to it can be found — "no proximity finding"
                    means "not in your local data," not "safe."
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            {!result.isClean && (
              <div className="flex flex-wrap justify-end gap-2">
                {hasProximityFindings && (
                  <Button
                    variant="outline"
                    onClick={tagProximityFindings}
                    disabled={scanState === "tagging"}
                    data-testid="button-tag-proximity-findings"
                  >
                    {scanState === "tagging" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Network className="mr-2 h-4 w-4" />
                    )}
                    Tag Proximity Findings
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={tagFindings}
                  disabled={scanState === "tagging"}
                  data-testid="button-tag-findings"
                >
                  {scanState === "tagging" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Tag className="mr-2 h-4 w-4" />
                  )}
                  Tag All Findings
                </Button>
              </div>
            )}

            {/* Per-transaction deep-dive: heatmap, entropy, and CoinJoin fund-flow */}
            {allFindingTxids.length > 0 && (
              <TransactionDeepDive
                txids={allFindingTxids}
                coinjoinTxids={coinjoinWarningSet}
              />
            )}

            {/* Clean state */}
            {groupedFindings.length === 0 && result.isClean && (
              <Card>
                <CardContent className="p-8 text-center">
                  <ShieldCheck className="h-12 w-12 text-green-500 mx-auto mb-3" />
                  <h3 className="text-lg font-medium" data-testid="text-no-findings">
                    No Privacy Issues Found
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your transaction history shows no detectable privacy vulnerabilities.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Finding groups */}
            <div className="space-y-3">
              {groupedFindings.map(({ type, items, label, Icon, highestSeverity }) => {
                const isOpen = openTypes[type] ?? true;
                return (
                  <Collapsible
                    key={type}
                    open={isOpen}
                    onOpenChange={(open) => setOpenTypes((prev) => ({ ...prev, [type]: open }))}
                  >
                    <Card>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 py-3 px-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span
                              className="font-medium text-sm"
                              data-testid={`text-group-title-${type.toLowerCase()}`}
                            >
                              {label}
                            </span>
                            <Badge
                              {...getSeverityBadgeProps(highestSeverity)}
                              data-testid={`badge-group-severity-${type.toLowerCase()}`}
                            >
                              {items.length}
                            </Badge>
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${
                              isOpen ? "rotate-180" : ""
                            }`}
                          />
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0 pb-4 px-4 space-y-3">
                          {items.map((finding, idx) => (
                            <FindingCard
                              key={`${finding.type}-${idx}`}
                              finding={finding}
                              coinjoinTxids={coinjoinWarningSet}
                            />
                          ))}
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                );
              })}
            </div>

            {/* Adversary View */}
            <AdversaryViewPanel
              running={adversaryRunning}
              statusMessage={adversaryStatusMessage}
              result={adversaryResult}
              cancelled={adversaryCancelled}
              onCancel={cancelAdversaryView}
            />
          </>
        )}
      </div>
    </ScrollArea>
  );
}
