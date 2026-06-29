---
name: mockup-sandbox canvas presentation gotchas
description: How to present mockup-sandbox iframes on the canvas and screenshot their previews without stale renders.
---

# Mockup-sandbox canvas presentation gotchas

Two non-obvious things when finishing a mockup-sandbox design-exploration task on the canvas.

## presentArtifact needs the artifact PATH as artifactId
`presentArtifact({ artifactId, shapeIds })` rejects `"default"`, `"mockup-sandbox"`, and the
`artifact:v3:default-...` shapeId prefix. The valid id is the artifact **path**, e.g.
`"artifacts/mockup-sandbox"`.
**Why:** the canvas tracks artifacts by their registered path; the main-app artifact frame's shapeId
prefix is unrelated to the artifactId param.
**How to apply:** if unsure, call presentArtifact with any guess — the error lists
`Available artifacts: [{id: ...}]`; use that id.

## Preview screenshots are served STALE by the PWA service worker
The mockup preview is proxied through the main app domain (`/__mockup/preview/...`), and KYUTXO is an
offline-first PWA with a service worker that caches those proxied assets. So `screenshot type=external_url`
of a preview URL can show the OLD bundle even after the source + Vite transform are correct
(`curl .../__mockup/src/.../X.tsx` returns the new code, typecheck passes, but the screenshot is old).
**How to apply:** confirm the fresh transform via curl/grep, then append a unique cache-bust query param
to the preview URL (`...?cachebust=<token>`) for each screenshot to force a fresh fetch. Bumping the token
each edit avoids re-serving a previously-cached query URL. (Generalizes the "Stale dev-bundle e2e" note.)
