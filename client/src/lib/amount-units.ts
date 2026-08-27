// Shared BTC/sats display-unit helpers for pages that let the user toggle how
// amount and dust-threshold inputs are entered/displayed (DustedPage,
// AddressPoisoning, DormantCoins, BalanceOverview, UTXOs). There is no global
// display-unit preference in Settings (each page keeps its own local,
// non-persisted unit toggle) — these helpers just keep the conversion/format
// logic identical everywhere it's used.

export type AmountUnit = "btc" | "sats";

const SATS_PER_BTC = 100_000_000;

/** Format a sats integer for editing in a plain-number <Input> under the given unit. */
export function satsToUnitInput(sats: number, unit: AmountUnit): string {
  if (!Number.isFinite(sats)) return "";
  if (unit === "sats") return String(Math.round(sats));
  return (sats / SATS_PER_BTC).toFixed(8);
}

/**
 * Parse a raw <Input> string (interpreted under the given unit) back to a
 * whole-sats integer. Returns null when the input isn't a valid non-negative
 * number (callers should treat null as "invalid, don't apply").
 */
export function unitInputToSats(raw: string, unit: AmountUnit): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return unit === "sats" ? Math.round(n) : Math.round(n * SATS_PER_BTC);
}

/** Short unit suffix/label used in inline buttons and chip text ("sats" / "BTC"). */
export function unitLabel(unit: AmountUnit): string {
  return unit === "sats" ? "sats" : "BTC";
}

/** Human-readable amount + unit, e.g. "1,000 sats" or "0.00001000 BTC". */
export function formatSatsWithUnit(sats: number, unit: AmountUnit): string {
  if (unit === "sats") return `${Math.round(sats).toLocaleString()} sats`;
  return `${(sats / SATS_PER_BTC).toFixed(8)} BTC`;
}
