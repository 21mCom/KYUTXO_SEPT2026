---
name: fontsource-variable import variants
description: Which @fontsource-variable CSS entry to import so bundled fonts match a Google "ital,opsz,wght" CDN request.
---

# @fontsource-variable import variants (matching a Google Fonts request)

The bare import `@fontsource-variable/inter` resolves to `index.css`, which only
ships the **weight-only, upright** faces. A Google Fonts URL that requested
`Inter:ital,opsz,wght` also includes the optical-size axis and italic faces.

To bundle fonts that look identical to such a CDN request (and avoid the browser
synthesizing fake italics, which is a real regression since the app uses the
`italic` class widely):

- Inter: import `@fontsource-variable/inter/opsz.css` + `opsz-italic.css`
  (opsz.css carries the optical-size axis; index.css does not).
- JetBrains Mono: import `@fontsource-variable/jetbrains-mono/wght.css` + `wght-italic.css`.

All variants register the SAME family name (`Inter Variable`,
`JetBrains Mono Variable`), so the `--font-sans` / `--font-mono` CSS vars only need
the family name once.

**Why:** "look identical" requires every face the old CDN served — omitting opsz or
italic silently degrades rendering even though offline loading works.

**How to apply:** when self-hosting a font to replace a Google CDN link, read the
old `family=...:ital,opsz,wght` axes and pick the matching fontsource CSS entry, not
the default bare import. Verify a production build emits `*-italic-*.woff2` assets.
