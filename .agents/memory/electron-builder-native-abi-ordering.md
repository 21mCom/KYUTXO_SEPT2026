---
name: Electron builder native ABI ordering
description: Why Node-native tests can fail immediately after a desktop package build.
---

Run Node/Vitest suites that load native addons before invoking electron-builder, or restore the Node-compatible addon build afterward. Treat an immediate NODE_MODULE_VERSION mismatch after packaging as a build-order artifact, not a product regression.

**Why:** electron-builder rebuilds shared native dependencies such as better-sqlite3 for Electron's ABI in place under node_modules. The same checkout's Node process then cannot load that binary.

**How to apply:** When validating both Node-native engine tests and packaged Electron gates, run the Node tests first. If packaging has already run, restore the dependency for the Node ABI before interpreting native-suite failures.