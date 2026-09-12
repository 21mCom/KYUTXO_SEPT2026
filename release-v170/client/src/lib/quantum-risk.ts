// Shared vocabulary for the Quantum Risk Scanner's "which risk levels get
// tagged" preference (Settings.quantumTagLevels).
//
// The scanner classifies EVERY address record on each run, but only writes a
// `quantum:*` tag for records whose risk level is in the persisted selection.
// The preference is portable (it rides in backups via the PORTABLE_PREFERENCES
// descriptor list in backup/inline-tables.ts), so the validation helper here is
// shared by the settings hook, the scanner page, and the backup preview/restore
// path — a value the backup path would carry is exactly a value the UI accepts.

import type { Settings } from '@/lib/db-types';

// Type-checked extract from the Settings interface so this module can never
// drift from the persisted field's type.
export type QuantumRiskLevel = NonNullable<Settings['quantumTagLevels']>[number];

// Canonical severity rank (most to least severe). The Record keys keep this
// exhaustive: adding a level to Settings['quantumTagLevels'] without ranking it
// here fails to type-check.
const QUANTUM_RISK_LEVEL_RANK: Record<QuantumRiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  variable: 3,
  low: 4,
};

export const QUANTUM_RISK_LEVEL_ORDER: QuantumRiskLevel[] = (
  Object.keys(QUANTUM_RISK_LEVEL_RANK) as QuantumRiskLevel[]
).sort((a, b) => QUANTUM_RISK_LEVEL_RANK[a] - QUANTUM_RISK_LEVEL_RANK[b]);

export const QUANTUM_RISK_LEVEL_LABELS: Record<QuantumRiskLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  variable: 'Variable',
  low: 'Low',
};

// Default selection when the preference is unset (older vaults): tag only the
// levels worth acting on so vaults aren't flooded with medium/low tags.
export const DEFAULT_QUANTUM_TAG_LEVELS: QuantumRiskLevel[] = ['critical', 'high'];

/**
 * Validate an untrusted `quantumTagLevels` value (backup row, hand-edited
 * settings). Returns the selection normalized to canonical severity order with
 * duplicates collapsed, or `undefined` when the value is not an array made up
 * solely of recognized risk levels — callers then keep the current/default
 * selection. An empty array is VALID and meaningful: it persists "analysis
 * only, tag nothing".
 */
export function sanitizeQuantumTagLevels(
  value: unknown
): QuantumRiskLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<QuantumRiskLevel>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !Object.prototype.hasOwnProperty.call(QUANTUM_RISK_LEVEL_RANK, entry)
    ) {
      return undefined;
    }
    seen.add(entry as QuantumRiskLevel);
  }
  return QUANTUM_RISK_LEVEL_ORDER.filter((level) => seen.has(level));
}

// Human-readable rendering of a selection (used by the backup preview).
export function formatQuantumTagLevels(levels: QuantumRiskLevel[]): string {
  if (levels.length === 0) return 'None (analysis only)';
  return levels.map((level) => QUANTUM_RISK_LEVEL_LABELS[level]).join(' + ');
}
