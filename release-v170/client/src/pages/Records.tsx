import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Search as SearchIcon, Database, Hash, AlertCircle, Trash2, X, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { type Record as DbRecord, type CustomField, type BlockchainTransaction, type TransactionParticipant, USER_CURATED_TIERS, isHiddenDiscoveryTier, beginBulkOperation, endBulkOperation } from "@/lib/database";
import { type PanelRecord, toPanelRecord } from "@/lib/recordToPanel";
import { useDbChangeSignal } from "@/hooks/use-db-change-signal";
import { deleteRecord, getParticipantsByTxids } from "@/lib/dataFacade";
import { getAllCustomFields } from "@/lib/data/custom-fields-crud";
import {
  getRecord,
  countRecords,
  countBlockchainDiscovered,
  getRecordsPageByIdReverse,
  getAddressRecordsByImportanceTierLimited,
  countRecordsByTypeAndImportanceTiers,
  getRecordsPageByTypeIdReverse,
  getRecordsByTypeAndImportanceLimited,
  getRecordsByInputStrings,
  countRecordsByType,
  getRecordsPageByIdReverseKeyset,
  getAddressRecordsByImportanceTierPage,
  getRecordsPageByTypeIdReverseKeyset,
  getRecordsPageByTypeAndImportanceTiersKeyset,
  getRecordsPageByCreatedAtKeyset,
  countRecordsByCreatedAtWindow,
  type CreatedAtCursor,
  bulkGetRecords,
  countHiddenTierMatches,
  type HiddenTierMatchCount,
  bulkDeleteRecordsWithArchiving,
} from "@/lib/data/record-crud";
import { DateAddedFilter, type DateAddedSort } from "@/components/DateAddedFilter";
import {
  engineGetRecordPage,
  engineCountRecords,
  subscribeEngineReadiness,
} from "@/lib/engine/engine-client";
import { evaluateEngineFreshness } from "@/lib/engine/engine-freshness";
import { getTransactionsByTxidStartsWith } from "@/lib/data/transaction-crud";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { TxidLink } from "@/components/TxidLink";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ActiveFiltersBar } from "@/components/ActiveFiltersBar";
import { BehaviorFilter } from "@/components/BehaviorFilter";
import { behaviorLabelFromCachedStats, type BehaviorLabel } from "@/lib/behavior-profile";
import { useBehaviorTally } from "@/hooks/use-behavior-tally";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
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
import { useToast } from "@/hooks/use-toast";
import { searchPendingClass } from "@/lib/search-pending-class";
import { buildRecordsCollection, buildIdentifierSearchCollection, looksLikeBitcoinIdentifier, fetchRecordsPage, MAX_MATERIALIZE, resolveVisibleTierValues } from "@/lib/records-query";
import { getActivityBus } from "@/lib/activity-bus";
import { batchPreloadIdentifiers } from "@/lib/metadata-hover";
import { getVaultRepository } from "@/lib/repository";

// The records list and the detail panel share one converter so any new DB
// field flows through to both automatically (see `toPanelRecord`). `ConvertedRecord`
// stays as a local alias to avoid churn at the many existing call sites.
import { RecordFilters, ColumnFilter, UNASSIGNED_OWNER_VALUE } from "@/components/RecordFilters";
type ConvertedRecord = PanelRecord;

const convertRecord = toPanelRecord;

// Merge several id-descending tier streams into a single id-descending page.
// Used by the keyset tier branches: each group holds up to `limit` rows below
// the page anchor; the global top `limit` ids must each be within their tier's
// top `limit`, so flatten, dedupe by id (defensive), sort id-desc, slice.
function mergeTopRecordsById(groups: DbRecord[][], limit: number): DbRecord[] {
  const seen = new Set<number>();
  const merged: DbRecord[] = [];
  for (const group of groups) {
    for (const r of group) {
      const id = r.id;
      if (typeof id === 'number' && !seen.has(id)) {
        seen.add(id);
        merged.push(r);
      }
    }
  }
  merged.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  return merged.slice(0, limit);
}

// Behavior narrowing over a raw DB record. Labels derive from the cached
// on-chain stat fields already stored on each record (same single source of
// truth as the page's client-side behavior filter and RecordTable's badge),
// so this works as a plain JS predicate inside the bounded hidden-tier scan —
// no per-record DB lookups. An empty filter set means "no narrowing".
function matchesBehaviorFilters(record: DbRecord, filters: Set<BehaviorLabel>): boolean {
  if (filters.size === 0) return true;
  if (record.type !== 'address') return false;
  return filters.has(behaviorLabelFromCachedStats(record));
}

// Residual match predicate WITHOUT the tier exclusion — shared by the page
// load's filterFn and the hidden-matches count (which asks "would this
// hidden-tier row match the current narrowing if it weren't hidden?"). Built
// as a factory so the behavior-filter recount effect can rebuild it outside
// the load effect with identical semantics.
function buildResidualNoTier(opts: {
  search: string;
  columnFilters: ColumnFilter[];
  addedSince: number | null;
}): (record: DbRecord) => boolean {
  const { search, columnFilters, addedSince } = opts;
  return (record: DbRecord): boolean => {
    // Recency window composes with every branch (identifier lookup,
    // substring search, date-added keyset) as a residual predicate.
    if (addedSince !== null && (record.createdAt ?? 0) < addedSince) {
      return false;
    }
    for (const filter of columnFilters) {
      if (!matchesColumnFilter(record, filter)) return false;
    }
    if (search) {
      if (!(
        record.label?.toLowerCase().includes(search) ||
        record.inputString?.toLowerCase().includes(search) ||
        record.owner?.toLowerCase().includes(search) ||
        record.walletName?.toLowerCase().includes(search) ||
        record.notes?.toLowerCase().includes(search) ||
        record.tags?.some((t) => t.toLowerCase().includes(search)) ||
        record.categories?.some((c) => c.toLowerCase().includes(search))
      )) return false;
    }
    return true;
  };
}

function matchesColumnFilter(record: DbRecord, filter: ColumnFilter): boolean {
  let value: unknown;
  if (filter.field === 'hasNotes') {
    value = Boolean(record.notes && record.notes.trim() !== '');
  } else {
    value = (record as unknown as { [key: string]: unknown })[filter.field];
  }
  const nv = filter.value?.toLowerCase().trim() || '';
  switch (filter.operator) {
    case 'contains': return String(value || '').toLowerCase().includes(nv);
    case 'equals': return String(value || '').toLowerCase() === nv;
    case 'notEquals': return String(value || '').toLowerCase() !== nv;
    case 'startsWith': return String(value || '').toLowerCase().startsWith(nv);
    case 'endsWith': return String(value || '').toLowerCase().endsWith(nv);
    case 'isEmpty':
      if (Array.isArray(value)) return value.length === 0;
      return !value || String(value).trim() === '';
    case 'isNotEmpty':
      if (Array.isArray(value)) return value.length > 0;
      return Boolean(value) && String(value).trim() !== '';
    case 'includes':
      if (Array.isArray(value)) return value.some((v: unknown) => String(v).toLowerCase() === nv);
      return false;
    case 'excludes':
      if (Array.isArray(value)) return !value.some((v: unknown) => String(v).toLowerCase() === nv);
      return true;
    case 'isTrue': return Boolean(value);
    case 'isFalse': return !value;
    case 'isAnyOf': {
      let allowed: string[] = [];
      try {
        const parsed = JSON.parse(filter.value);
        if (Array.isArray(parsed)) allowed = parsed.filter((v): v is string => typeof v === 'string');
      } catch {
        allowed = [];
      }
      if (allowed.length === 0) return true;
      // Owner's synthetic Unassigned choice belongs to the same OR group as
      // named owners. Empty and whitespace-only legacy values are unassigned.
      if (filter.field === 'owner' && allowed.includes(UNASSIGNED_OWNER_VALUE) &&
        (!value || String(value).trim() === '')) return true;
      const normalizedAllowed = allowed
        .filter(v => v !== UNASSIGNED_OWNER_VALUE)
        .map((v) => v.toLowerCase());
      if (Array.isArray(value)) return value.some((v: unknown) => normalizedAllowed.includes(String(v).toLowerCase()));
      return normalizedAllowed.includes(String(value ?? '').toLowerCase());
    }
    default: return true;
  }
}

export default function Records() {
  const [location, navigate] = useLocation();
  const { openRecordEdit, openRecordAnnotation } = useRecordPreview();
  
  const PAGE_SIZE = 50;
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [navigableCount, setNavigableCount] = useState(0);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  // When a search/filter over the default view (discovered records hidden)
  // ALSO matches hidden blockchain-discovered/pending-review rows, this holds
  // that count so the UI can offer a one-click include instead of silently
  // dead-ending on "No records match". Computed as a deferred count.
  const [hiddenMatches, setHiddenMatches] = useState<HiddenTierMatchCount | null>(null);
  
  const [records, setRecords] = useState<ConvertedRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, isSearchPending] = useDebouncedValue(searchQuery, PAGE_DEBOUNCE.Records);
  const [urlSearchQuery, setUrlSearchQuery] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadPhase, setLoadPhase] = useState<string>('Initializing');
  const [countLoading, setCountLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySig, setRetrySig] = useState(0);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);
  
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  const [totalBlockchainDiscovered, setTotalBlockchainDiscovered] = useState(0);
  const [loadElapsedSec, setLoadElapsedSec] = useState(0);
  // Bumped whenever the native engine flips between ready/not-ready in the
  // background so the load effect re-runs and picks up the faster engine path
  // (or falls back) without a manual refresh. No-op in the browser preview.
  const [engineReadySignal, setEngineReadySignal] = useState(0);
  
  const [columnFilters, setColumnFilters] = useState<ColumnFilter[]>([]);
  // Date Added controls. 'default' = the control is untouched: keep the legacy
  // id-desc branches (and the engine fast path). Once the user engages the
  // sort toggle — explicit 'newest' OR 'oldest' — or sets a recency window,
  // ALL pages route through a createdAt keyset branch (engine when READY +
  // CURRENT, Dexie otherwise) so the displayed ordering is truly by date added
  // (createdAt can diverge from id order, e.g. restored records carry their
  // original createdAt).
  const [dateSort, setDateSort] = useState<DateAddedSort>('default');
  const [addedSince, setAddedSince] = useState<number | null>(null);
  const dateAddedActive = dateSort !== 'default' || addedSince !== null;
  // Behavior-label filter (Dormant, Accumulator, etc.). Derived client-side from
  // the cached on-chain stats already on each loaded record — no DB scan. Applied
  // to the loaded page only, so it is intentionally absent from the load effect.
  const [behaviorFilters, setBehaviorFilters] = useState<Set<BehaviorLabel>>(new Set());
  // Live view of the behavior filter for the hidden-matches machinery. The
  // load effect intentionally does NOT depend on behaviorFilters (behavior is
  // applied client-side to the loaded page), so its deferred hidden-match
  // count reads this ref at call time to honor the current selection.
  const behaviorFiltersRef = useRef(behaviorFilters);
  behaviorFiltersRef.current = behaviorFilters;
  // Monotonic token for hidden-match count runs. Every starter (a load's
  // deferred count, the engine count diff, or the behavior-filter recount)
  // claims a fresh token and only commits its result while still current, so
  // overlapping runs can never apply out of order.
  const hiddenCountRunRef = useRef(0);
  // Vault-wide per-behavior totals, materialized by a streamed background pass.
  // Shown beside each option in the behavior picker so the filter is actionable
  // even though it can only narrow the loaded page.
  const {
    counts: behaviorCounts,
    computing: behaviorCountsComputing,
    progress: behaviorCountsProgress,
    cancel: cancelBehaviorCounts,
    restart: restartBehaviorCounts,
  } = useBehaviorTally();
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [singleDeleteTarget, setSingleDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRecomputingSelection, setIsRecomputingSelection] = useState(false);
  
  const { toast } = useToast();
  
  const [matchingTxids, setMatchingTxids] = useState<string[]>([]);
  const [txidSearchResults, setTxidSearchResults] = useState<{
    txid: string;
    blockHeight: number;
    blockTime: number;
    participantAddresses: string[];
  }[]>([]);
  
  const dbChangeSignal = useDbChangeSignal(['records'], 250, {
    // When blockchain-discovered records are hidden (the default), background
    // transaction-sync writes don't affect what's visible. Skip those reloads
    // entirely so heavy sync sessions don't restart count/list queries.
    filter: (_tables, meta) => {
      if (meta?.origin === 'blockchain-sync' && !includeBlockchainDiscovered) {
        return false;
      }
      return true;
    },
  });

  const { tags: vocabTags } = useTags();
  const { categories: vocabCategories } = useCategories();
  const { owners: vocabOwners } = useOwners();
  const { walletNames: vocabWalletNames } = useWalletNames();
  const { seedNames: vocabSeedNames } = useSeedNames();
  const { walletSoftware: vocabWalletSoftware } = useWalletSoftware();

  useEffect(() => {
    try {
      // The wouter location carries the query string only in hash-routed
      // (packaged) mode; in browser mode it rides on window.location.search.
      const queryIndex = location.indexOf('?');
      const queryString = queryIndex >= 0
        ? location.substring(queryIndex + 1)
        : (window.location.search || '').replace(/^\?/, '');
      const params = new URLSearchParams(queryString);
      
      const id = params.get("id");
      const search = params.get("search");
      
      if (id) {
        setSelectedRecordId(id);
        setUrlSearchQuery(null);
      } else if (search) {
        const decodedSearch = decodeURIComponent(search);
        setUrlSearchQuery(decodedSearch);
        setSelectedRecordId(null);
      } else {
        setUrlSearchQuery(null);
      }
    } catch (error) {
      console.error('[Records] Failed to parse query params:', error);
    }
  }, [location]);

  // Apply a `?search=` deep link unconditionally. Gating this on a non-empty,
  // already-loaded record list used to silently drop the search on empty
  // vaults or while the first page was still loading, dumping the user on the
  // full unfiltered list with no sign of the identifier they clicked.
  useEffect(() => {
    if (urlSearchQuery !== null) {
      setSearchQuery(urlSearchQuery);
      setUrlSearchQuery(null);
    }
  }, [urlSearchQuery]);

  const hasActiveFilters = debouncedSearch !== '' || columnFilters.length > 0;

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, columnFilters, includeBlockchainDiscovered, behaviorFilters, dateSort, addedSince]);

  const loadVersionRef = useRef(0);
  const inFlightRef = useRef(0);
  // Keyset (cursor) pagination cache. `anchors` maps a page number to the
  // exclusive id boundary to start that page below (page 1 maps to undefined =
  // start from the top). Boundaries are filled in as the user navigates
  // Next/Previous, so adjacent navigation is O(PAGE_SIZE) instead of O(offset).
  // `signature` captures the query identity (filters/search/include/db version);
  // when it changes the cache is reset so stale boundaries are never reused.
  // Anchor values are the plain id boundary for the id-desc branches, or a
  // (createdAt, id) cursor for the date-added branch; the signature includes
  // the sort/recency mode so the two shapes are never mixed.
  const pageAnchorsRef = useRef<{ signature: string; anchors: Map<number, number | CreatedAtCursor | undefined> }>({
    signature: '',
    anchors: new Map<number, number | CreatedAtCursor | undefined>([[1, undefined]]),
  });

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setRetrySig(s => s + 1);
  }, []);

  // Re-run the load when the native engine finishes mirroring in the background
  // (or transitions back to not-ready). The subscription self-disables and starts
  // no polling in the browser preview where the engine is unavailable.
  useEffect(() => {
    return subscribeEngineReadiness(() => setEngineReadySignal(s => s + 1));
  }, []);

  useEffect(() => {
    const loadRecords = async () => {
      const version = ++loadVersionRef.current;
      inFlightRef.current++;
      setIsLoading(true);
      setLoadPhase('Initializing');
      setCountLoading(false);
      setLoadError(null);
      setHiddenMatches(null);

      const bus = getActivityBus();
      const taskId = `records-load-${version}`;
      bus.publishTask({
        id: taskId,
        label: 'Loading Records',
        phase: 'Initializing',
        current: 0,
        total: 0,
      });

      const t0 = performance.now();
      // NOTE: never log the raw search text — it can contain addresses/txids the
      // user would not want captured in a screenshot. Length only.
      console.log(
        `[Records] load v${version} start | signal=${dbChangeSignal} | includeBlockchain=${includeBlockchainDiscovered} | page=${currentPage} | searchLen=${debouncedSearch.length}`,
      );
      const setPhase = (phase: string) => {
        if (loadVersionRef.current === version) {
          setLoadPhase(phase);
          console.log(`[Records] load v${version} phase="${phase}" +${Math.round(performance.now() - t0)}ms`);
        }
      };

      try {
        setPhase('Loading custom fields');
        const fields = await getAllCustomFields();
        if (loadVersionRef.current !== version) return;
        setCustomFieldDefs(fields);

        const search = debouncedSearch.toLowerCase().trim();
        const isTxidSearch = search.length >= 8 && /^[a-fA-F0-9]+$/.test(search);
        // Exact identifier fast-path: a pasted full address/txid routes to the
        // inputStringLower index instead of the residual cross-field substring
        // scan (the 15-20 min freeze on large vaults). See records-query.ts.
        const identifierSearch = looksLikeBitcoinIdentifier(search);
        const filtersActive = search !== '' || columnFilters.length > 0;
        // Broader gate for the hidden-matches hint: the recency window
        // (addedSince) and the behavior filter also narrow the visible set —
        // a narrowing that only hidden-tier rows satisfy must still trigger
        // the count instead of silently dead-ending. Kept separate from
        // filtersActive so the count/paging branches below are unchanged.
        // Behavior is read via the ref so the deferred count (which runs
        // post-render) honors the selection current at that moment.
        const hiddenMatchFiltersActive = () =>
          filtersActive || addedSince !== null || behaviorFiltersRef.current.size > 0;

        // Residual predicate WITHOUT the tier exclusion — reused by the
        // hidden-matches count, which asks "would this hidden-tier row match
        // the current filters if it weren't hidden?".
        const residualNoTier = buildResidualNoTier({ search, columnFilters, addedSince });

        const filterFn = (record: DbRecord): boolean => {
          // Exclusion semantics (matches the engine SQL and browse paths):
          // hide only the two discovery tiers; missing/unrecognized tiers
          // remain visible.
          if (!includeBlockchainDiscovered && isHiddenDiscoveryTier(record.addressImportance)) {
            return false;
          }
          return residualNoTier(record);
        };
        
        const singleTypeFilter = !search && columnFilters.length === 1 &&
          columnFilters[0].field === 'type' &&
          columnFilters[0].operator === 'equals'
          ? columnFilters[0].value.trim() : null;

        const pgOffset = (currentPage - 1) * PAGE_SIZE;
        let rawRecords: DbRecord[];

        // Keyset pagination setup. Reset the cursor cache when the query identity
        // (filters/search/include) or the DB version changes, so we never reuse a
        // stale id boundary. `hasAnchor` is true for page 1 (boundary = undefined)
        // and for any page we previously cached a boundary for during sequential
        // navigation; otherwise we fall back to the O(offset) helpers for that one
        // load (e.g. the clamp-to-last-page jump after a count shrink).
        const anchorState = pageAnchorsRef.current;
        const querySignature = JSON.stringify({
          inc: includeBlockchainDiscovered,
          search,
          filters: columnFilters,
          db: dbChangeSignal,
          dateSort,
          addedSince,
        });
        if (anchorState.signature !== querySignature) {
          anchorState.signature = querySignature;
          anchorState.anchors = new Map<number, number | undefined>([[1, undefined]]);
        }
        const hasAnchor = anchorState.anchors.has(currentPage);
        const anchorValue = anchorState.anchors.get(currentPage);
        const beforeIdExclusive = typeof anchorValue === 'number' ? anchorValue : undefined;
        const createdAtCursor = anchorValue && typeof anchorValue === 'object' ? anchorValue : undefined;
        // Record the boundary for the next page once a full page is loaded; a
        // short page means there is no next page, so we leave it unset.
        const recordNextAnchor = (rows: DbRecord[]) => {
          if (rows.length === PAGE_SIZE) {
            const lastId = rows[rows.length - 1].id;
            if (typeof lastId === 'number') {
              anchorState.anchors.set(currentPage + 1, lastId);
            }
          }
        };

        // Native read-engine fast path (Task #274). When the desktop engine is
        // fully mirrored + indexed (READY) and the current query is one the
        // engine can express — no column filters, OR a single type-equals filter,
        // with or without a cross-field substring search — we let SQLite do the
        // heavy keyset paging / filtering / counting and only pull the matching
        // page of FULL records back from Dexie by primary key (a trivial 50-row
        // get). The mirror is a column subset, so hydrating from Dexie preserves
        // display fidelity. Anything the engine can't express, or the browser
        // preview, transparently falls back to the existing Dexie path below.
        const engineTypeFilter: string | null | undefined =
          columnFilters.length === 0
            ? null
            : columnFilters.length === 1 &&
                columnFilters[0].field === 'type' &&
                columnFilters[0].operator === 'equals' &&
                columnFilters[0].value.trim() !== ''
              ? columnFilters[0].value.trim()
              : undefined;
        // Page-specific expressibility: the engine can serve no-filter or a single
        // type-equals query, but never an identifier lookup. Identifier searches
        // (pasted full address/txid) have EXACT inputString semantics via
        // buildIdentifierSearchCollection — the engine's `search` is a cross-field
        // substring — so they must stay on the dedicated Dexie identifier branch.
        // Date-added sort/recency queries ARE engine-expressible (Task #1561):
        // the record page supports (createdAt, id) keyset ordering plus an
        // addedSince bound, so they stay on the fast path; the Dexie createdAt
        // keyset branch below remains the fallback per the freshness gate.
        const engineExpressible =
          engineTypeFilter !== undefined && !identifierSearch;
        // Readiness alone is not enough: the mirror is a manually (re)seeded read
        // replica, so it can stay READY while drifting from the live vault after a
        // create/edit/delete. evaluateEngineFreshness() confirms it is CURRENT
        // (records fingerprint match) and falls back to Dexie on any mismatch or
        // error — the one shared gate used across screens.
        let useEngine = false;
        if (engineExpressible) {
          const decision = await evaluateEngineFreshness('records');
          if (loadVersionRef.current !== version) return;
          useEngine = decision.useEngine;
        }
        // The read engine is a plaintext mirror. Packaged records reads are
        // served only by the protected repository DTO path below.
        const packagedProtected = getVaultRepository().kind === 'protected';
        if (packagedProtected) useEngine = false;

        // Dexie default view: resolve the tier values to include dynamically
        // (every distinct stored tier minus the hidden discovery tiers) so
        // rows with unrecognized legacy tier strings stay visible in browse
        // AND search — parity with the engine's exclusion SQL. O(#distinct
        // tiers) via uniqueKeys; falls back to USER_CURATED_TIERS on error.
        let visibleTiers: string[] | null = null;
        if (!useEngine && !includeBlockchainDiscovered) {
          visibleTiers = await resolveVisibleTierValues();
          if (loadVersionRef.current !== version) return;
        }
        const dexieVisibleTiers: string[] = visibleTiers ?? USER_CURATED_TIERS;
        const engineOpts = {
          includeBlockchainDiscovered,
          type: engineTypeFilter ?? undefined,
          search: search || undefined,
          // Date-added mode: the recency window is a native engine predicate,
          // and requireCreatedAt keeps counts aligned with the Dexie createdAt
          // index walk (which never yields rows missing the key).
          addedSince: dateAddedActive ? (addedSince ?? undefined) : undefined,
          requireCreatedAt: dateAddedActive || undefined,
        };

        // Counts run AFTER the first page is rendered for the winning version —
        // never before. Starting them earlier put expensive count queries on the
        // IndexedDB thread ahead of the critical row fetch, and any load that got
        // superseded before render would still spawn uncancellable counts,
        // amplifying load on huge vaults (the original stuck-loading cause). The
        // identifier/substring branches already derive their totals from the
        // awaited page fetch, so here they only refresh the hidden-records badge.
        // Deferred hidden-matches count for the Dexie paths: when a search or
        // filter runs over the default view (discovered hidden), count how
        // many hidden-tier rows would match the same filters. Bounded on both
        // sides (match cap → "1,000+", scan cap → lower bound) and
        // cancellation-aware. The engine path derives the same number as an
        // exact SQL count diff inside its count block instead.
        const startDexieHiddenMatchesCount = () => {
          // The engine count block computes this number as an exact SQL diff
          // instead — EXCEPT when a behavior filter is active: behavior labels
          // are not engine-expressible, so that combination falls back to this
          // bounded Dexie scan even on the engine path.
          const behaviorActive = behaviorFiltersRef.current.size > 0;
          if (useEngine && !behaviorActive) return;
          if (!hiddenMatchFiltersActive() || includeBlockchainDiscovered) return;
          const runId = ++hiddenCountRunRef.current;
          countHiddenTierMatches({
            matches: (r) =>
              residualNoTier(r) && matchesBehaviorFilters(r, behaviorFiltersRef.current),
            identifier: identifierSearch,
            isCancelled: () =>
              loadVersionRef.current !== version || hiddenCountRunRef.current !== runId,
          }).then((result) => {
            if (loadVersionRef.current !== version || hiddenCountRunRef.current !== runId) return;
            setHiddenMatches(result.count > 0 ? result : null);
          }).catch(e => { console.warn('[Records] Hidden-match count failed:', e); });
        };

        const runDeferredCounts = () => {
          startDexieHiddenMatchesCount();

          // Date-added Dexie branch: count the recency window (capped,
          // early-stop) with the same residual predicate the page fetch used,
          // plus the hidden-records badge. Identifier searches keep their own
          // totals. Engine-served date-added queries fall through to the engine
          // count block below (exact SQL counts honoring addedSince).
          if (dateAddedActive && !identifierSearch && !useEngine) {
            setCountLoading(true);
            countRecordsByCreatedAtWindow(addedSince ?? undefined, filterFn, MAX_MATERIALIZE)
              .then(({ count, truncated }) => {
                if (loadVersionRef.current !== version) return;
                setTotalCount(count);
                setNavigableCount(count);
                setResultsTruncated(truncated);
              })
              .catch(e => { console.warn('[Records] Date-added count failed:', e); })
              .finally(() => { if (loadVersionRef.current === version) setCountLoading(false); });
            countBlockchainDiscovered().then(c => {
              if (loadVersionRef.current !== version) return;
              setTotalBlockchainDiscovered(c);
            }).catch(e => { console.warn('[Records] Background blockchain count failed:', e); });
            return;
          }

          // Engine path: exact counts come straight from SQLite. The visible total
          // honors the active type/search/include; the hidden-records badge is the
          // global discovered count (all rows minus non-discovered rows).
          if (useEngine) {
            setCountLoading(true);
            // Hidden-matches hint (exact on the engine): re-run the same
            // filtered count with discovered rows included; the difference is
            // how many matches the default view is hiding. Behavior filters
            // aren't engine-expressible, so that combination is handled by
            // startDexieHiddenMatchesCount above instead of the SQL diff.
            const wantHiddenMatches =
              hiddenMatchFiltersActive() &&
              !includeBlockchainDiscovered &&
              behaviorFiltersRef.current.size === 0;
            const hiddenRunId = wantHiddenMatches ? ++hiddenCountRunRef.current : 0;
            Promise.all([
              engineCountRecords(engineOpts),
              engineCountRecords({ includeBlockchainDiscovered: true }),
              engineCountRecords({ includeBlockchainDiscovered: false }),
              wantHiddenMatches
                ? engineCountRecords({ ...engineOpts, includeBlockchainDiscovered: true })
                : Promise.resolve(null),
            ]).then(([visible, all, nonDiscovered, withHidden]) => {
              if (loadVersionRef.current !== version) return;
              setTotalCount(visible);
              setNavigableCount(visible);
              setTotalBlockchainDiscovered(Math.max(0, all - nonDiscovered));
              if (withHidden !== null && hiddenCountRunRef.current === hiddenRunId) {
                const hiddenCount = Math.max(0, withHidden - visible);
                setHiddenMatches(
                  hiddenCount > 0
                    ? { count: hiddenCount, capped: false, scanCapped: false }
                    : null,
                );
              }
            }).catch(e => { console.warn('[Records] Engine count failed:', e); })
              .finally(() => { if (loadVersionRef.current === version) setCountLoading(false); });
            return;
          }

          // Count-only default view (no filters, blockchain hidden): one coalesced
          // pass yields both the visible total and the badge so the
          // blockchain-discovered count runs at most once.
          if (!filtersActive && !includeBlockchainDiscovered) {
            setCountLoading(true);
            Promise.all([countRecords(), countBlockchainDiscovered()]).then(([total, blockchain]) => {
              if (loadVersionRef.current !== version) return;
              const visible = Math.max(0, total - blockchain);
              setTotalCount(visible);
              setNavigableCount(visible);
              setTotalBlockchainDiscovered(blockchain);
            }).catch(e => { console.warn('[Records] Background count failed (all+exclude):', e); })
              .finally(() => { if (loadVersionRef.current === version) setCountLoading(false); });
            return;
          }

          // Every other mode shows the hidden-records badge independently.
          countBlockchainDiscovered().then(c => {
            if (loadVersionRef.current !== version) return;
            setTotalBlockchainDiscovered(c);
          }).catch(e => { console.warn('[Records] Background blockchain count failed:', e); });

          if (!filtersActive && includeBlockchainDiscovered) {
            setCountLoading(true);
            countRecords().then(c => {
              if (loadVersionRef.current !== version) return;
              setTotalCount(c);
              setNavigableCount(c);
            }).catch(e => { console.warn('[Records] Background count failed (all+include):', e); })
              .finally(() => { if (loadVersionRef.current === version) setCountLoading(false); });
          } else if (singleTypeFilter) {
            setCountLoading(true);
            const countPromise = includeBlockchainDiscovered
              ? countRecordsByType(singleTypeFilter)
              : countRecordsByTypeAndImportanceTiers(singleTypeFilter, dexieVisibleTiers);
            countPromise.then(c => {
              if (loadVersionRef.current !== version) return;
              setTotalCount(c);
              setNavigableCount(c);
            }).catch(e => { console.warn('[Records] Background count failed (type):', e); })
              .finally(() => { if (loadVersionRef.current === version) setCountLoading(false); });
          }
          // identifier / substring search: totals already set from the page fetch.
        };

        setPhase('Fetching records');
        bus.publishTask({
          id: taskId,
          label: 'Loading Records',
          phase: 'Fetching records',
          current: 1,
          total: 3,
        });

        if (useEngine) {
          // SQLite does the ordered keyset page + filtering; we then hydrate the
          // FULL records from Dexie by primary key (bulkGet preserves order). For
          // an arbitrary page jump with no cached cursor we ask the engine for a
          // wider id-descending window and slice — same shape as the tier
          // branches' offset fallback.
          let pageRows;
          if (dateAddedActive) {
            // Date Added sort: (createdAt, id) keyset on the engine's createdAt
            // index. The cursor cache holds a (createdAt, id) pair for this mode.
            const createdAtSort = dateSort === 'oldest' ? 'oldest' as const : 'newest' as const;
            if (hasAnchor) {
              pageRows = await engineGetRecordPage({
                ...engineOpts,
                createdAtSort,
                createdAtCursor,
                limit: PAGE_SIZE,
              });
            } else {
              const wide = await engineGetRecordPage({ ...engineOpts, createdAtSort, limit: pgOffset + PAGE_SIZE });
              pageRows = wide.slice(pgOffset, pgOffset + PAGE_SIZE);
            }
          } else if (hasAnchor) {
            pageRows = await engineGetRecordPage({ ...engineOpts, beforeId: beforeIdExclusive, limit: PAGE_SIZE });
          } else {
            const wide = await engineGetRecordPage({ ...engineOpts, limit: pgOffset + PAGE_SIZE });
            pageRows = wide.slice(pgOffset, pgOffset + PAGE_SIZE);
          }
          if (loadVersionRef.current !== version) return;

          const ids = pageRows.map(r => r.id);
          const hydrated = (await bulkGetRecords(ids)).filter((r): r is DbRecord => !!r);
          if (loadVersionRef.current !== version) return;

          rawRecords = hydrated;
          setResultsTruncated(false);
          // Keyset boundary uses the engine page (authoritative ordering) so a
          // missing-from-Dexie row in `hydrated` can't break Next/Previous. The
          // date-added mode stores a (createdAt, id) cursor; id mode a plain id.
          if (dateAddedActive) {
            if (pageRows.length === PAGE_SIZE) {
              const last = pageRows[pageRows.length - 1];
              anchorState.anchors.set(currentPage + 1, {
                createdAt: last.createdAt ?? 0,
                id: last.id,
              });
            }
          } else {
            recordNextAnchor(pageRows as unknown as DbRecord[]);
          }

        } else if (dateAddedActive && !identifierSearch && !packagedProtected) {
          // Date Added sort / "Recently added" window, Dexie fallback (engine
          // not READY/CURRENT or query has residual filters): keyset-paginate on
          // the createdAt index (id tiebreak via index iteration order) with the
          // residual filterFn composing type/tags/search/tier-exclude. Counts
          // are deferred (capped early-stop walk) in runDeferredCounts.
          const direction = dateSort === 'oldest' ? 'oldest' : 'newest';
          let pageRows: DbRecord[];
          if (hasAnchor) {
            pageRows = await getRecordsPageByCreatedAtKeyset({
              limit: PAGE_SIZE,
              direction,
              addedSince: addedSince ?? undefined,
              cursor: createdAtCursor,
              filter: filterFn,
            });
          } else {
            // Rare non-adjacent jump (e.g. clamp after a count shrink): fetch a
            // wider window from the top and slice — bounded by the page number.
            const wide = await getRecordsPageByCreatedAtKeyset({
              limit: pgOffset + PAGE_SIZE,
              direction,
              addedSince: addedSince ?? undefined,
              filter: filterFn,
            });
            pageRows = wide.slice(pgOffset, pgOffset + PAGE_SIZE);
          }
          if (loadVersionRef.current !== version) return;

          rawRecords = pageRows;
          setResultsTruncated(false);
          if (pageRows.length === PAGE_SIZE) {
            const last = pageRows[pageRows.length - 1];
            if (typeof last.id === 'number') {
              anchorState.anchors.set(currentPage + 1, {
                createdAt: last.createdAt ?? 0,
                id: last.id,
              });
            }
          }

        } else if (!filtersActive && includeBlockchainDiscovered && !packagedProtected) {
          // Await only the lightweight page fetch (keyset when possible). Counts
          // deferred until after render (see runDeferredCounts).
          rawRecords = hasAnchor
            ? await getRecordsPageByIdReverseKeyset({ limit: PAGE_SIZE, beforeIdExclusive })
            : await getRecordsPageByIdReverse(pgOffset, PAGE_SIZE);

          if (loadVersionRef.current !== version) return;
          setResultsTruncated(false);
          recordNextAnchor(rawRecords);

        } else if (!filtersActive && !includeBlockchainDiscovered && !packagedProtected) {
          // Await only the page fetch (indexed tier queries, fast). Counts
          // deferred until after render (see runDeferredCounts).
          if (hasAnchor) {
            // Keyset: fetch up to PAGE_SIZE rows below the boundary from each
            // visible tier, then k-way merge to the global top PAGE_SIZE.
            const pageGroups = await Promise.all(dexieVisibleTiers.map(tier =>
              getAddressRecordsByImportanceTierPage(tier, { limit: PAGE_SIZE, beforeIdExclusive })
            ));
            if (loadVersionRef.current !== version) return;
            rawRecords = mergeTopRecordsById(pageGroups, PAGE_SIZE);
          } else {
            const pageGroups = await Promise.all(dexieVisibleTiers.map(tier =>
              getAddressRecordsByImportanceTierLimited(tier, pgOffset + PAGE_SIZE)
            ));
            if (loadVersionRef.current !== version) return;
            const merged = pageGroups.flat().sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
            rawRecords = merged.slice(pgOffset, pgOffset + PAGE_SIZE);
          }

          setResultsTruncated(false);
          recordNextAnchor(rawRecords);

        } else if (singleTypeFilter && !packagedProtected) {
          const typeVal = singleTypeFilter;

          // Await only the page fetch (keyset when possible). Counts deferred
          // until after render (see runDeferredCounts).
          if (includeBlockchainDiscovered) {
            rawRecords = hasAnchor
              ? await getRecordsPageByTypeIdReverseKeyset(typeVal, { limit: PAGE_SIZE, beforeIdExclusive })
              : await getRecordsPageByTypeIdReverse(typeVal, pgOffset, PAGE_SIZE);
          } else if (hasAnchor) {
            // Keyset: walk [type+id] id-desc from the boundary, keeping only the
            // visible tiers, until a full page is collected.
            rawRecords = await getRecordsPageByTypeAndImportanceTiersKeyset(
              typeVal,
              dexieVisibleTiers,
              { limit: PAGE_SIZE, beforeIdExclusive },
            );
          } else {
            const groups = await Promise.all(dexieVisibleTiers.map(tier =>
              getRecordsByTypeAndImportanceLimited(typeVal, tier, pgOffset + PAGE_SIZE)
            ));
            const merged = groups.flat().sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
            rawRecords = merged.slice(pgOffset, pgOffset + PAGE_SIZE);
          }

          if (loadVersionRef.current !== version) return;
          setResultsTruncated(false);
          recordNextAnchor(rawRecords);

        } else if (identifierSearch) {
          // Pasted full address/txid: indexed equality lookup on
          // inputStringLower (fast) instead of the residual substring scan.
          const built = buildIdentifierSearchCollection(
            identifierSearch,
            {
              search, columnFilters, includeBlockchainDiscovered, visibleTierValues: visibleTiers ?? undefined,
              addedSince: dateAddedActive ? addedSince ?? undefined : undefined,
              requireCreatedAt: dateAddedActive || undefined,
              order: dateAddedActive ? (dateSort === 'oldest' ? 'created-asc' : 'created-desc') : 'id-desc',
              beforeId: hasAnchor ? beforeIdExclusive : undefined,
            },
            filterFn,
          );
          const page = await fetchRecordsPage(
            built,
            pgOffset,
            PAGE_SIZE,
            () => loadVersionRef.current !== version,
          );
          if (page === null) return;
          if (loadVersionRef.current !== version) return;

          setTotalCount(page.total);
          setNavigableCount(page.effectiveTotal);
          setResultsTruncated(page.truncated);
          rawRecords = page.records;

        } else {
          const built = buildRecordsCollection(
            {
              search, columnFilters, includeBlockchainDiscovered, visibleTierValues: visibleTiers ?? undefined,
              addedSince: dateAddedActive ? addedSince ?? undefined : undefined,
              requireCreatedAt: dateAddedActive || undefined,
              order: dateAddedActive ? (dateSort === 'oldest' ? 'created-asc' : 'created-desc') : 'id-desc',
              beforeId: hasAnchor ? beforeIdExclusive : undefined,
            },
            filterFn,
          );
          const page = await fetchRecordsPage(
            built,
            pgOffset,
            PAGE_SIZE,
            () => loadVersionRef.current !== version,
          );
          if (page === null) return;
          if (loadVersionRef.current !== version) return;

          setTotalCount(page.total);
          setNavigableCount(page.effectiveTotal);
          setResultsTruncated(page.truncated);
          rawRecords = page.records;
        }
        if (loadVersionRef.current !== version) return;

        setPhase('Rendering');
        bus.publishTask({
          id: taskId,
          label: 'Loading Records',
          phase: 'Rendering',
          current: 2,
          total: 3,
        });
        
        const converted = rawRecords.map(convertRecord);
        setRecords(converted);
        console.log(`[Records] load v${version} rendered ${converted.length} rows +${Math.round(performance.now() - t0)}ms`);

        // Rows are on screen for the winning version — now kick off the counts.
        // Loads that got superseded before this point returned earlier and never
        // start counts, so superseded reloads add no DB pressure.
        // The protected DTO page is bounded and supplies its materialized
        // total. Do not start legacy Dexie count paths in packaged builds.
        if (!packagedProtected) runDeferredCounts();
        
        if (isTxidSearch) {
          try {
            const matchingTxs = await getTransactionsByTxidStartsWith(search, 50);
            if (loadVersionRef.current !== version) return;
            
            if (matchingTxs.length > 0) {
              const txids = matchingTxs.map(tx => tx.txid);
              setMatchingTxids(txids);
              
              const participants = await getParticipantsByTxids(txids);
              if (loadVersionRef.current !== version) return;
              
              const txResults = matchingTxs.map(tx => ({
                txid: tx.txid,
                blockHeight: tx.blockHeight,
                blockTime: tx.blockTime,
                participantAddresses: participants
                  .filter(p => p.txid === tx.txid)
                  .map(p => p.address),
              }));
              setTxidSearchResults(txResults);
              batchPreloadIdentifiers(txids);
              
              const participantAddresses = new Set(participants.map(p => p.address));
              const relatedRawRecords = await getRecordsByInputStrings(Array.from(participantAddresses));
              if (loadVersionRef.current !== version) return;
              
              const relatedConverted = relatedRawRecords.map(convertRecord);
              const existingIds = new Set(converted.map(r => r.id));
              const additional = relatedConverted.filter(r => !existingIds.has(r.id));
              if (additional.length > 0) {
                setRecords([...converted, ...additional]);
              }
            } else {
              setMatchingTxids([]);
              setTxidSearchResults([]);
            }
          } catch (error) {
            console.error('[Records] Error searching blockchain transactions:', error);
            setMatchingTxids([]);
            setTxidSearchResults([]);
          }
        } else {
          setMatchingTxids([]);
          setTxidSearchResults([]);
        }
      } catch (error) {
        console.error('[Records] Failed to load records:', error);
        if (loadVersionRef.current === version) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load records');
        }
      } finally {
        if (loadVersionRef.current !== version) {
          console.log(`[Records] load v${version} superseded by v${loadVersionRef.current} +${Math.round(performance.now() - t0)}ms`);
        }
        // Always remove this task from the activity bus — covers success,
        // cancellation (early return) and error paths.
        bus.completeTask(taskId);
        inFlightRef.current--;
        // Clear loading when this is the active version OR when no other load
        // is in flight (prevents the flag getting permanently stuck if a chain
        // of cancelled loads never produced a "winning" finally block).
        if (loadVersionRef.current === version || inFlightRef.current === 0) {
          setIsLoading(false);
        }
      }
    };
    
    loadRecords();
  }, [includeBlockchainDiscovered, dbChangeSignal, currentPage, debouncedSearch, columnFilters, retrySig, engineReadySignal, dateSort, addedSince]);

  // Behavior-filter changes don't reload the page (behavior narrows the loaded
  // page client-side), so they also can't ride the load effect's deferred
  // hidden-match count. Recompute it here instead: a behavior-only narrowing
  // over the default view must still surface "N matches are hidden among
  // blockchain-discovered records" instead of silently dead-ending. Bounded by
  // the same match/scan caps and guarded by both the load version and the
  // hidden-count run token so a superseding load or newer recount wins.
  const behaviorRecountMountedRef = useRef(false);
  useEffect(() => {
    if (!behaviorRecountMountedRef.current) {
      // Initial mount: the first load's own deferred count covers this state.
      behaviorRecountMountedRef.current = true;
      return;
    }
    const version = loadVersionRef.current;
    const runId = ++hiddenCountRunRef.current;
    const search = debouncedSearch.toLowerCase().trim();
    const narrowingActive =
      search !== '' || columnFilters.length > 0 || addedSince !== null || behaviorFilters.size > 0;
    if (!narrowingActive || includeBlockchainDiscovered) {
      setHiddenMatches(null);
      return;
    }
    const residualNoTier = buildResidualNoTier({ search, columnFilters, addedSince });
    countHiddenTierMatches({
      matches: (r) => residualNoTier(r) && matchesBehaviorFilters(r, behaviorFilters),
      identifier: looksLikeBitcoinIdentifier(search),
      isCancelled: () =>
        loadVersionRef.current !== version || hiddenCountRunRef.current !== runId,
    }).then((result) => {
      if (loadVersionRef.current !== version || hiddenCountRunRef.current !== runId) return;
      setHiddenMatches(result.count > 0 ? result : null);
    }).catch(e => { console.warn('[Records] Hidden-match recount failed:', e); });
    // Intentionally only behaviorFilters: every other input change triggers a
    // full load, whose own deferred count recomputes this with fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behaviorFilters]);

  // Watchdog: while a load is continuously in progress, tick an elapsed-seconds
  // counter. On very large vaults the first load after a big update can take a
  // while; this both reassures the user and surfaces timing they can screenshot
  // if something is genuinely stuck.
  useEffect(() => {
    if (!isLoading) {
      setLoadElapsedSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      setLoadElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isLoading]);

  const uniqueFilterValues = useMemo(() => {
    const clean = (names: string[]) => 
      names.filter(n => n && n.trim() && !n.includes('[encrypted]')).sort();
    return {
      owner: clean(vocabOwners.map(o => o.name)),
      walletName: clean(vocabWalletNames.map(w => w.name)),
      seedName: clean(vocabSeedNames.map(s => s.name)),
      walletSoftware: clean(vocabWalletSoftware.map(ws => ws.name)),
      tags: clean(vocabTags.map(t => t.name)),
      categories: clean(vocabCategories.map(c => c.name)),
    };
  }, [vocabTags, vocabCategories, vocabOwners, vocabWalletNames, vocabSeedNames, vocabWalletSoftware]);

  const [directLoadedRecord, setDirectLoadedRecord] = useState<ConvertedRecord | null>(null);
  const [syncRefreshedRecord, setSyncRefreshedRecord] = useState<ConvertedRecord | null>(null);
  
  useEffect(() => {
    if (!selectedRecordId || isLoading) return;
    
    const existingRecord = records.find(r => r.id === selectedRecordId);
    if (existingRecord) {
      setDirectLoadedRecord(null);
      return;
    }
    
    const loadRecord = async () => {
      try {
        const record = await getRecord(parseInt(selectedRecordId));
        if (!record) return;
        setDirectLoadedRecord(convertRecord(record));
      } catch (error) {
        console.error('[Records] Failed to load specific record:', error);
      }
    };
    
    loadRecord();
  }, [selectedRecordId, records, isLoading]);

  useEffect(() => {
    setSyncRefreshedRecord(null);
  }, [selectedRecordId]);

  const handleSyncComplete = useCallback(async () => {
    if (!selectedRecordId) return;
    try {
      const fresh = await getRecord(parseInt(selectedRecordId));
      if (fresh) setSyncRefreshedRecord(convertRecord(fresh));
    } catch (error) {
      console.error('[Records] Failed to refresh record after sync:', error);
    }
  }, [selectedRecordId]);
  
  const selectedRecord = selectedRecordId 
    ? (syncRefreshedRecord?.id === selectedRecordId
        ? syncRefreshedRecord
        : records.find(r => r.id === selectedRecordId) || directLoadedRecord)
    : null;

  useEffect(() => {
    const recordIds = new Set(records.map(r => r.id));
    setSelectedIds(prev => {
      const validSelected = new Set(Array.from(prev).filter(id => recordIds.has(id)));
      if (validSelected.size !== prev.size) {
        return validSelected;
      }
      return prev;
    });
  }, [records]);

  const displayTotalCount = totalCount;
  // Pagination math uses navigableCount (capped at MAX_MATERIALIZE for the
  // index-narrowed path) so the user can never page past the materialized
  // window. The full match count is still shown in the header.
  const displayTotalPages = Math.max(1, Math.ceil(navigableCount / PAGE_SIZE));
  const displayStartIndex = (currentPage - 1) * PAGE_SIZE;
  // Behavior filtering is purely client-side over the loaded page, derived from
  // the cached on-chain stats already on each record (same fields RecordTable
  // uses for its behavior badge). No DB scan, so it never touches the load path.
  const behaviorFilterActive = behaviorFilters.size > 0;
  const displayRecords = useMemo(() => {
    if (!behaviorFilterActive) return records;
    return records.filter((r) => {
      if (r.type !== 'address') return false;
      return behaviorFilters.has(behaviorLabelFromCachedStats(r));
    });
  }, [records, behaviorFilters, behaviorFilterActive]);

  // "N matches hidden among discovered records" hint. Rendered in the empty
  // state AND under non-empty results, so a search whose only (or extra)
  // matches carry a hidden discovery tier — e.g. a synced counterparty row the
  // user tagged long ago — is never a silent dead end. One click flips the
  // discovered-records toggle, which reloads with those rows included.
  const hiddenMatchesNotice =
    !includeBlockchainDiscovered && hiddenMatches && hiddenMatches.count > 0 ? (
      <div
        className="mt-3 flex flex-col items-center gap-2 text-sm text-muted-foreground"
        data-testid="notice-hidden-matches"
      >
        <span>
          {hiddenMatches.capped
            ? `${hiddenMatches.count.toLocaleString()}+`
            : hiddenMatches.count.toLocaleString()}
          {hiddenMatches.count === 1 && !hiddenMatches.capped ? " match is" : " matches are"} hidden
          among blockchain-discovered records
          {hiddenMatches.scanCapped ? " (at least — large discovered set, partially checked)" : ""}.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIncludeBlockchainDiscovered(true)}
          data-testid="button-show-hidden-matches"
        >
          Show hidden matches
        </Button>
      </div>
    ) : null;

  useEffect(() => {
    if (currentPage > displayTotalPages && displayTotalPages > 0) {
      setCurrentPage(displayTotalPages);
    }
  }, [currentPage, displayTotalPages]);

  const handleSingleDelete = async () => {
    if (!singleDeleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteRecord(parseInt(singleDeleteTarget));
      toast({
        title: "Record deleted",
        description: "The record has been permanently deleted.",
      });
      setSingleDeleteTarget(null);
      if (selectedRecordId === singleDeleteTarget) {
        setSelectedRecordId(null);
      }
    } catch (error) {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Failed to delete record",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Chunk size for the batched delete phase below. Mirrors Dashboard.tsx's
  // BULK_DELETE_WRITE_CHUNK_SIZE (Task #2130): large enough to collapse
  // per-record IndexedDB round-trips into a handful of transactions (a
  // "select all" on the Records page can select thousands of rows), small
  // enough that a single bad chunk falling back to the slow per-record path
  // stays bounded.
  const BULK_DELETE_WRITE_CHUNK_SIZE = 1000;

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    const idsToDelete = Array.from(selectedIds).map(id => parseInt(id));
    let successCount = 0;
    let failCount = 0;

    beginBulkOperation();
    try {
      for (let start = 0; start < idsToDelete.length; start += BULK_DELETE_WRITE_CHUNK_SIZE) {
        const chunk = idsToDelete.slice(start, start + BULK_DELETE_WRITE_CHUNK_SIZE);
        try {
          await bulkDeleteRecordsWithArchiving(chunk);
          successCount += chunk.length;
        } catch (error) {
          // The whole chunk failed to write — fall back to the original
          // per-record path (which still does the attachment-archiving
          // cascade) for just this chunk so a single bad row can't sink the
          // rest of the selection.
          console.error("Bulk delete chunk failed, falling back to per-record deletes:", error);
          for (const id of chunk) {
            try {
              await deleteRecord(id);
              successCount++;
            } catch {
              failCount++;
            }
          }
        }
      }
    } finally {
      endBulkOperation();
    }

    if (failCount === 0) {
      toast({
        title: "Records deleted",
        description: `Successfully deleted ${successCount} record${successCount !== 1 ? 's' : ''}.`,
      });
    } else {
      toast({
        title: "Partial deletion",
        description: `Deleted ${successCount} record${successCount !== 1 ? 's' : ''}, but ${failCount} failed.`,
        variant: "destructive",
      });
    }

    setSelectedIds(new Set());
    setBulkDeleteDialogOpen(false);
    setIsDeleting(false);
  };

  const handleRecomputeSelection = async () => {
    if (selectedIds.size === 0) return;
    setIsRecomputingSelection(true);
    try {
      const recordIds = Array.from(selectedIds)
        .map(id => parseInt(id))
        .filter(n => !Number.isNaN(n));
      const result = await recomputeAddressStats({ recordIds, origin: "user" });
      toast({
        title: "Stats Recomputed",
        description: `Updated cached stats for ${result.updated.toLocaleString()} address${result.updated !== 1 ? "es" : ""}.`,
      });
    } catch (error) {
      toast({
        title: "Recompute failed",
        description: error instanceof Error ? error.message : "Failed to recompute stats",
        variant: "destructive",
      });
    } finally {
      setIsRecomputingSelection(false);
    }
  };

  const handleDeleteRequest = (id: string) => {
    setSingleDeleteTarget(id);
  };

  if (selectedRecordId && selectedRecord && !searchQuery) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate("/records")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">
                Record Details
              </h1>
              <p className="text-muted-foreground">
                View and edit metadata
              </p>
            </div>
          </div>

          <RecordDetailPanel
            open={true}
            record={selectedRecord}
            onClose={() => navigate("/records")}
            onEdit={selectedRecord ? () => void openRecordAnnotation(Number(selectedRecord.id)) : undefined}
            onAnnotate={selectedRecord ? () => void openRecordAnnotation(Number(selectedRecord.id)) : undefined}
            onSyncComplete={handleSyncComplete}
            customFieldDefs={customFieldDefs}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => navigate("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Records
            </h1>
            <p className="text-muted-foreground">
              View and manage your Bitcoin metadata records
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="search" className="text-sm font-medium">
                Search Records
              </label>
              <div className="mt-2 relative">
                {isSearchPending ? (
                  <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
                ) : (
                  <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                )}
                <Input
                  id="search"
                  placeholder="Search by label, address/txid, owner, wallet, notes, tags, or categories..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>
            <div className="pt-6">
              <BlockchainToggle
                checked={includeBlockchainDiscovered}
                onCheckedChange={setIncludeBlockchainDiscovered}
                hiddenCount={totalBlockchainDiscovered}
              />
            </div>
          </div>

          <ActiveFiltersBar
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            filters={columnFilters}
            onFiltersChange={setColumnFilters}
            extraActiveCount={(dateAddedActive ? 1 : 0) + behaviorFilters.size}
            onClearExtra={() => {
              setDateSort('default');
              setAddedSince(null);
              setBehaviorFilters(new Set());
            }}
          />

          <RecordFilters
            filters={columnFilters}
            onFiltersChange={setColumnFilters}
            uniqueValues={uniqueFilterValues}
          />

          <DateAddedFilter
            sort={dateSort}
            onSortChange={setDateSort}
            since={addedSince}
            onSinceChange={setAddedSince}
          />

          <BehaviorFilter
            selected={behaviorFilters}
            onChange={setBehaviorFilters}
            counts={behaviorCounts}
            countsComputing={behaviorCountsComputing}
            countsProgress={behaviorCountsProgress}
            onCancelCounts={cancelBehaviorCounts}
            onRestartCounts={restartBehaviorCounts}
          />
        </div>

        <div className={`space-y-6 ${searchPendingClass(isSearchPending, 'Records')}`}>
        {txidSearchResults.length > 0 && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Hash className="h-4 w-4" />
                Blockchain Transactions Found ({txidSearchResults.length})
              </CardTitle>
              <CardDescription>
                Synced transactions matching your search. Click to view on Transactions page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {txidSearchResults.map((tx) => (
                <div 
                  key={tx.txid}
                  className="p-3 rounded-lg bg-background border hover-elevate cursor-pointer"
                  onClick={() => navigate(`/transactions?search=${tx.txid}`)}
                  data-testid={`tx-result-${tx.txid.slice(0, 8)}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                      <TxidLink
                        txid={tx.txid}
                        showExternalLink={true}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        Block {tx.blockHeight.toLocaleString()}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(tx.blockTime * 1000).toLocaleDateString()} - {tx.participantAddresses.length} addresses involved
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted border">
            <div className="flex items-center gap-3">
              <Badge variant="secondary" className="text-sm">
                {selectedIds.size} selected
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRecomputeSelection}
                disabled={isRecomputingSelection}
                data-testid="button-recompute-selection"
              >
                {isRecomputingSelection ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                Recompute Stats
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteDialogOpen(true)}
                data-testid="button-bulk-delete"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Delete Selected
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span data-testid="text-records-title">
                    {(() => {
                      const countLabel = countLoading
                        ? '?'
                        : (resultsTruncated ? `${totalCount.toLocaleString()}+` : totalCount.toLocaleString());
                      if (searchQuery) {
                        if (txidSearchResults.length > 0) {
                          return `Related Address Records (${records.length})`;
                        }
                        return `Search Results (${countLabel})`;
                      }
                      return `All Records (${countLabel})`;
                    })()}
                  </span>
                  {(isLoading || countLoading) && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      data-testid="spinner-records-title"
                    />
                  )}
                </CardTitle>
                <CardDescription>
                  {txidSearchResults.length > 0 
                    ? "Addresses involved in the matching transactions"
                    : "Click on a record to view or edit details"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="text-center py-8 text-muted-foreground" data-testid="text-records-loading">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                    <span data-testid="text-records-loading-phase">
                      {loadPhase ? `${loadPhase}…` : 'Loading records…'}
                    </span>
                    {loadElapsedSec >= 15 && (
                      <p className="text-xs mt-2" data-testid="text-records-loading-elapsed">
                        Working through a large vault — {loadElapsedSec}s elapsed. The first load after a big update can take a little while.
                      </p>
                    )}
                  </div>
                ) : loadError ? (
                  <div className="text-center py-8" data-testid="text-records-load-error">
                    <AlertCircle className="h-6 w-6 text-destructive mx-auto mb-2" />
                    <p className="text-destructive font-medium mb-1">Failed to load records</p>
                    <p className="text-sm text-muted-foreground mb-4">{loadError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={retryLoad}
                      data-testid="button-retry-load-records"
                    >
                      Retry
                    </Button>
                  </div>
                ) : displayRecords.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground" data-testid="text-records-empty">
                    {behaviorFilterActive && records.length > 0
                      ? "No records on this page match the selected behavior labels. Try another page, or adjust the behavior filter."
                      : searchQuery
                      ? txidSearchResults.length > 0
                        ? "No address records found for this transaction. Addresses may not have been synced yet."
                        : "No records match your search"
                      : "No records found"}
                    {hiddenMatchesNotice}
                  </div>
                ) : (
                  <>
                    <RecordTable 
                      records={displayRecords}
                      showAddedColumn={dateAddedActive}
                      // RecordTable ids are numeric while the route/detail
                      // state deliberately uses a string (it is also fed by
                      // URL parameters). Normalize at this boundary so a
                      // click can actually resolve the selected record.
                      onRowClick={(id) => setSelectedRecordId(String(id))}
                      onDelete={handleDeleteRequest}
                      selectionEnabled={true}
                      selectedIds={selectedIds}
                      onSelectionChange={setSelectedIds}
                    />

                    {behaviorFilterActive && (
                      <div
                        className="text-sm text-muted-foreground border-t pt-4 mt-4"
                        data-testid="text-behavior-filter-notice"
                      >
                        Behavior filters apply to the {records.length.toLocaleString()} record{records.length !== 1 ? 's' : ''} loaded on this page
                        ({displayRecords.length.toLocaleString()} match). Use the search or filters above to narrow the full set first.
                      </div>
                    )}
                    
                    {resultsTruncated && (
                      <div
                        className="text-sm text-muted-foreground border-t pt-4 mt-4"
                        data-testid="text-results-truncated-notice"
                      >
                        Showing the first {navigableCount.toLocaleString()}+ matches in index order.
                        Add more filters or refine your search to see exact counts and the full set.
                      </div>
                    )}
                    {hiddenMatchesNotice && (
                      <div className="border-t pt-4 mt-4">{hiddenMatchesNotice}</div>
                    )}
                    {displayTotalPages > 1 && (
                      <div className="flex items-center justify-between border-t pt-4 mt-4">
                        <div className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                          Showing {displayStartIndex + 1}-{Math.min(displayStartIndex + displayRecords.length, navigableCount)} of {resultsTruncated ? `${navigableCount.toLocaleString()}+` : displayTotalCount.toLocaleString()} records
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            data-testid="button-prev-page"
                          >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            Previous
                          </Button>
                          <span className="text-sm px-2" data-testid="text-page-indicator">
                            Page {currentPage} of {displayTotalPages}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.min(displayTotalPages, p + 1))}
                            disabled={currentPage === displayTotalPages}
                            data-testid="button-next-page"
                          >
                            Next
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {selectedRecord && (
            <div className="lg:col-span-1">
              <RecordDetailPanel
                open={true}
                record={selectedRecord}
                onClose={() => setSelectedRecordId(null)}
                onEdit={selectedRecord ? () => void openRecordAnnotation(Number(selectedRecord.id)) : undefined}
                onAnnotate={selectedRecord ? () => void openRecordAnnotation(Number(selectedRecord.id)) : undefined}
                onSyncComplete={handleSyncComplete}
                customFieldDefs={customFieldDefs}
              />
            </div>
          )}
        </div>
        </div>
      </div>

      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Record{selectedIds.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the selected record{selectedIds.size !== 1 ? 's' : ''} and all associated attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} data-testid="button-cancel-bulk-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-bulk-delete"
            >
              {isDeleting ? "Deleting..." : `Delete ${selectedIds.size} Record${selectedIds.size !== 1 ? 's' : ''}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!singleDeleteTarget} onOpenChange={(open) => !open && setSingleDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this record and all associated attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} data-testid="button-cancel-single-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSingleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-single-delete"
            >
              {isDeleting ? "Deleting..." : "Delete Record"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
