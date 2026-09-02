import type { TransactionParticipant } from "@/lib/database";

export interface SankeyData {
  nodes: { name: string }[];
  links: { source: number; target: number; value: number }[];
}

export const SANKEY_NODE_FILL = "hsl(var(--chart-2))";
export const SANKEY_LINK_STROKE = "hsl(var(--muted-foreground))";

/** Build a proportional fund-flow Sankey model from a tx's inputs/outputs. */
export function buildSankey(inputs: TransactionParticipant[], outputs: TransactionParticipant[]): SankeyData {
  const nodes = [
    ...inputs.map((p, i) => ({ name: `In ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
    ...outputs.map((p, i) => ({ name: `Out ${i + 1}\n${(p.amount / 1e8).toFixed(5)} BTC` })),
  ];
  const totalIn = inputs.reduce((s, p) => s + p.amount, 0) || 1;
  const links: { source: number; target: number; value: number }[] = [];
  inputs.forEach((inp, si) => {
    outputs.forEach((out, ti) => {
      const value = Math.round((inp.amount / totalIn) * out.amount);
      if (value > 0) links.push({ source: si, target: inputs.length + ti, value });
    });
  });
  return { nodes, links };
}
