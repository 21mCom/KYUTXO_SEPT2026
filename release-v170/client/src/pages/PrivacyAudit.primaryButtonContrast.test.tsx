// @vitest-environment node
//
// Contrast guard for the GLOBAL primary-button token pair.
//
// Every primary <Button> in the app paints white --primary-foreground text on
// the orange --primary fill. Task #751 darkened --primary (45% -> 38% L) so this
// pair clears WCAG AA (4.5:1). Until now that was only verified indirectly via
// the peel-chain graph's "H1" node label (PrivacyAudit.peelGraphContrast.test).
// If --primary or --primary-foreground were ever retuned (e.g. lightened back
// toward 45%), every primary button would quietly fall below AA without failing
// any test.
//
// This test reads the --primary / --primary-foreground triples straight from
// index.css for BOTH :root (light) and .dark, resolves them, and asserts the
// white-on-orange contrast stays >= 4.5:1 in each theme — independent of the
// peel graph.

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

describe("Global primary <Button> token pair — legible in both themes", () => {
  for (const theme of ["light", "dark"] as ThemeName[]) {
    it(`white --primary-foreground on --primary clears WCAG AA (${theme})`, () => {
      const fg = token(BLOCKS[theme], "primary-foreground");
      const bg = token(BLOCKS[theme], "primary");
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${theme}: --primary-foreground on --primary only reached ${ratio.toFixed(2)}:1 (need >= ${WCAG_AA})`,
      ).toBeGreaterThanOrEqual(WCAG_AA);
    });
  }
});
