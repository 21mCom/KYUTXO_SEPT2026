import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { DEBOUNCE_DELAY, PAGE_DEBOUNCE } from "./debounce";

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
