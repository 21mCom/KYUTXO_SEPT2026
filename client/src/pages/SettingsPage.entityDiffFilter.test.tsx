// @vitest-environment jsdom
//
// Coverage for the category filter inside the entity-list import confirmation
// dialog (Settings > Privacy Audit Entity List). The dialog's "Show changed
// entries" diff has a category dropdown beside the text search; selecting a
// category narrows each tab's list (Added / Changed / Removed) and updates the
// tab counts, and it combines with the text search. This test drives that
// wiring end to end against a small, known active list.
//
// The diff tab counts are rendered straight from the filtered arrays in the
// TabsTrigger labels, so we assert on those labels (deterministic) rather than
// the virtualized row lists (which don't lay out under jsdom).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// useAuth throws outside an AuthProvider; the entity panel doesn't need it.
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isInitialized: true,
    isAuthenticated: true,
    setupPassword: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    isLoading: false,
    isMigrating: false,
    legacyMigrationProgress: null,
    legacyMigrationResult: null,
    fileDecryptProgress: null,
  }),
}));

// Unrelated heavy sibling panels — stub so they don't interfere.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The category-filter state path stays real.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
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

const SettingsPage = (await import("./SettingsPage")).default;
const { ActivityBusProvider } = await import("@/lib/activity-bus");
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList, setActiveEntityList } = await import(
  "@/lib/privacy-entity-list"
);
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses (drawn from the bundled list, all distinct & valid).
const A = {
  alpha: "1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn",
  beta: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
  gamma: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4",
  delta: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  epsilon: "bc1ql42rmpvvq488tkqxvg8wmaa7j3jsrkxgnm8cy6",
  zeta: "16ftSEQ4ctQFDtVZiUBusQUjRrGhM3JYwe",
  eta: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
} as const;

// The active list before the import (set directly so the replace-mode diff is
// computed against a small, fully known baseline instead of the 400+ bundled
// entries).
const ACTIVE: EntityEntry[] = [
  { address: A.alpha, name: "Alpha", category: "exchange" },
  { address: A.beta, name: "Beta", category: "mixer" },
  { address: A.gamma, name: "Gamma", category: "gambling" },
  { address: A.delta, name: "Delta", category: "exchange" },
];

// The incoming snapshot (replace mode). Diff against ACTIVE:
//   added   = Epsilon (exchange), Zeta (mixer), Eta (gambling)   -> 3
//   changed = Beta (renamed, still mixer)                        -> 1
//   removed = Gamma (gambling), Delta (exchange)                 -> 2
//   Alpha is unchanged.
const SNAPSHOT = JSON.stringify([
  { address: A.alpha, name: "Alpha", category: "exchange" },
  { address: A.beta, name: "Beta Renamed", category: "mixer" },
  { address: A.epsilon, name: "Epsilon", category: "exchange" },
  { address: A.zeta, name: "Zeta", category: "mixer" },
  { address: A.eta, name: "Eta", category: "gambling" },
]);

function fakeFile(name: string, contents: string) {
  return { name, text: async () => contents } as unknown as File;
}

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

function setCategory(value: string) {
  fireEvent.change(screen.getByTestId("select-entity-diff-category"), {
    target: { value },
  });
}

function tabCounts() {
  return {
    added: screen.getByTestId("tab-entity-diff-added").textContent ?? "",
    changed: screen.getByTestId("tab-entity-diff-changed").textContent ?? "",
    removed: screen.getByTestId("tab-entity-diff-removed").textContent ?? "",
  };
}

beforeEach(async () => {
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — import diff category filter", () => {
  async function openDiff() {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    // Replace the active list with our small known baseline so the diff is
    // controllable, then import the snapshot (default mode is "replace").
    setActiveEntityList(ACTIVE);
    selectEntityFile("snapshot.json", SNAPSHOT);

    // Preview dialog appears; reveal the diff tabs (collapsed by default).
    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-added");
  }

  it("narrows each tab and updates the counts when a category is selected", async () => {
    await openDiff();

    // "All categories" baseline: 3 added, 1 changed, 2 removed.
    expect(tabCounts().added).toContain("(3)");
    expect(tabCounts().changed).toContain("(1)");
    expect(tabCounts().removed).toContain("(2)");

    // Exchange: Epsilon added, Delta removed, nothing changed.
    setCategory("exchange");
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));
    expect(tabCounts().changed).toContain("(0)");
    expect(tabCounts().removed).toContain("(1)");

    // Mixer: Zeta added, Beta changed, nothing removed.
    setCategory("mixer");
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));
    expect(tabCounts().changed).toContain("(1)");
    expect(tabCounts().removed).toContain("(0)");

    // Gambling: Eta added, Gamma removed, nothing changed.
    setCategory("gambling");
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));
    expect(tabCounts().changed).toContain("(0)");
    expect(tabCounts().removed).toContain("(1)");

    // A category with no diff entries empties every tab.
    setCategory("darknet");
    await waitFor(() => expect(tabCounts().added).toContain("(0)"));
    expect(tabCounts().changed).toContain("(0)");
    expect(tabCounts().removed).toContain("(0)");
  });

  it("applies the text search and category dropdown together", async () => {
    await openDiff();

    // Text alone: only the "Epsilon" added entry matches.
    fireEvent.change(screen.getByTestId("input-entity-diff-search"), {
      target: { value: "epsilon" },
    });
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));

    // Text + matching category (exchange) keeps the single match.
    setCategory("exchange");
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));

    // Same text + a non-matching category (mixer) drops it to zero — the two
    // filters are combined (AND), not either/or.
    setCategory("mixer");
    await waitFor(() => expect(tabCounts().added).toContain("(0)"));
  });

  it("restores the unfiltered lists when 'All categories' is chosen", async () => {
    await openDiff();

    setCategory("exchange");
    await waitFor(() => expect(tabCounts().added).toContain("(1)"));

    setCategory("all");
    await waitFor(() => expect(tabCounts().added).toContain("(3)"));
    expect(tabCounts().changed).toContain("(1)");
    expect(tabCounts().removed).toContain("(2)");
  });
});
