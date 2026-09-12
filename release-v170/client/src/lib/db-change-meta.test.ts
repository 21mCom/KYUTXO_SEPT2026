// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  notifyDbChange,
  subscribeToDbChanges,
  beginBulkOperation,
  endBulkOperation,
  type DbChangeMeta,
} from "./database";

interface Captured {
  tables: string[];
  meta: DbChangeMeta | undefined;
}

function captureNext(): { calls: Captured[]; unsubscribe: () => void } {
  const calls: Captured[] = [];
  const unsubscribe = subscribeToDbChanges((tables, meta) => {
    calls.push({ tables, meta });
  });
  return { calls, unsubscribe };
}

describe("notifyDbChange meta forwarding", () => {
  let captured: { calls: Captured[]; unsubscribe: () => void };

  beforeEach(() => {
    captured = captureNext();
  });

  it("passes meta through to subscribers for immediate notifications", () => {
    notifyDbChange("records", { origin: "blockchain-sync" });
    captured.unsubscribe();
    expect(captured.calls).toEqual([
      { tables: ["records"], meta: { origin: "blockchain-sync" } },
    ]);
  });

  it("emits no meta when notifying without a meta argument", () => {
    notifyDbChange("records");
    captured.unsubscribe();
    expect(captured.calls).toEqual([{ tables: ["records"], meta: undefined }]);
  });
});

describe("bulk operation origin merging", () => {
  let captured: { calls: Captured[]; unsubscribe: () => void };

  beforeEach(() => {
    captured = captureNext();
  });

  it("forwards origin when every deferred notification shares it", () => {
    beginBulkOperation();
    notifyDbChange("records", { origin: "blockchain-sync" });
    notifyDbChange(["records", "blockchainTransactions"], {
      origin: "blockchain-sync",
    });
    endBulkOperation();
    captured.unsubscribe();
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].meta).toEqual({ origin: "blockchain-sync" });
    expect(new Set(captured.calls[0].tables)).toEqual(
      new Set(["records", "blockchainTransactions"]),
    );
  });

  it("drops origin when deferred notifications have distinct origins", () => {
    beginBulkOperation();
    notifyDbChange("records", { origin: "blockchain-sync" });
    notifyDbChange("records", { origin: "user" });
    endBulkOperation();
    captured.unsubscribe();
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].meta).toBeUndefined();
  });

  it("drops origin when batch mixes a tagged notification with an untagged one", () => {
    beginBulkOperation();
    notifyDbChange("records", { origin: "blockchain-sync" });
    notifyDbChange("records");
    endBulkOperation();
    captured.unsubscribe();
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].meta).toBeUndefined();
  });

  it("emits nothing when no deferred notifications occurred", () => {
    beginBulkOperation();
    endBulkOperation();
    captured.unsubscribe();
    expect(captured.calls).toHaveLength(0);
  });

  it("resets pending state between bulk batches", () => {
    beginBulkOperation();
    notifyDbChange("records", { origin: "blockchain-sync" });
    notifyDbChange("records");
    endBulkOperation();

    beginBulkOperation();
    notifyDbChange("records", { origin: "blockchain-sync" });
    endBulkOperation();

    captured.unsubscribe();
    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[0].meta).toBeUndefined();
    expect(captured.calls[1].meta).toEqual({ origin: "blockchain-sync" });
  });
});
