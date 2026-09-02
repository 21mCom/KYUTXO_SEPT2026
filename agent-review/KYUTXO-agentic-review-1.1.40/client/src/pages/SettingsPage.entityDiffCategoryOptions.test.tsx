// @vitest-environment jsdom
//
// Component coverage for the per-category *count labels* and the
// disabled-when-zero behaviour of the category filter dropdown
// (`select-entity-diff-category`) inside the Privacy Audit "Entity List" import
// confirmation dialog on the Settings page.
//
// Sibling tests already drive the diff *tab counts* and the rendered
// added/removed/changed detail rows. What none of them cover is the dropdown's
// own option labels — each category option is labelled with a per-category
// count (e.g. "Exchange (3)") and any category absent from the diff is rendered
// `disabled` with a zero count. A regression there (wrong count, or an empty
// category left selectable) would silently mislead a user about how many
// entries a category affects right before they replace the security-sensitive
// entity list. These counts come from the `entityDiffCategoryCounts` /
// `entityDiffCategoryOptions` memos in SettingsPage.tsx.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";

// A merge always diffs the incoming snapshot against the *bundled* list (not
// the active list a replace uses). The real bundled list is large and would
// make per-category merge counts unpredictable, so swap getBundledEntityList
// for a tiny known baseline while keeping every other export (category labels,
// setActiveEntityList, etc.) real. Replace-mode tests are unaffected — they
// diff against getActiveEntityList, which we set explicitly.
const { MERGE_BUNDLED } = vi.hoisted(() => ({
  MERGE_BUNDLED: [
    // Overridden by the snapshot with a *different* category — exercises the
    // "both override sides counted" path (gambling -> darknet).
    { address: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC", name: "Bundled Recat", category: "gambling" },
    // Overridden by the snapshot with the same category (exchange -> exchange).
    { address: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4", name: "Bundled Stable", category: "exchange" },
  ],
}));

vi.mock("@/lib/privacy-entity-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-entity-list")>();
  return {
    ...actual,
    getBundledEntityList: () => MERGE_BUNDLED,
  };
});

// useAuth throws outside an AuthProvider; the entity panel doesn't need it, so
// stub it to a benign value.
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

// Unrelated heavy sibling panels (own DB queries / auth) — stub so they don't
// interfere with the entity-list panel under test.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select>. Unlike the sibling tests
// this mock deliberately forwards `disabled` onto each <option> so the
// disabled-when-zero assertions can read it. The category-filter state path
// stays real.
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
    SelectItem: ({ value, children, disabled, "data-testid": testid }: any) =>
      React.createElement("option", { value, disabled, "data-testid": testid }, children),
  };
});

// Radix RadioGroup also relies on roving tabindex / pointer behaviour, so swap
// it for plain radio inputs. This keeps the entityImportMode state path real so
// importing in "merge" mode actually computes a merge preview.
vi.mock("@/components/ui/radio-group", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{
    value?: string;
    onValueChange?: (v: string) => void;
  }>({});
  return {
    RadioGroup: ({ value, onValueChange, children }: any) =>
      React.createElement(Ctx.Provider, { value: { value, onValueChange } }, children),
    RadioGroupItem: ({ value, "data-testid": testid }: any) => {
      const ctx = React.useContext(Ctx);
      return React.createElement("input", {
        type: "radio",
        "data-testid": testid,
        checked: ctx.value === value,
        onChange: () => ctx.onValueChange?.(value),
      });
    },
  };
});

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList, setActiveEntityList } = await import(
  "@/lib/privacy-entity-list"
);
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Distinct valid mainnet addresses (the incoming snapshot IS validated).
const ADDR = {
  exA: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  exB: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  exOld: "1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn",
  gamOld: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
  mixNew: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  mixOld: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  payNew: "3Fh9p2W79ZHG54ettRJupkPTs23XcjrkT2",
  // Present on both sides with a *different* category — exercises the
  // "both override sides counted" path (gambling -> darknet).
  recat: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC",
  stable: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4",
} as const;

// Baseline = the active list a preview diffs against.
const BASELINE: EntityEntry[] = [
  { address: ADDR.exOld, name: "Removed Exchange", category: "exchange" },
  { address: ADDR.gamOld, name: "Removed Gambling", category: "gambling" },
  { address: ADDR.mixOld, name: "Removed Mixer", category: "mixer" },
  { address: ADDR.recat, name: "Recat Old", category: "gambling" },
  { address: ADDR.stable, name: "Stable Exchange", category: "exchange" },
];

// Incoming snapshot spanning several categories.
const SNAPSHOT = JSON.stringify([
  { address: ADDR.exA, name: "Added Exchange", category: "exchange" },
  { address: ADDR.exB, name: "Added Exchange Two", category: "exchange" },
  { address: ADDR.mixNew, name: "Added Mixer", category: "mixer" },
  { address: ADDR.payNew, name: "Added Payment", category: "payment-service" },
  { address: ADDR.recat, name: "Recat New", category: "darknet" },
  { address: ADDR.stable, name: "Stable Exchange", category: "exchange" },
]);

function fakeFile(name: string, contents: string) {
  return { name, text: async () => contents } as unknown as File;
}

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

function optionText(cat: string) {
  return screen.getByTestId(`option-entity-diff-category-${cat}`).textContent ?? "";
}

function option(cat: string) {
  return screen.getByTestId(`option-entity-diff-category-${cat}`) as HTMLOptionElement;
}

async function openDiff(mode: "replace" | "merge") {
  renderWithSettingsProviders(<SettingsPage />);
  // Wait for the panel to finish its startup load before overriding the active
  // list (the load resets to bundled when there is no snapshot).
  await screen.findByTestId("badge-entity-source");

  setActiveEntityList(BASELINE);
  if (mode === "merge") {
    fireEvent.click(screen.getByTestId("radio-entity-merge"));
  }
  selectEntityFile("snapshot.json", SNAPSHOT);

  await screen.findByTestId("text-preview-incoming");
  fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
  await screen.findByTestId("select-entity-diff-category");
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; seed one so the panel
  // initializes cleanly with no persisted snapshot.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — entity diff category dropdown counts", () => {
  it("labels each replace-mode category option with its diff count", async () => {
    // Replace diff vs BASELINE:
    //   added   = Added Exchange, Added Exchange Two (exchange), Added Mixer
    //             (mixer), Added Payment (payment-service)
    //   removed = Removed Exchange (exchange), Removed Gambling (gambling),
    //             Removed Mixer (mixer)
    //   changed = Recat (gambling -> darknet) — counts BOTH sides
    // =>  exchange 3, mixer 2, gambling 2, payment-service 1, darknet 1
    // =>  total = added(4) + removed(3) + changed(1) = 8
    await openDiff("replace");

    expect(optionText("all")).toContain("All categories (8)");
    expect(optionText("exchange")).toContain("Exchange (3)");
    expect(optionText("mixer")).toContain("(2)");
    expect(optionText("gambling")).toContain("Gambling (2)");
    expect(optionText("payment-service")).toContain("(1)");
    expect(optionText("darknet")).toContain("(1)");
  });

  it("renders replace-mode categories absent from the diff as disabled zeros", async () => {
    await openDiff("replace");

    // scam / mining-pool / p2p-exchange appear in neither side of the diff.
    for (const cat of ["scam", "mining-pool", "p2p-exchange"]) {
      expect(optionText(cat)).toContain("(0)");
      expect(option(cat).disabled).toBe(true);
    }

    // Categories that DO have entries stay selectable.
    for (const cat of ["exchange", "mixer", "gambling", "payment-service", "darknet"]) {
      expect(option(cat).disabled).toBe(false);
    }
    expect(option("all").disabled).toBe(false);
  });

  it("counts both override sides in merge-mode category options", async () => {
    // Merge diff vs BASELINE:
    //   overrides (overlapping addresses) = Stable Exchange (exchange both
    //     sides) and Recat (gambling -> darknet, both sides counted)
    //   added = Added Exchange, Added Exchange Two (exchange), Added Mixer
    //     (mixer), Added Payment (payment-service)
    // =>  exchange 3 (1 override + 2 added), gambling 1, darknet 1, mixer 1,
    //     payment-service 1
    // =>  total = overrides(2) + added(4) = 6
    await openDiff("merge");

    expect(optionText("all")).toContain("All categories (6)");
    expect(optionText("exchange")).toContain("Exchange (3)");
    expect(optionText("gambling")).toContain("Gambling (1)");
    expect(optionText("darknet")).toContain("(1)");
    expect(optionText("mixer")).toContain("(1)");
    expect(optionText("payment-service")).toContain("(1)");

    // Empty categories still disabled in merge mode.
    expect(option("scam").disabled).toBe(true);
    expect(optionText("scam")).toContain("(0)");
  });
});
