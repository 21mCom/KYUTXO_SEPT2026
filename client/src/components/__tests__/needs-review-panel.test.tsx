// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

// The Needs Review panel surfaces orphaned restore attachments (owning record
// absent) as a persistent in-app list instead of a transient toast. It is
// desktop-only and talks to the filesystem over the Electron bridge, so we stub
// the bridge, the attachment upload path, and record search to keep the render
// deterministic and exercise the list / re-attach / delete flows in isolation.
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const { fakeApi, isElectronMock } = vi.hoisted(() => {
  const fakeApi = {
    listNeedsReview: vi.fn(),
    readNeedsReview: vi.fn(),
    deleteNeedsReview: vi.fn(),
    openNeedsReviewFolder: vi.fn(() => Promise.resolve({ success: true })),
  };
  return { fakeApi, isElectronMock: vi.fn(() => true) };
});
vi.mock("@/lib/electron", () => ({
  isElectron: isElectronMock,
  getElectronAPI: () => fakeApi,
}));

const { uploadAttachmentMock } = vi.hoisted(() => ({ uploadAttachmentMock: vi.fn() }));
vi.mock("@/lib/attachments", () => ({
  uploadAttachment: uploadAttachmentMock,
  formatFileSize: (n: number) => `${n} B`,
}));

const { searchRecordsForPickerMock } = vi.hoisted(() => ({ searchRecordsForPickerMock: vi.fn() }));
vi.mock("@/lib/data/record-crud", () => ({
  searchRecordsForPicker: searchRecordsForPickerMock,
}));

import NeedsReviewPanel from "../NeedsReviewPanel";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  isElectronMock.mockReturnValue(true);
  fakeApi.listNeedsReview.mockResolvedValue({
    success: true,
    files: [
      { name: "deed.pdf", size: 2048, routedAt: 1_700_000_000_000 },
      { name: "kyc.png", size: 1024, routedAt: 1_700_000_500_000 },
    ],
  });
  fakeApi.readNeedsReview.mockResolvedValue({ success: true, data: new ArrayBuffer(8) });
  fakeApi.deleteNeedsReview.mockResolvedValue({ success: true });
  uploadAttachmentMock.mockResolvedValue({ id: 1 });
  searchRecordsForPickerMock.mockResolvedValue([
    { id: 42, type: "address", inputString: "bc1qexample", label: "Cold Storage", tags: [], categories: [] },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NeedsReviewPanel", () => {
  it("renders nothing in the web build", async () => {
    isElectronMock.mockReturnValue(false);
    const { container } = render(<NeedsReviewPanel />);
    await flush();
    expect(container.innerHTML).toBe("");
  });

  it("lists orphaned files with their original name and routed date", async () => {
    render(<NeedsReviewPanel />);
    await waitFor(() => expect(screen.getByTestId("card-needs-review")).toBeTruthy());
    expect(screen.getByTestId("text-needs-review-name-deed.pdf").textContent).toBe("deed.pdf");
    expect(screen.getByTestId("text-needs-review-name-kyc.png").textContent).toBe("kyc.png");
    expect(screen.getByTestId("badge-needs-review-count").textContent).toBe("2");
  });

  it("hides the section entirely when there are no files", async () => {
    fakeApi.listNeedsReview.mockResolvedValue({ success: true, files: [] });
    const { container } = render(<NeedsReviewPanel />);
    await flush();
    expect(container.innerHTML).toBe("");
  });

  it("re-attaches a file to a chosen record then removes the orphan", async () => {
    render(<NeedsReviewPanel />);
    await waitFor(() => expect(screen.getByTestId("card-needs-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId("button-reattach-deed.pdf"));
    fireEvent.change(screen.getByTestId("input-reattach-search"), { target: { value: "cold" } });

    const pick = await screen.findByTestId("button-pick-record-42");
    fireEvent.click(pick);
    await flush();

    expect(fakeApi.readNeedsReview).toHaveBeenCalledWith("deed.pdf");
    expect(uploadAttachmentMock).toHaveBeenCalledWith(42, expect.any(File), "bc1qexample");
    expect(fakeApi.deleteNeedsReview).toHaveBeenCalledWith("deed.pdf");
  });

  it("deletes a file after confirmation", async () => {
    render(<NeedsReviewPanel />);
    await waitFor(() => expect(screen.getByTestId("card-needs-review")).toBeTruthy());

    fireEvent.click(screen.getByTestId("button-delete-needs-review-kyc.png"));
    const confirm = await screen.findByTestId("button-confirm-delete-needs-review");
    fireEvent.click(confirm);
    await flush();

    expect(fakeApi.deleteNeedsReview).toHaveBeenCalledWith("kyc.png");
  });
});
