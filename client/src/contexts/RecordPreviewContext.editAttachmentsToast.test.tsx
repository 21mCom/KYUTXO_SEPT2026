// @vitest-environment jsdom
//
// Guard test for Task #1701: attachment load failures in the shared edit-dialog
// paths must surface a destructive "Attachments unavailable" toast instead of
// silently falling back to an empty list (the pre-Task-1628 behavior).
//
// Covers both edit-dialog paths in RecordPreviewContext:
//   1. openRecordEdit          — initial attachment load when the form opens
//   2. refreshEditingAttachments — reload after an attachment is deleted
//
// getAttachmentsByRecordIdOrIdentifier is partial-mocked (importOriginal) so it
// can be made to reject per-test; the toast layer is mocked so we can assert
// the exact toast payload without depending on Toaster render/dedup behavior.
// The heavy RecordFormDialog is stubbed with a lightweight component that
// exposes the onAttachmentDeleted callback (which the provider wires to
// refreshEditingAttachments) as a clickable button.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

vi.mock("@/lib/data/attachments-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/attachments-crud")>();
  return {
    ...actual,
    getAttachmentsByRecordIdOrIdentifier: vi.fn(actual.getAttachmentsByRecordIdOrIdentifier),
  };
});

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  toast: (...args: unknown[]) => toastSpy(...args),
}));

// Stub the heavy record form dialog. The provider passes
// refreshEditingAttachments as `onAttachmentDeleted`; expose it as a button so
// the test can drive the reload path directly.
vi.mock("@/components/RecordFormDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/RecordFormDialog")>();
  return {
    ...actual,
    RecordFormDialog: (props: { open: boolean; onAttachmentDeleted?: () => void }) =>
      props.open ? (
        <div data-testid="stub-form-dialog">
          <button data-testid="trigger-attachment-refresh" onClick={props.onAttachmentDeleted}>
            refresh attachments
          </button>
        </div>
      ) : null,
  };
});

import { renderWithProviders } from "@/test/testProviders";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { getAttachmentsByRecordIdOrIdentifier } from "@/lib/data/attachments-crud";

const mockedGetAttachments = vi.mocked(getAttachmentsByRecordIdOrIdentifier);

const ADDRESS = "bc1qattachtoast0000000000000000000000000000xy";

function OpenEditButton({ recordId }: { recordId: number }) {
  const { openRecordEdit } = useRecordPreview();
  return (
    <button data-testid="trigger-open-edit" onClick={() => openRecordEdit(recordId)}>
      open edit
    </button>
  );
}

async function seedRecord(): Promise<number> {
  return await createRecord({
    type: "address",
    inputString: ADDRESS,
    label: "Attachment Toast Guard",
    source: "manual",
    addressImportance: "manual",
    tags: [],
    categories: [],
  } as any);
}

const expectedToast = {
  variant: "destructive",
  title: "Attachments unavailable",
  description: "Failed to load this record's attachments. The list shown may be incomplete.",
};

describe("RecordPreviewContext edit-dialog attachment failure toasts", () => {
  beforeEach(async () => {
    toastSpy.mockClear();
    mockedGetAttachments.mockReset();
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("openRecordEdit: shows the destructive toast when the attachment load rejects", async () => {
    const id = await seedRecord();
    mockedGetAttachments.mockRejectedValue(new Error("attachment query exploded"));

    renderWithProviders(<OpenEditButton recordId={id} />);

    toastSpy.mockClear(); // ignore any mount-time toasts
    fireEvent.click(screen.getByTestId("trigger-open-edit"));

    // The edit dialog still opens (failure is non-fatal)…
    await screen.findByTestId("stub-form-dialog");
    // …but the failure must NOT be silent.
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining(expectedToast));
    });
  });

  it("refreshEditingAttachments: shows the destructive toast when the reload rejects", async () => {
    const id = await seedRecord();
    // First load (openRecordEdit) succeeds so the dialog opens without a toast…
    mockedGetAttachments.mockResolvedValueOnce([]);
    // …then the refresh after an attachment delete rejects.
    mockedGetAttachments.mockRejectedValue(new Error("attachment reload exploded"));

    renderWithProviders(<OpenEditButton recordId={id} />);

    fireEvent.click(screen.getByTestId("trigger-open-edit"));
    await screen.findByTestId("stub-form-dialog");

    // Opening succeeded — no failure toast so far.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Attachments unavailable" }),
    );

    toastSpy.mockClear();
    fireEvent.click(screen.getByTestId("trigger-attachment-refresh"));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining(expectedToast));
    });
  });
});
