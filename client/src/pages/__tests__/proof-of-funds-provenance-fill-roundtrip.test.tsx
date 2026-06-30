// @vitest-environment jsdom
//
// Live round-trip coverage for the Step 7/8 "Fill in missing fields" provenance
// shortcut (ProofOfFundsDeclaration -> RecordPreviewContext.openRecordEdit ->
// RecordFormDialog -> save -> live summary refresh).
//
// The Acquisition & Provenance summary lists, per declared address, which
// acquisition fields the address record is missing (date / method / counterparty
// / cost basis) and renders a "Fill in missing fields" button that deep-links the
// record editor into the Acquisition & Provenance section. Because the summary is
// driven by a *live* query of the address records, saving the missing fields must
// make the badges drop off and the "needs attention" count fall — all without a
// manual refresh.
//
// This test exercises the real Dexie-backed CRUD layer (no record-crud mock) so
// the live round-trip is genuine:
//   (1) seeds one address record with NO provenance fields and resolves its
//       balance so a single "done" row exists;
//   (2) turns on the provenance appendix and asserts the row shows the four
//       expected Missing badges plus the "1 needs attention" count;
//   (3) clicks "Fill in missing fields", which must open the editor (covering the
//       openRecordEdit("acquisition") wiring) pre-targeting section-acquisition;
//   (4) fills acquisition date / method / counterparty / cost basis and saves;
//   (5) asserts the live summary refreshes: the row now reports all fields
//       recorded, the incomplete count is gone (the "All recorded" badge shows),
//       and the "Fill in missing fields" button disappears.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { clickSaveButton } from "@/test/clickSave";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";

// A real, valid mainnet P2PKH address so RecordFormDialog's save-time
// validateBitcoinInput passes.
const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Radix primitives inside the record form (Dialog, Select, etc.) reach for
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// The "Fill in missing fields" deep-link scrolls the form to the acquisition
// section; jsdom doesn't implement scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

// Resolve every requested address to a non-zero balance so the address becomes a
// "done" row (the only rows the provenance summary lists).
vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) map.set(a, { balanceSats: 750_000 });
    return map;
  }),
}));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The trigger's data-testid is forwarded onto the
// native <select> so the existing test ids keep working.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = (props: any) => {
    void props;
    return null;
  };
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children, disabled }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

describe("ProofOfFundsDeclaration — provenance 'Fill in missing fields' live round-trip", () => {
  beforeEach(async () => {
    await clearAllRecords();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("updates the missing-field summary live after saving the record", async () => {
    // Seed an address record with no acquisition metadata and no
    // counterparty-bearing fields (label / walletName / counterpartyType all
    // absent) so all four provenance fields read as missing.
    await createRecord({
      type: "address",
      inputString: ADDR,
      label: "",
      notes: "",
      tags: [],
      categories: [],
      owner: "",
      walletName: "",
    } as any);

    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Resolve the address balance so a single "done" row exists.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // Turn on the Acquisition & Provenance appendix to reveal the summary.
    fireEvent.click(screen.getByTestId("switch-include-provenance"));

    // The per-address row appears and reports all four fields as Missing.
    await waitFor(() => {
      expect(screen.getByTestId(`provenance-row-${ADDR}`)).toBeTruthy();
    });

    const row = screen.getByTestId(`provenance-row-${ADDR}`);
    expect(row.textContent).toContain("Missing:");
    expect(row.textContent).toContain("Acquisition date");
    expect(row.textContent).toContain("Acquisition method");
    expect(row.textContent).toContain("Counterparty");
    expect(row.textContent).toContain("Cost basis");

    // The summary count badge reflects one address needing attention.
    expect(
      screen.getByTestId("badge-provenance-incomplete").textContent,
    ).toMatch(/1 needs attention/i);
    expect(screen.queryByTestId("badge-provenance-complete")).toBeNull();

    // Click the deep-link shortcut — covers openRecordEdit("acquisition").
    fireEvent.click(screen.getByTestId(`button-fill-provenance-${ADDR}`));

    // The editor opens, pre-targeting the Acquisition & Provenance section.
    await waitFor(() => {
      expect(screen.getByTestId("section-acquisition")).toBeTruthy();
    });

    // Fill in all four missing provenance fields.
    fireEvent.change(screen.getByTestId("input-acquisition-date"), {
      target: { value: "2023-05-01" },
    });
    fireEvent.change(
      screen.getByTestId("select-address-acquisition-method"),
      { target: { value: "purchase" } },
    );
    fireEvent.change(screen.getByTestId("select-counterparty-type"), {
      target: { value: "exchange" },
    });
    fireEvent.change(screen.getByTestId("input-address-cost-basis"), {
      target: { value: "12345.67" },
    });

    // The seeded record had a blank label, but the editor's Label field is
    // `required`, so a real browser (and jsdom) would block submission until it
    // is filled. Provide a label so clicking Save actually submits.
    fireEvent.change(screen.getByTestId("input-label"), {
      target: { value: "My Addr" },
    });

    // Save by clicking the real Save button (not by firing a submit event on the
    // <form>). clickSaveButton asserts the button is genuinely wired to submit
    // its form, so this also guards against the button being moved outside the
    // <form> or losing type="submit".
    clickSaveButton();

    // The live summary refreshes: the row now reports everything recorded and the
    // incomplete count is gone.
    await waitFor(() => {
      expect(screen.getByTestId("badge-provenance-complete")).toBeTruthy();
    });
    expect(screen.queryByTestId("badge-provenance-incomplete")).toBeNull();

    const updatedRow = screen.getByTestId(`provenance-row-${ADDR}`);
    expect(updatedRow.textContent).toContain("All provenance fields recorded");
    expect(updatedRow.textContent).not.toContain("Missing:");

    // The "Fill in missing fields" shortcut disappears once nothing is missing.
    expect(
      screen.queryByTestId(`button-fill-provenance-${ADDR}`),
    ).toBeNull();
  });
});
