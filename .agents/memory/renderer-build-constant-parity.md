---
name: Renderer build constant parity
description: Why every renderer build target must share compile-time constant injection.
---

Every Vite configuration that builds the application renderer must inject the same compile-time constants from their canonical source.

**Why:** The normal web build defined the application-version constant, but the Electron-specific build did not. TypeScript still passed because the identifier was declared globally, while the packaged renderer threw before React mounted and showed a blank window.

**How to apply:** When adding or changing a global build-time identifier, audit every Vite/Vitest target and add a guard that fails if any shipping renderer configuration omits the replacement. Confirm the built JavaScript contains no unresolved identifier.