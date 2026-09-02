// @vitest-environment jsdom
//
// Sparse-record rendering (Task #1924): records created without optional
// metadata store label/tags/notes/categories as UNDEFINED (createRecord
// spreads the input as-is) — not empty strings/arrays. The Database Doctor
// Resolve dialog crashed on exactly this shape in a real browser while all
// jsdom fixtures (which always populated those fields) stayed green.
//
// This test renders the real RecordDetailPanel with a record whose optional
// metadata fields are omitted entirely and proves the panel mounts without
// throwing ("Cannot read properties of undefined (reading 'length')" was the
// real-vault failure mode for record.tags/record.categories).

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getParticipantsByAddress: vi.fn(async () => []),
  getParticipantsByTxid: vi.fn(async () => []),
  getTransactionByTxid: vi.fn(async () => null),
  getTransactionsByTxids: vi.fn(async () => []),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,stub") },
}));

const { RecordDetailPanel } = await import("./RecordDetailPanel");

// Mirrors how createRecord stores a record saved without optional metadata:
// label, tags, notes, and categories are simply absent (undefined).
function sparseRecord() {
  return {
    id: "1",
    type: "address" as const,
    inputString: "bc1qsparserecordaddress0000000000000001",
  } as any;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecordDetailPanel with sparse records (optional fields omitted)", () => {
  it("renders without throwing when label/tags/notes/categories are undefined", async () => {
    const { getAllByText, queryByText } = renderWithProviders(
      <RecordDetailPanel open={true} onClose={() => {}} record={sparseRecord()} />,
    );

    // The identifier renders; the Tags/Categories sections stay hidden
    // (undefined behaves like an empty list, it must not crash the panel).
    await waitFor(() => {
      expect(getAllByText("bc1qsparserecordaddress0000000000000001").length).toBeGreaterThan(0);
    });
    expect(queryByText("Tags")).toBeNull();
    expect(queryByText("Categories")).toBeNull();
  });
});
