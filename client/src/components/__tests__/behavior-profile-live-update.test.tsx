// @vitest-environment jsdom
//
// Confirms the behavior badge updates live when an address's cached stats are
// recomputed. An address record starts with no statsComputedAt (rendering the
// neutral "Not Synced" badge); once the cached stats fields are written and the
// component re-renders, the badge must reflect the newly classified label with
// no stale text left behind.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TestProviders } from "@/test/testProviders";

import { RecordCard } from "@/components/RecordCard";
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

const ADDRESS = "bc1qexample000000000000000000000";

afterEach(() => {
  cleanup();
});

const wrapper = TestProviders;

describe("RecordCard behavior badge live update", () => {
  it("changes from 'Not Synced' to 'Accumulator' after cached stats are written", () => {
    // 1. Initial render: no statsComputedAt → not-enough-data ("Not Synced").
    const { getByTestId, rerender } = render(
      <RecordCard
        id="1"
        type="address"
        inputString={ADDRESS}
        label="Test Address"
        tags={[]}
      />,
      { wrapper },
    );

    const badge = getByTestId("badge-behavior-1");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);

    // 2. Stats are recomputed: cached fields are written for this address.
    //    txCount=10, utxoCount=5, balance>0, last activity ~6 months ago
    //    => utxoTxRatio = 0.5 ≥ 0.4, balance > 0, utxoCount ≥ 3 → Accumulator
    rerender(
      <RecordCard
        id="1"
        type="address"
        inputString={ADDRESS}
        label="Test Address"
        tags={[]}
        statsComputedAt={Date.now()}
        cachedTxCount={10}
        cachedBalanceSats={500_000}
        cachedUtxoCount={5}
        cachedLastActivityTime={Math.floor(Date.now() / 1000) - 180 * 24 * 3600}
      />,
    );

    // 3. The same badge element now shows the recomputed label, no stale text.
    const updated = getByTestId("badge-behavior-1");
    expect(updated.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["accumulator"]);
    expect(updated.textContent).not.toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
  });

  it("changes from 'Not Synced' to 'High Activity' after a sync writes a high tx count", () => {
    const { getByTestId, rerender } = render(
      <RecordCard
        id="2"
        type="address"
        inputString={ADDRESS}
        label="Busy Address"
        tags={[]}
      />,
      { wrapper },
    );

    expect(getByTestId("badge-behavior-2").textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["not-enough-data"],
    );

    // A completed sync writes a high tx count (≥ 50) and recent activity.
    rerender(
      <RecordCard
        id="2"
        type="address"
        inputString={ADDRESS}
        label="Busy Address"
        tags={[]}
        statsComputedAt={Date.now()}
        cachedTxCount={75}
        cachedBalanceSats={120_000}
        cachedUtxoCount={4}
        cachedLastActivityTime={Math.floor(Date.now() / 1000) - 10 * 24 * 3600}
      />,
    );

    expect(getByTestId("badge-behavior-2").textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["high-activity"],
    );
  });

  it("still shows 'Not Synced' when a recompute finds zero transactions", () => {
    const { getByTestId, rerender } = render(
      <RecordCard
        id="3"
        type="address"
        inputString={ADDRESS}
        label="Empty Address"
        tags={[]}
      />,
      { wrapper },
    );

    expect(getByTestId("badge-behavior-3").textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["not-enough-data"],
    );

    // Stats computed but no transactions found → stays not-enough-data, but the
    // summary changes to the "synced with 0 transactions" wording.
    rerender(
      <RecordCard
        id="3"
        type="address"
        inputString={ADDRESS}
        label="Empty Address"
        tags={[]}
        statsComputedAt={Date.now()}
        cachedTxCount={0}
        cachedBalanceSats={0}
        cachedUtxoCount={0}
        cachedLastActivityTime={0}
      />,
    );

    const badge = getByTestId("badge-behavior-3");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
    expect(badge.getAttribute("title")).toMatch(/no transactions have been found/i);
  });
});
