// Shared block hash/height validators — used by every manual block-data
// input surface (Proof of Funds freshness anchor and any future ones).
// Rules: hash = exactly 64 lowercase hex chars; height = positive integer.
import { describe, it, expect } from "vitest";
import {
  isValidBlockHash,
  isValidBlockHeight,
  blockHashInputError,
  blockHeightInputError,
} from "./block-validation";

const VALID_HASH =
  "00000000000000000002bf1c330853db920e6099e59f4a7d4c9b8a1e2c5f7d31";

describe("isValidBlockHash", () => {
  it("accepts a 64-char lowercase hex hash (with surrounding whitespace)", () => {
    expect(isValidBlockHash(VALID_HASH)).toBe(true);
    expect(isValidBlockHash(`  ${VALID_HASH}  `)).toBe(true);
  });

  it("rejects uppercase, wrong length, non-hex, and empty input", () => {
    expect(isValidBlockHash(VALID_HASH.toUpperCase())).toBe(false);
    expect(isValidBlockHash(VALID_HASH.slice(0, 63))).toBe(false);
    expect(isValidBlockHash(VALID_HASH + "0")).toBe(false);
    expect(isValidBlockHash("z".repeat(64))).toBe(false);
    expect(isValidBlockHash("")).toBe(false);
  });
});

describe("isValidBlockHeight", () => {
  it("accepts positive integers as string or number", () => {
    expect(isValidBlockHeight("840000")).toBe(true);
    expect(isValidBlockHeight(" 1 ")).toBe(true);
    expect(isValidBlockHeight(840000)).toBe(true);
  });

  it("rejects zero, negatives, decimals, non-numeric, and empty input", () => {
    expect(isValidBlockHeight("0")).toBe(false);
    expect(isValidBlockHeight("-5")).toBe(false);
    expect(isValidBlockHeight("1.5")).toBe(false);
    expect(isValidBlockHeight("abc")).toBe(false);
    expect(isValidBlockHeight("")).toBe(false);
    expect(isValidBlockHeight(0)).toBe(false);
    expect(isValidBlockHeight(1.5)).toBe(false);
    expect(isValidBlockHeight(-1)).toBe(false);
  });
});

describe("inline error helpers", () => {
  it("return null for empty (untouched) and valid input", () => {
    expect(blockHashInputError("")).toBeNull();
    expect(blockHashInputError(VALID_HASH)).toBeNull();
    expect(blockHeightInputError("")).toBeNull();
    expect(blockHeightInputError("840000")).toBeNull();
  });

  it("return user-facing messages for invalid input", () => {
    expect(blockHashInputError(VALID_HASH.toUpperCase())).toMatch(
      /64 lowercase hex/,
    );
    expect(blockHeightInputError("abc")).toMatch(/whole number/);
    expect(blockHeightInputError("0")).toMatch(/greater than zero/);
  });
});
