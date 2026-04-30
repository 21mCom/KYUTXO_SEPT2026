import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  DEBOUNCE_DELAY,
  PAGE_DEBOUNCE,
  DEFAULT_SEARCH_PENDING_OPACITY,
  PAGE_SEARCH_PENDING_OPACITY,
  getSearchPendingOpacity,
  type PageName,
} from "./debounce";

const PAGES_DIR = path.resolve(__dirname, "..", "pages");

function collectTsxFiles(dir: string, rel = ""): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectTsxFiles(path.join(dir, entry.name), relPath));
    } else if (entry.name.endsWith(".tsx")) {
      results.push(relPath);
    }
  }
  return results;
}

function readPageSource(relPath: string): string {
  return fs.readFileSync(path.join(PAGES_DIR, relPath), "utf-8");
}

function getPageFiles(): string[] {
  return collectTsxFiles(PAGES_DIR);
}

function getPagesUsingDebouncedValue(): string[] {
  return getPageFiles().filter((file) => {
    const src = readPageSource(file);
    return src.includes("useDebouncedValue");
  });
}

describe("DEBOUNCE_DELAY tiers", () => {
  it("SMALL < MEDIUM < LARGE", () => {
    expect(DEBOUNCE_DELAY.SMALL).toBeLessThan(DEBOUNCE_DELAY.MEDIUM);
    expect(DEBOUNCE_DELAY.MEDIUM).toBeLessThan(DEBOUNCE_DELAY.LARGE);
  });

  it("all tiers are positive numbers", () => {
    expect(DEBOUNCE_DELAY.SMALL).toBeGreaterThan(0);
    expect(DEBOUNCE_DELAY.MEDIUM).toBeGreaterThan(0);
    expect(DEBOUNCE_DELAY.LARGE).toBeGreaterThan(0);
  });
});

describe("PAGE_DEBOUNCE coverage", () => {
  it("has an entry for every page that uses useDebouncedValue", () => {
    const pages = getPagesUsingDebouncedValue();
    expect(pages.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of pages) {
      const basename = path.basename(file, ".tsx");
      if (!(basename in PAGE_DEBOUNCE)) {
        missing.push(file);
      }
    }

    expect(missing).toEqual([]);
  });

  it("every PAGE_DEBOUNCE entry maps to a valid delay tier value", () => {
    const validDelays = new Set(Object.values(DEBOUNCE_DELAY));

    for (const [page, delay] of Object.entries(PAGE_DEBOUNCE)) {
      expect(validDelays.has(delay)).toBe(true);
    }
  });

  it("each page references its own matching PAGE_DEBOUNCE key", () => {
    const pages = getPagesUsingDebouncedValue();
    const wrongKey: string[] = [];

    for (const file of pages) {
      const basename = path.basename(file, ".tsx");
      const src = readPageSource(file);
      if (!src.includes(`PAGE_DEBOUNCE.${basename}`)) {
        wrongKey.push(
          `${file} should use PAGE_DEBOUNCE.${basename}`,
        );
      }
    }

    expect(wrongKey).toEqual([]);
  });

  it("every PAGE_DEBOUNCE key corresponds to an existing page file", () => {
    const pageBasenames = getPageFiles().map((f) => path.basename(f, ".tsx"));

    const orphaned: string[] = [];
    for (const key of Object.keys(PAGE_DEBOUNCE)) {
      if (!pageBasenames.includes(key)) {
        orphaned.push(key);
      }
    }

    expect(orphaned).toEqual([]);
  });
});

describe("no hardcoded debounce delays in pages", () => {
  it("pages pass PAGE_DEBOUNCE.<key> instead of a numeric literal", () => {
    const pages = getPagesUsingDebouncedValue();
    const hardcoded: string[] = [];

    for (const file of pages) {
      const src = readPageSource(file);
      const calls = src.match(/useDebouncedValue\([^)]+\)/g) || [];
      for (const call of calls) {
        if (/,\s*\d+\s*\)/.test(call)) {
          hardcoded.push(`${file}: ${call}`);
        }
      }
    }

    expect(hardcoded).toEqual([]);
  });

  it("pages import PAGE_DEBOUNCE from the config module", () => {
    const pages = getPagesUsingDebouncedValue();
    const missingImport: string[] = [];

    for (const file of pages) {
      const src = readPageSource(file);
      if (!src.includes("PAGE_DEBOUNCE")) {
        missingImport.push(file);
      }
    }

    expect(missingImport).toEqual([]);
  });
});

describe("DEFAULT_SEARCH_PENDING_OPACITY", () => {
  it("is the expected tailwind opacity class", () => {
    expect(DEFAULT_SEARCH_PENDING_OPACITY).toBe("opacity-60");
  });

  it("is a non-empty string", () => {
    expect(typeof DEFAULT_SEARCH_PENDING_OPACITY).toBe("string");
    expect(DEFAULT_SEARCH_PENDING_OPACITY.length).toBeGreaterThan(0);
  });

  it("matches the tailwind opacity utility pattern", () => {
    expect(DEFAULT_SEARCH_PENDING_OPACITY).toMatch(/^opacity-\d+$/);
  });
});

describe("PAGE_SEARCH_PENDING_OPACITY", () => {
  it("contains exactly the 9 expected page entries", () => {
    const expectedKeys: PageName[] = [
      "UTXOs",
      "Transactions",
      "Records",
      "Evidence",
      "WalletOverview",
      "AddressReuse",
      "Dashboard",
      "VaultManagement",
      "ConflictResolution",
    ];
    const actualKeys = Object.keys(PAGE_SEARCH_PENDING_OPACITY).sort();
    expect(actualKeys).toEqual([...expectedKeys].sort());
    expect(actualKeys).toHaveLength(9);
  });

  it("has the same key set as PAGE_DEBOUNCE", () => {
    expect(Object.keys(PAGE_SEARCH_PENDING_OPACITY).sort()).toEqual(
      Object.keys(PAGE_DEBOUNCE).sort(),
    );
  });

  it("every value matches the tailwind opacity utility pattern", () => {
    for (const value of Object.values(PAGE_SEARCH_PENDING_OPACITY)) {
      expect(value).toMatch(/^opacity-\d+$/);
    }
  });

  it("maps high-volume pages (UTXOs, Transactions) to opacity-50", () => {
    expect(PAGE_SEARCH_PENDING_OPACITY.UTXOs).toBe("opacity-50");
    expect(PAGE_SEARCH_PENDING_OPACITY.Transactions).toBe("opacity-50");
  });

  it("maps medium-volume pages to the default opacity", () => {
    expect(PAGE_SEARCH_PENDING_OPACITY.Records).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
    expect(PAGE_SEARCH_PENDING_OPACITY.Evidence).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
    expect(PAGE_SEARCH_PENDING_OPACITY.WalletOverview).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
    expect(PAGE_SEARCH_PENDING_OPACITY.AddressReuse).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
    expect(PAGE_SEARCH_PENDING_OPACITY.Dashboard).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
  });

  it("maps low-volume pages (VaultManagement, ConflictResolution) to opacity-70", () => {
    expect(PAGE_SEARCH_PENDING_OPACITY.VaultManagement).toBe("opacity-70");
    expect(PAGE_SEARCH_PENDING_OPACITY.ConflictResolution).toBe("opacity-70");
  });
});

describe("getSearchPendingOpacity", () => {
  it.each<[PageName, string]>([
    ["UTXOs", "opacity-50"],
    ["Transactions", "opacity-50"],
    ["Records", "opacity-60"],
    ["Evidence", "opacity-60"],
    ["WalletOverview", "opacity-60"],
    ["AddressReuse", "opacity-60"],
    ["Dashboard", "opacity-60"],
    ["VaultManagement", "opacity-70"],
    ["ConflictResolution", "opacity-70"],
  ])("returns the expected opacity class for page %s", (page, expected) => {
    expect(getSearchPendingOpacity(page)).toBe(expected);
  });

  it("returns the same value as the PAGE_SEARCH_PENDING_OPACITY entry for every configured page", () => {
    for (const page of Object.keys(PAGE_SEARCH_PENDING_OPACITY) as PageName[]) {
      expect(getSearchPendingOpacity(page)).toBe(
        PAGE_SEARCH_PENDING_OPACITY[page],
      );
    }
  });

  it("falls back to DEFAULT_SEARCH_PENDING_OPACITY when given an unknown page name", () => {
    const unknownPage = "ThisPageDoesNotExist" as PageName;
    expect(getSearchPendingOpacity(unknownPage)).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
  });

  it("falls back to the default for an empty string page name", () => {
    expect(getSearchPendingOpacity("" as PageName)).toBe(
      DEFAULT_SEARCH_PENDING_OPACITY,
    );
  });

  it("always returns a non-empty string", () => {
    const allKeys = Object.keys(PAGE_SEARCH_PENDING_OPACITY) as PageName[];
    for (const page of [...allKeys, "UnknownPage" as PageName]) {
      const result = getSearchPendingOpacity(page);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
