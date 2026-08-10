// Regression coverage for the shared Unix-seconds rendering helpers.
// Stored blockchain timestamps (blockTime, CustodySegment.originDate) are
// Unix SECONDS; feeding them raw into new Date()/date-fns renders Jan 1970.
// The reverse mistake — feeding Date.now() milliseconds into a seconds-based
// formatter — renders dates millennia in the future (this bit the Proof of
// Funds offline "last synced" label via statsComputedAt).
import { describe, it, expect } from "vitest";
import { format } from "date-fns";
import {
  unixSecondsToDate,
  formatUnixSeconds,
  msToUnixSeconds,
} from "./unix-seconds";

// 2025-01-25T14:30:00Z — mid-day UTC so date-only assertions are tz-stable.
const SECONDS_2025 = 1_737_815_400;

describe("unixSecondsToDate", () => {
  it("converts a stored Unix-seconds value to the real calendar date, not 1970", () => {
    const d = unixSecondsToDate(SECONDS_2025);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(SECONDS_2025 * 1000);
    expect(d!.getUTCFullYear()).toBe(2025);
  });

  it("returns null (never the epoch) for 0, undefined, null, and non-finite values", () => {
    expect(unixSecondsToDate(0)).toBeNull();
    expect(unixSecondsToDate(undefined)).toBeNull();
    expect(unixSecondsToDate(null)).toBeNull();
    expect(unixSecondsToDate(NaN)).toBeNull();
    expect(unixSecondsToDate(-1)).toBeNull();
  });
});

describe("formatUnixSeconds", () => {
  it("formats a seconds value using the given date-fns pattern", () => {
    expect(formatUnixSeconds(SECONDS_2025, "MMM d, yyyy")).toBe(
      format(new Date(SECONDS_2025 * 1000), "MMM d, yyyy"),
    );
    // Guard against the original bug: the formatted year must not be 1970.
    expect(formatUnixSeconds(SECONDS_2025, "yyyy")).not.toBe("1970");
  });

  it("renders the fallback for missing block times", () => {
    expect(formatUnixSeconds(0, "MMM d, yyyy")).toBe("Unknown");
    expect(formatUnixSeconds(undefined, "MMM d, yyyy")).toBe("Unknown");
    expect(formatUnixSeconds(null, "MMM d, yyyy", "-")).toBe("-");
  });
});

describe("msToUnixSeconds", () => {
  it("converts a Date.now()-style milliseconds value to Unix seconds", () => {
    const ms = SECONDS_2025 * 1000 + 999;
    expect(msToUnixSeconds(ms)).toBe(SECONDS_2025);
  });

  it("round-trips through the seconds-based formatter without landing in the far future", () => {
    const nowMs = SECONDS_2025 * 1000;
    const d = unixSecondsToDate(msToUnixSeconds(nowMs))!;
    expect(d.getUTCFullYear()).toBe(2025);
  });
});
