---
name: Virtualizer range-effect index collision
description: Windowed-list "feed visible range to loader" effects that key off virtualItems[0].index/[last].index (defaulting to 0 when empty) can permanently skip firing when the list mounts with content starting at index 0.
---

A common pattern for virtualized + windowed (fetch-on-demand) lists is:

```js
useEffect(() => {
  if (virtualItems.length === 0) return;
  setRange({ first: virtualItems[0].index, last: virtualItems[last].index });
}, [virtualItems.length ? virtualItems[0].index : 0, virtualItems.length ? virtualItems[last].index : 0]);
```

**Bug:** on the pre-mount render (before the scroll-container ref attaches), `virtualItems.length` is 0, so both dependency values default to `0`. If the list's *first real* virtual item is also index `0` — which is the common case for any list that mounts directly with a small amount of content (e.g. exactly one row, or a handful) — the dependency array is `[0, 0]` on both the empty pre-mount render and the populated post-mount render. React does not see a change, so the effect never re-runs, `range` stays `null` forever, and every row sits on its "Loading…" placeholder permanently. This does NOT reproduce with large lists that grow across many re-renders (by the time there's real content, the ref has already attached on an earlier pass), which is why it can ship unnoticed and only surface for small/edge-case counts.

**Why:** the dependency array conflates "no items exist yet" with "items exist and start at 0" — both collapse to the same value.

**How to apply:** any time you see this pattern, add `virtualItems.length` itself to the dependency array (it reliably changes from 0 to non-zero on the transition). Check every component with its own copy of this effect — it is NOT centralized in the shared loader hook (e.g. `use-windowed-rows.ts`); each virtualized list component reimplements this glue, so the same bug can recur in multiple files independently.
