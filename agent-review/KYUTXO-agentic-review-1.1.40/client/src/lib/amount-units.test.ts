// Unit tests for the shared BTC/sats display-unit helpers used by the
// dust-threshold and amount inputs on DustedPage, AddressPoisoning,
// DormantCoins, BalanceOverview and UTXOs (button-toggle-unit).
//
// These pages feed `unitInputToSats(rawInputValue, unit)` straight into the
// underlying sats-denominated scan/threshold logic, so any drift here is a
// silent miscalibration of every dust/threshold comparison in the app.

import { describe, it, expect } from "vitest";
import {
  unitInputToSats,
  satsToUnitInput,
  formatSatsWithUnit,
  unitLabel,
} from "./amount-units";

describe("unitInputToSats", () => {
  it("parses whole-sats input verbatim under the sats unit", () => {
    expect(unitInputToSats("546", "sats")).toBe(546);
    expect(unitInputToSats("1", "sats")).toBe(1);
    expect(unitInputToSats("0", "sats")).toBe(0);
  });

  it("converts a plain BTC amount to sats", () => {
    expect(unitInputToSats("1", "btc")).toBe(100_000_000);
    expect(unitInputToSats("0.5", "btc")).toBe(50_000_000);
  });

  it("converts the smallest possible BTC amount (1 sat) exactly", () => {
    expect(unitInputToSats("0.00000001", "btc")).toBe(1);
  });

  it("converts a dust-threshold-sized BTC amount exactly", () => {
    // 546 sats is the classic dust threshold default.
    expect(unitInputToSats("0.00000546", "btc")).toBe(546);
  });

  it("rounds a BTC amount that doesn't divide evenly into whole sats", () => {
    // 0.000000005 BTC = 0.5 sats -> rounds to nearest integer (1, banker's
    // rounding is not used; Math.round(0.5) === 1).
    expect(unitInputToSats("0.000000005", "btc")).toBe(1);
    // 12.3456789 BTC = 1,234,567,890 sats exactly at 8dp, but pile on a 9th
    // decimal digit to exercise float-noise rounding.
    expect(unitInputToSats("0.123456785", "btc")).toBe(12345679);
  });

  it("rounds a fractional sats input to the nearest whole sat", () => {
    expect(unitInputToSats("1.4", "sats")).toBe(1);
    expect(unitInputToSats("1.5", "sats")).toBe(2);
  });

  it("treats blank input as invalid (null), not zero", () => {
    expect(unitInputToSats("", "sats")).toBeNull();
    expect(unitInputToSats("   ", "btc")).toBeNull();
  });

  it("rejects negative and non-numeric input in both units", () => {
    expect(unitInputToSats("-1", "sats")).toBeNull();
    expect(unitInputToSats("-0.001", "btc")).toBeNull();
    expect(unitInputToSats("abc", "sats")).toBeNull();
    expect(unitInputToSats("abc", "btc")).toBeNull();
    expect(unitInputToSats("NaN", "btc")).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(unitInputToSats("  0.00000001  ", "btc")).toBe(1);
  });
});

describe("satsToUnitInput", () => {
  it("formats sats as a plain integer string under the sats unit", () => {
    expect(satsToUnitInput(546, "sats")).toBe("546");
    expect(satsToUnitInput(1, "sats")).toBe("1");
  });

  it("formats sats as an 8-decimal BTC string", () => {
    expect(satsToUnitInput(100_000_000, "btc")).toBe("1.00000000");
    expect(satsToUnitInput(546, "btc")).toBe("0.00000546");
    expect(satsToUnitInput(1, "btc")).toBe("0.00000001");
  });

  it("returns an empty string for non-finite input", () => {
    expect(satsToUnitInput(NaN, "sats")).toBe("");
    expect(satsToUnitInput(Infinity, "btc")).toBe("");
  });
});

describe("BTC/sats round-trip (toggle back and forth never drifts the value)", () => {
  const cases: number[] = [
    1, // smallest unit, 1 sat
    546, // classic dust threshold
    2000, // AddressPoisoning/DormantCoins default dust threshold
    100_000_000, // exactly 1 BTC
    123_456_789, // arbitrary value that doesn't divide evenly by any round BTC amount
    21_000_000 * 100_000_000, // max possible supply, sanity check at scale
  ];

  it.each(cases)("sats -> BTC input -> sats recovers %i exactly", (sats) => {
    const btcInput = satsToUnitInput(sats, "btc");
    const recovered = unitInputToSats(btcInput, "btc");
    expect(recovered).toBe(sats);
  });

  it.each(cases)("sats -> sats input -> sats recovers %i exactly", (sats) => {
    const satsInput = satsToUnitInput(sats, "sats");
    const recovered = unitInputToSats(satsInput, "sats");
    expect(recovered).toBe(sats);
  });

  it("repeated unit toggling (sats -> BTC -> sats -> BTC) never drifts", () => {
    let sats = 546;
    for (let i = 0; i < 6; i++) {
      const unit = i % 2 === 0 ? "btc" : "sats";
      const raw = satsToUnitInput(sats, unit);
      const next = unitInputToSats(raw, unit);
      expect(next).toBe(sats);
      sats = next!;
    }
  });
});

describe("formatSatsWithUnit", () => {
  it("renders a comma-grouped sats amount with the sats suffix", () => {
    expect(formatSatsWithUnit(1_234_567, "sats")).toBe("1,234,567 sats");
  });

  it("renders an 8-decimal BTC amount with the BTC suffix", () => {
    expect(formatSatsWithUnit(546, "btc")).toBe("0.00000546 BTC");
    expect(formatSatsWithUnit(100_000_000, "btc")).toBe("1.00000000 BTC");
  });
});

describe("unitLabel", () => {
  it("maps units to their short display labels", () => {
    expect(unitLabel("sats")).toBe("sats");
    expect(unitLabel("btc")).toBe("BTC");
  });
});
