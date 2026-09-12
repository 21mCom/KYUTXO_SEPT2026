// @vitest-environment node
//
// Contrast guard for the remaining global <Button> token pairs.
//
// Task #773 added a dedicated guard for the primary button pair
// (--primary / --primary-foreground). The same illegibility risk exists for the
// other button color pairs that no test covers: --destructive, --secondary, and
// --accent (each paired with its *-foreground). A future brand retune of any of
// these could quietly drop the button label below WCAG AA (4.5:1) without
// failing a single test.
//
// This test reads each foreground/background token pair straight from index.css
// for BOTH :root (light) and .dark, resolves them, and asserts each pair clears
// WCAG AA (4.5:1) in each theme — failing loudly if any token is retuned below
// AA.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { contrastRatio } from "./PrivacyAudit";

// Convert an "H S% L%" token triple (as stored in index.css) to [r, g, b].
function hslTriplet(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

const cssSource = readFileSync(
  resolve(process.cwd(), "client/src/index.css"),
  "utf8",
);

// Pull a `selector { ... }` block out of the stylesheet.
function cssBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(cssSource);
  if (!m) throw new Error(`index.css: no "${selector} { ... }" block found`);
  return m[1];
}

// Resolve a `--token: H S% L%;` declaration from a block into an [r, g, b] tuple.
function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  if (!m) throw new Error(`index.css: no "--${name}" declaration found`);
  return hslTriplet(Number(m[1]), Number(m[2]), Number(m[3]));
}

const BLOCKS = { light: cssBlock(":root"), dark: cssBlock(".dark") } as const;
type ThemeName = keyof typeof BLOCKS;

const WCAG_AA = 4.5; // normal-size text

// Button color pairs NOT covered by PrivacyAudit.primaryButtonContrast.test.
const PAIRS = ["destructive", "secondary", "accent"] as const;

describe("Global <Button> token pairs — legible in both themes", () => {
  for (const pair of PAIRS) {
    for (const theme of ["light", "dark"] as ThemeName[]) {
      it(`--${pair}-foreground on --${pair} clears WCAG AA (${theme})`, () => {
        const fg = token(BLOCKS[theme], `${pair}-foreground`);
        const bg = token(BLOCKS[theme], pair);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${theme}: --${pair}-foreground on --${pair} only reached ${ratio.toFixed(2)}:1 (need >= ${WCAG_AA})`,
        ).toBeGreaterThanOrEqual(WCAG_AA);
      });
    }
  }
});
