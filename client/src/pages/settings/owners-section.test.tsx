// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const owner = { id: 1, name: "Me", kind: "person" as const, isDefault: true };
const api = vi.hoisted(() => ({
  ensureDefaultOwner: vi.fn(),
  listOwnerPolicies: vi.fn(),
  createOwnerPolicy: vi.fn(),
  updateOwnerPolicy: vi.fn(),
  archiveOwnerPolicy: vi.fn(),
  listResidencies: vi.fn(),
  createResidency: vi.fn(),
  updateResidency: vi.fn(),
  deleteResidency: vi.fn(),
  getOwnerPolicySummaries: vi.fn(),
}));

vi.mock("@/lib/data/owner-policy-crud", () => api);
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { OwnersSection } from "./owners-section";

describe("OwnersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listOwnerPolicies.mockResolvedValue([owner]);
    api.listResidencies.mockResolvedValue([]);
    api.getOwnerPolicySummaries.mockResolvedValue([{ ownerId: 1, currentHoldings: 2, unassignedBatches: 1, disposalsOutsideResidency: 3 }]);
  });
  afterEach(cleanup);

  it("takes a user from the default owner through adding an owner and a residency", async () => {
    api.createOwnerPolicy.mockImplementation(async () => {
      api.listOwnerPolicies.mockResolvedValue([owner, { id: 2, name: "Vault Co", kind: "company" }]);
    });
    render(<OwnersSection />);
    await screen.findByTestId("owner-card-1");
    expect(screen.getByTestId("residency-gap-warning-1").textContent).toContain("No residency");
    expect(screen.getByTestId("owner-summary-holdings").textContent).toContain("2");

    fireEvent.click(screen.getByTestId("button-add-owner"));
    fireEvent.change(screen.getByTestId("input-owner-name"), { target: { value: "Vault Co" } });
    fireEvent.click(screen.getByTestId("button-save-owner"));
    await screen.findByTestId("owner-card-2");
    expect(api.createOwnerPolicy).toHaveBeenCalledWith({
      name: "Vault Co",
      kind: "person",
      defaultMatchingMethod: "fifo",
    });

    fireEvent.click(screen.getByTestId("button-add-residency-2"));
    fireEvent.change(screen.getByTestId("input-residency-jurisdiction"), { target: { value: "Canada" } });
    fireEvent.change(screen.getByTestId("input-residency-start"), { target: { value: "2024-01-01" } });
    fireEvent.click(screen.getByTestId("button-save-residency"));
    await waitFor(() => expect(api.createResidency).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 2, jurisdiction: "Canada", startsOn: "2024-01-01", matchingMethod: "fifo",
    })));
  });

  it("shows the service's overlap and archive-refusal explanations", async () => {
    api.createResidency.mockRejectedValueOnce(new Error("Residency dates overlap the Canada block."));
    api.archiveOwnerPolicy.mockRejectedValueOnce(new Error("Reassign 2 open batches before archiving this owner."));
    render(<OwnersSection />);
    await screen.findByTestId("owner-card-1");
    fireEvent.click(screen.getByTestId("button-add-residency-1"));
    fireEvent.change(screen.getByTestId("input-residency-jurisdiction"), { target: { value: "Canada" } });
    fireEvent.change(screen.getByTestId("input-residency-start"), { target: { value: "2024-01-01" } });
    fireEvent.click(screen.getByTestId("button-save-residency"));
    expect((await screen.findByTestId("owners-error")).textContent).toContain("overlap");

    fireEvent.click(screen.getByTestId("button-archive-owner-1"));
    await waitFor(() => expect(screen.getByTestId("owners-error").textContent).toContain("Reassign 2 open batches"));
  });

  it("uses the default owner's vault-wide unassigned count once and preserves a renamed default owner", async () => {
    api.listOwnerPolicies.mockResolvedValue([
      { id: 1, name: "Alpha owner", kind: "person", isDefault: false },
      { id: 2, name: "Renamed owner", kind: "person", isDefault: true },
    ]);
    api.listResidencies.mockResolvedValue([]);
    api.getOwnerPolicySummaries.mockResolvedValue([
      { ownerId: 1, currentHoldings: 1, unassignedBatches: 9, disposalsOutsideResidency: 0 },
      { ownerId: 2, currentHoldings: 1, unassignedBatches: 4, disposalsOutsideResidency: 0 },
    ]);
    render(<OwnersSection />);
    await screen.findByTestId("owner-card-2");
    expect(screen.getByTestId("owner-summary-unassigned").textContent).toContain("4");
    expect(screen.getByTestId("owner-summary-unassigned").textContent).not.toContain("9");
    expect(screen.getByTestId("owner-card-2").textContent).toContain("Default");
    expect(screen.getByTestId("owner-card-1").textContent).not.toContain("Default");
  });

  it("does not call inclusive next-day blocks a gap, but warns for a real gap", async () => {
    api.listResidencies.mockResolvedValueOnce([
      { id: 1, ownerId: 1, jurisdiction: "Canada", startsOn: "2024-01-01", endsOn: "2024-01-31", matchingMethod: "fifo" },
      { id: 2, ownerId: 1, jurisdiction: "Canada", startsOn: "2024-02-01", endsOn: null, matchingMethod: "fifo" },
    ]);
    render(<OwnersSection />);
    await screen.findByTestId("residency-block-2");
    expect(screen.queryByTestId("residency-gap-warning-1")).toBeNull();
    cleanup();

    api.listResidencies.mockResolvedValueOnce([
      { id: 1, ownerId: 1, jurisdiction: "Canada", startsOn: "2024-01-01", endsOn: "2024-01-31", matchingMethod: "fifo" },
      { id: 2, ownerId: 1, jurisdiction: "Canada", startsOn: "2024-02-02", endsOn: null, matchingMethod: "fifo" },
    ]);
    render(<OwnersSection />);
    expect(await screen.findByTestId("residency-gap-warning-1").then(element => element.textContent)).toContain("gap between");
  });
});