import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  type Settings,
  type CustomField,
} from '@/lib/database';
import { normalizeDesktopLockSettings } from '@/lib/desktop-lock-settings';
import {
  getSettings as getStoredSettings,
  updateSettings as updateStoredSettings,
  ensureSettings as ensureStoredSettings,
} from '@/lib/data/settings-crud';
import {
  addCustomField as addStoredCustomField,
  updateCustomField as updateStoredCustomField,
  deleteCustomField as deleteStoredCustomField,
  getCustomField as getStoredCustomField,
  getCustomFieldBySlug,
  getAllCustomFields,
} from '@/lib/data/custom-fields-crud';

const defaultTableColumns = {
  tags: true,
  categories: false,
  walletSoftware: false,
  seedName: false,
  privateKeyStatus: false,
  hasAttachments: true,
  owner: false,
  walletName: false,
  source: false,
  firstSeen: false,
  balance: false,
  lastTxDate: false,
  txCount: false,
};

const defaultFieldVisibility = {
  seedName: true,
  walletSoftware: true,
  privateKeyStatus: false,
  owner: true,
  walletName: true,
  source: true,
};

import { DEFAULT_CANCEL_CONFIRM_THRESHOLD } from '@/lib/buildProgress';
import {
  DEFAULT_PRIVACY_HISTORY_LIMIT,
  trimPrivacyAuditHistory,
} from '@/lib/data/privacy-history-crud';
import { DEFAULT_TX_LIMIT } from '@/lib/data/fund-trail-engine';
import { DEFAULT_INTERMEDIARY_ADDRESS_CAP } from '@/lib/data/fund-trail-export';
import { DEFAULT_HOVER_TOOLTIP_PREFS, type HoverTooltipPrefs } from '@/lib/metadata-hover';
import type { FundTrailLayout } from '@/components/fund-trail/view-data';
import {
  DEFAULT_QUANTUM_TAG_LEVELS,
  QUANTUM_RISK_LEVEL_ORDER,
  sanitizeQuantumTagLevels,
  type QuantumRiskLevel,
} from '@/lib/quantum-risk';

export function useSettings() {
  // Wrap the query so undefined (not found) becomes null, keeping the dexie-
  // react-hooks undefined sentinel meaning "still loading" — otherwise a
  // missing settings row looks indistinguishable from a loading state and the
  // component stays in the loading spinner forever.
  const settings = useLiveQuery(async () => {
    const s = await getStoredSettings('default');
    return s ?? null;
  });
  
  return {
    settings: settings ?? null,
    tableColumns: settings?.tableColumns || defaultTableColumns,
    customFieldColumns: settings?.customFieldColumns || {},
    fieldVisibility: settings?.fieldVisibility || defaultFieldVisibility,
    cancelConfirmThreshold: settings?.cancelConfirmThreshold ?? DEFAULT_CANCEL_CONFIRM_THRESHOLD,
    privacyHistoryLimit: settings?.privacyHistoryLimit ?? DEFAULT_PRIVACY_HISTORY_LIMIT,
    peelChainViewMode: settings?.peelChainViewMode ?? 'graph',
    showScoreBreakdown: settings?.showScoreBreakdown ?? false,
    disableOrphanCheck: settings?.disableOrphanCheck ?? false,
    fundTrailTxLimit: settings?.fundTrailTxLimit ?? DEFAULT_TX_LIMIT,
    fundTrailLayout: (settings?.fundTrailLayout ?? 'classic') as FundTrailLayout,
    sourceOfFundsTxLimit: settings?.sourceOfFundsTxLimit ?? DEFAULT_TX_LIMIT,
    intermediaryAddressCap: settings?.intermediaryAddressCap ?? DEFAULT_INTERMEDIARY_ADDRESS_CAP,
    hoverTooltipPrefs: settings?.hoverTooltipPrefs
      ? { ...DEFAULT_HOVER_TOOLTIP_PREFS, ...settings.hoverTooltipPrefs }
      : DEFAULT_HOVER_TOOLTIP_PREFS,
    // Unset (older vaults) falls back to the default; a stored empty array is a
    // deliberate "analysis only" choice and is preserved as-is.
    quantumTagLevels:
      sanitizeQuantumTagLevels(settings?.quantumTagLevels) ?? DEFAULT_QUANTUM_TAG_LEVELS,
    desktopLockSettings: normalizeDesktopLockSettings(settings?.desktopLockSettings),
    isLoading: settings === undefined,
  };
}

// Serialize toggle writes so two rapid checkbox flips can't both compute from
// the same stale stored row (the second would silently resurrect the level the
// first just removed). Each caller still gets its own rejection so the UI can
// surface a failed save.
let quantumTagLevelsQueue: Promise<unknown> = Promise.resolve();

export function toggleQuantumTagLevel(
  level: QuantumRiskLevel,
  enabled: boolean
): Promise<void> {
  const run = quantumTagLevelsQueue
    .catch(() => {})
    .then(async () => {
      await ensureStoredSettings('default');
      const stored = await getStoredSettings('default');
      // Unset (older vaults) starts from the default; a stored empty array is
      // a deliberate "analysis only" choice and stays the base.
      const base =
        sanitizeQuantumTagLevels(stored?.quantumTagLevels) ?? DEFAULT_QUANTUM_TAG_LEVELS;
      const next = new Set(base);
      if (enabled) next.add(level);
      else next.delete(level);
      await updateStoredSettings('default', {
        quantumTagLevels: QUANTUM_RISK_LEVEL_ORDER.filter((l) => next.has(l)),
      });
    });
  quantumTagLevelsQueue = run;
  return run;
}

export async function updateHoverTooltipPrefs(
  changes: Partial<HoverTooltipPrefs>
): Promise<void> {
  const settings = await ensureStoredSettings('default');
  const current = settings.hoverTooltipPrefs
    ? { ...DEFAULT_HOVER_TOOLTIP_PREFS, ...settings.hoverTooltipPrefs }
    : { ...DEFAULT_HOVER_TOOLTIP_PREFS };
  await updateStoredSettings('default', {
    hoverTooltipPrefs: { ...current, ...changes },
  });
}

export function useCustomFields() {
  const customFields = useLiveQuery(() => getAllCustomFields());
  
  return {
    customFields: customFields || [],
    enabledCustomFields: (customFields || []).filter(f => f.enabled),
    isLoading: customFields === undefined,
  };
}

export async function updateFieldVisibility(fields: Partial<Settings['fieldVisibility']>) {
  const settings = await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    fieldVisibility: {
      ...settings.fieldVisibility,
      ...fields,
    },
  });
}

export async function toggleFieldVisibility(field: keyof Settings['fieldVisibility']) {
  const settings = await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    fieldVisibility: {
      ...settings.fieldVisibility,
      [field]: !settings.fieldVisibility[field],
    },
  });
}

export async function updateTableColumns(columns: Partial<Settings['tableColumns']>) {
  const settings = await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    tableColumns: {
      ...settings.tableColumns,
      ...columns,
    },
  });
}

export async function toggleTableColumn(column: keyof Settings['tableColumns']) {
  const settings = await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    tableColumns: {
      ...settings.tableColumns,
      [column]: !settings.tableColumns[column],
    },
  });
}

export async function updateCancelConfirmThreshold(value: number) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    cancelConfirmThreshold: value,
  });
}

export async function updatePrivacyHistoryLimit(value: number): Promise<number> {
  const settings = await getStoredSettings('default');
  if (!settings) {
    // No 'default' settings row means updateStoredSettings would be a silent
    // no-op: the limit wouldn't persist and no runs would be trimmed. Throw so
    // callers warn the user instead of falsely reporting success (or nothing).
    throw new Error('Cannot save retention limit: settings are unavailable');
  }
  // Persist the new limit and trim older runs in a single atomic transaction.
  // The SettingsPage error toast tells the user the update "failed" when this
  // rejects, so the persisted state must match that promise: if the trim throws
  // the limit write is rolled back too, never leaving the limit saved while the
  // on-disk history stays oversized (or vice-versa). Either both apply or
  // neither does.
  return await db.transaction(
    'rw',
    db.settings,
    db.privacyAuditHistory,
    async () => {
      await updateStoredSettings('default', {
        privacyHistoryLimit: value,
      });
      // Immediately remove any runs beyond the new limit (oldest first) so
      // lowering the limit takes effect right away rather than on next audit.
      return await trimPrivacyAuditHistory(value);
    }
  );
}

export async function updatePeelChainViewMode(mode: 'graph' | 'list') {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    peelChainViewMode: mode,
  });
}

export async function updateShowScoreBreakdown(value: boolean) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    showScoreBreakdown: value,
  });
}

export async function updateDisableOrphanCheck(value: boolean) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    disableOrphanCheck: value,
  });
}

export async function updateFundTrailTxLimit(value: number) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    fundTrailTxLimit: value,
  });
}

export async function updateFundTrailLayout(value: FundTrailLayout) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    fundTrailLayout: value,
  });
}

export async function updateSourceOfFundsTxLimit(value: number) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    sourceOfFundsTxLimit: value,
  });
}

export async function updateIntermediaryAddressCap(value: number) {
  await ensureStoredSettings('default');
  await updateStoredSettings('default', {
    intermediaryAddressCap: value,
  });
}

export async function toggleCustomFieldColumn(slug: string) {
  const settings = await ensureStoredSettings('default');
  const currentColumns = settings.customFieldColumns || {};
  await updateStoredSettings('default', {
    customFieldColumns: {
      ...currentColumns,
      [slug]: !currentColumns[slug],
    },
  });
}

// Generate slug from field name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Custom field CRUD operations
export async function addCustomField(name: string): Promise<number | undefined> {
  const slug = generateSlug(name);
  
  // Check for duplicate slug
  const existing = await getCustomFieldBySlug(slug);
  if (existing) {
    throw new Error(`A field with this name already exists`);
  }
  
  return addStoredCustomField({
    name,
    slug,
    enabled: true,
  });
}

export async function updateCustomField(id: number, updates: Partial<Pick<CustomField, 'name' | 'enabled'>>) {
  const field = await getStoredCustomField(id);
  if (!field) throw new Error(`Custom field ${id} not found`);
  
  const updateData: Partial<CustomField> = {};
  
  if (updates.name !== undefined && updates.name !== field.name) {
    const newSlug = generateSlug(updates.name);
    // Check for duplicate slug (excluding current field)
    const existing = await getCustomFieldBySlug(newSlug);
    if (existing && existing.id !== id) {
      throw new Error(`A field with this name already exists`);
    }
    updateData.name = updates.name;
    updateData.slug = newSlug;
  }
  
  if (updates.enabled !== undefined) {
    updateData.enabled = updates.enabled;
  }
  
  if (Object.keys(updateData).length > 0) {
    await updateStoredCustomField(id, updateData);
  }
}

export async function toggleCustomField(id: number) {
  const field = await getStoredCustomField(id);
  if (!field) throw new Error(`Custom field ${id} not found`);
  await updateStoredCustomField(id, { enabled: !field.enabled });
}

export async function deleteCustomField(id: number) {
  await deleteStoredCustomField(id);
}
