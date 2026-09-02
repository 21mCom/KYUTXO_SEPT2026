import { Fragment } from "react";
import type { BoltzmannResult } from "@/lib/boltzmann";

export function probColor(p: number): string {
  const hue = Math.round(130 - p * 130);
  const sat = 70;
  const lit = 42;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

function hslStringToRgb(hsl: string): [number, number, number] {
  const m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(hsl);
  if (!m) throw new Error(`unsupported color: ${hsl}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function cellTextColor(p: number): string {
  const bg = hslStringToRgb(probColor(p));
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  return contrastRatio(bg, white) >= contrastRatio(bg, black)
    ? "#ffffff"
    : "#000000";
}

export function BoltzmannHeatmap({ linkMatrix }: { linkMatrix: BoltzmannResult["linkMatrix"] }) {
  const inputCount  = Math.max(...linkMatrix.map((e) => e.inputIndex))  + 1;
  const outputCount = Math.max(...linkMatrix.map((e) => e.outputIndex)) + 1;

  const pMap = new Map<string, number>();
  for (const e of linkMatrix) pMap.set(`${e.inputIndex}-${e.outputIndex}`, e.probability);

  return (
    <div data-testid="container-boltzmann-heatmap">
      <h4 className="text-xs font-medium mb-2">Link Probability Heatmap</h4>
      <div className="overflow-auto">
        <div
          style={{ display: "grid", gridTemplateColumns: `auto repeat(${outputCount}, minmax(36px, 1fr))`, gap: 2 }}
        >
          <div className="text-xs text-muted-foreground text-right pr-1 pb-1 self-end">In ↓ Out →</div>
          {Array.from({ length: outputCount }, (_, j) => (
            <div key={j} className="text-xs text-center text-muted-foreground pb-1">O{j}</div>
          ))}

          {Array.from({ length: inputCount }, (_, i) => (
            <Fragment key={i}>
              <div className="text-xs text-muted-foreground text-right pr-1 self-center">I{i}</div>
              {Array.from({ length: outputCount }, (_, j) => {
                const p = pMap.get(`${i}-${j}`) ?? 0;
                return (
                  <div
                    key={j}
                    title={`I${i}→O${j}: ${(p * 100).toFixed(0)}%`}
                    style={
                      p > 0
                        ? { backgroundColor: probColor(p), color: cellTextColor(p) }
                        : undefined
                    }
                    className={`rounded text-center text-xs py-1 font-mono ${
                      p > 0 ? "" : "bg-muted/30 text-muted-foreground"
                    }`}
                    data-testid={`cell-heatmap-${i}-${j}`}
                  >
                    {p > 0 ? `${(p * 100).toFixed(0)}` : "–"}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Each cell shows P(input funded output) across all valid transaction interpretations.
        Green = unlikely, yellow = possible, red = probable.
      </p>
    </div>
  );
}
