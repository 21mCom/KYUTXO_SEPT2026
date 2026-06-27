// @vitest-environment jsdom
//
// Regression coverage for the Fund Trail "Showing <range>" date-range badge.
//
// The Fund Trail page shows a sticky badge (data-testid="fund-trail-active-range")
// whenever a From/To date filter is active, so a filtered trail's totals can't be
// misread as all-time. Nothing pinned this down before: a future change could
// silently break the indicator — it could stop appearing, render the wrong dates,
// or linger after the filter is cleared.
//
// This test renders the REAL FundTrail page backed by a real Dexie database
// (fake-indexeddb), seeds one address record so a wallet group becomes
// selectable, picks that group, then drives the native <input type="date">
// controls to exercise all three range shapes:
//   - start-only   → "Showing from ..."
//   - end-only     → "Showing through ..."
//   - both bounds  → "Showing ... – ..."
// Expected strings are derived from the page's own formatDateRange/toDateRange
// pipeline (re-implemented identically here) so the assertions stay correct
// across locales. Finally it clicks "All time" (data-testid=
// "fund-trail-clear-dates") and asserts the badge is removed from the DOM.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The trigger's data-testid is forwarded onto the
// native <select> so the existing test id keeps working.
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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import FundTrail from "./FundTrail";
import {
  formatDateRange,
  type DateRange,
} from "@/lib/data/fund-trail-engine";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const WALLET_GROUP = "Trail Badge Wallet";
const ADDRESS = "bc1qtrailbadgeaddress00000000000000000000aa";

// Mirror of FundTrail's own toDateRange() so expected badge text is derived from
// the same yyyy-mm-dd → Unix-seconds → formatDateRange pipeline the page uses.
function toDateRange(startDate: string, endDate: string): DateRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  if (startDate) {
    const d = new Date(`${startDate}T00:00:00`);
    if (!isNaN(d.getTime())) start = Math.floor(d.getTime() / 1000);
  }
  if (endDate) {
    const d = new Date(`${endDate}T23:59:59`);
    if (!isNaN(d.getTime())) end = Math.floor(d.getTime() / 1000);
  }
  if (start == null && end == null) return undefined;
  return { start, end };
}

function expectedLabel(startDate: string, endDate: string): string {
  const label = formatDateRange(toDateRange(startDate, endDate));
  if (!label) throw new Error("expected a non-null range label for the test");
  return label;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundTrail />
    </QueryClientProvider>,
  );
}

// Select the seeded wallet group through the (mocked native) select so the
// TrailLayout — which hosts the badge — actually mounts.
async function selectSeededGroup() {
  const groupSelect = await screen.findByTestId("fund-trail-group-select");
  await waitFor(() => {
    expect(
      Array.from(groupSelect.querySelectorAll("option")).some(
        (o) => (o as HTMLOptionElement).value === WALLET_GROUP,
      ),
    ).toBe(true);
  });
  fireEvent.change(groupSelect, { target: { value: WALLET_GROUP } });
  // TrailLayout renders once the center hop query resolves.
  await screen.findByTestId("fund-trail-clear-dates").catch(() => {});
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await createRecord({
    type: "address",
    inputString: ADDRESS,
    label: "Trail badge seed",
    walletName: WALLET_GROUP,
    tags: [],
    categories: [],
  });
});

afterEach(async () => {
  cleanup();
  await clearAllRecords({ skipNotification: true });
  vi.clearAllMocks();
});

describe("Fund Trail date-range badge", () => {
  it("shows a start-only 'Showing from ...' badge", async () => {
    renderPage();
    await selectSeededGroup();

    fireEvent.change(screen.getByTestId("fund-trail-start-date"), {
      target: { value: "2023-10-01" },
    });

    const badge = await screen.findByTestId("fund-trail-active-range");
    const label = expectedLabel("2023-10-01", "");
    expect(label.startsWith("Showing from ")).toBe(true);
    expect(badge.textContent).toContain(label);
  });

  it("shows an end-only 'Showing through ...' badge", async () => {
    renderPage();
    await selectSeededGroup();

    fireEvent.change(screen.getByTestId("fund-trail-end-date"), {
      target: { value: "2023-12-31" },
    });

    const badge = await screen.findByTestId("fund-trail-active-range");
    const label = expectedLabel("", "2023-12-31");
    expect(label.startsWith("Showing through ")).toBe(true);
    expect(badge.textContent).toContain(label);
  });

  it("shows a both-bounds 'Showing ... – ...' badge", async () => {
    renderPage();
    await selectSeededGroup();

    fireEvent.change(screen.getByTestId("fund-trail-start-date"), {
      target: { value: "2023-10-01" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-end-date"), {
      target: { value: "2023-12-31" },
    });

    const badge = await screen.findByTestId("fund-trail-active-range");
    const label = expectedLabel("2023-10-01", "2023-12-31");
    expect(label).toContain(" – ");
    expect(badge.textContent).toContain(label);
  });

  it("removes the badge after clicking 'All time'", async () => {
    renderPage();
    await selectSeededGroup();

    fireEvent.change(screen.getByTestId("fund-trail-start-date"), {
      target: { value: "2023-10-01" },
    });
    fireEvent.change(screen.getByTestId("fund-trail-end-date"), {
      target: { value: "2023-12-31" },
    });
    await screen.findByTestId("fund-trail-active-range");

    fireEvent.click(screen.getByTestId("fund-trail-clear-dates"));

    await waitFor(() => {
      expect(screen.queryByTestId("fund-trail-active-range")).toBeNull();
    });
  });
});
