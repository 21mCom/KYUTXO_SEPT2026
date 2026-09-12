// Shared validation for manually-entered Bitcoin block data.
//
// Every UI surface that accepts a manually-typed block hash or block height
// (Proof of Funds freshness anchor, any future sync/anchor or node-config
// inputs) must validate through these helpers so the rules never drift.
//
// Rules:
// - Block hash: exactly 64 lowercase hex characters ([0-9a-f]{64}).
//   Uppercase is rejected on purpose — all providers return lowercase, and
//   accepting mixed case would let visually-identical-but-different strings
//   into reports and exports.
// - Block height: a positive whole number (integer > 0).

const BLOCK_HASH_RE = /^[0-9a-f]{64}$/;

export function isValidBlockHash(hash: string): boolean {
  return BLOCK_HASH_RE.test(hash.trim());
}

export function isValidBlockHeight(height: string | number): boolean {
  if (typeof height === "number") {
    return Number.isInteger(height) && height > 0;
  }
  const raw = height.trim();
  return /^\d+$/.test(raw) && parseInt(raw, 10) > 0;
}

// Inline-error helpers: return null when the input is empty (untouched) or
// valid, otherwise a user-facing message.
export function blockHashInputError(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (!BLOCK_HASH_RE.test(raw)) {
    return "Block hash must be exactly 64 lowercase hex characters.";
  }
  return null;
}

export function blockHeightInputError(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return "Height must be a whole number.";
  if (parseInt(raw, 10) <= 0) return "Height must be greater than zero.";
  return null;
}
