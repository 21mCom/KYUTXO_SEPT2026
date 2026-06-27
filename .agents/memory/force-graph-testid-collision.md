---
name: Force-graph node testid collisions
description: Why a graph contrast/interaction test "hangs" (times out) when fixture addresses share a prefix.
---

The Network Analysis force-directed graph renders each node with
`data-testid={`node-address-${node.id.slice(0, 8)}`}` — only the FIRST 8 CHARS
of the address. Test fixtures whose addresses share their first 8 chars (e.g.
`1Cluster0…`, `1Cluster1…` → all slice to `1Cluster`) collide on one testid.

**Symptom:** `getByTestId(...)` inside `waitFor` throws "found multiple
elements" on every retry, so the test exhausts its timeout and looks like a
render/simulation hang — NOT an obvious "duplicate testid" error.

**How to apply:** when seeding graph fixtures, make addresses unique within the
first 8 chars (put the index right after a 1-char prefix, e.g.
`N00…`, `N01…`, `N15…`). Same trap applies to any list that keys testids off a
truncated id/address.

**Related:** graph colours (community palette, owned greens) are theme-aware CSS
tokens read from index.css (`--graph-community-0..15`, `--graph-owned`,
`--graph-owned-border`); contrast tests resolve `hsl(var(--token))` against the
`bg-muted/20` surface per theme, mirroring the peel-graph/heatmap/Sankey pattern.
A test asserting a mark is theme-aware should reject hard-coded `hsl(\d…)`/hex.
