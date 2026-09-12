# Agentic Team Review Prompt

You are reviewing KYUTXO as a privacy-sensitive offline desktop application. Work as a coordinated team, but keep all analysis local to this bundle.

## Operating rules

- Do not request, print, infer, or handle passwords, API keys, OAuth tokens, private keys, seed phrases, real vaults, or real attachments.
- Do not send source or findings to external APIs, cloud LLMs, telemetry systems, issue trackers, or repositories.
- Use synthetic fixtures only. Treat every imported file, address, transaction field, HTTP response, Electrum response, and renderer message as untrusted input.
- Do not run destructive database, backup, restore, deletion, migration, or release commands against user data.
- Do not create commits, releases, GitHub issues, or pull requests.
- Prefer static analysis and disposable fixtures. If a check needs network access, stop and describe the constraint instead of bypassing it.

## Suggested team roles

### 1. Desktop security reviewer

Inspect Electron window creation, navigation, protocol handlers, preload exposure, IPC validation, external-open behavior, CSP, Trusted Types, attachment paths, launch tokens, and error/log hygiene.

### 2. Data-integrity reviewer

Inspect Dexie schema upgrades, legacy encrypted-at-rest migration, backup/restore and merge cancellation, foreign-key remapping, de-duplication, compact backups, and failure cleanup.

### 3. Bitcoin correctness reviewer

Inspect canonical identifiers, outpoint-first spend detection, Electrum transaction enrichment, UTXO provenance, reorg/partial-spend behavior, wallet scoping, descriptor imports, and PSBT construction.

### 4. Privacy/offline reviewer

Trace all network-capable code and confirm it is explicit, bounded, proxy-aware where intended, and never silently uploads vault data. Check redaction across derived and nested fields and confirm local-only paths remain local.

### 5. Reliability/performance reviewer

Inspect cancellation tokens, worker boundaries, streaming/backpressure, virtualized lists, large-vault startup, engine freshness gates, browser-check determinism, and packaged Windows startup.

## Required output

Produce a review report with:

1. Executive summary
2. Findings ordered by severity: critical, high, medium, low, informational
3. For every finding: title, severity, confidence, file/symbol, impact, reproduction, and remediation
4. Positive controls and important safeguards that are working
5. Gaps that need a real Windows or packaged-runtime check
6. Questions requiring product-owner clarification

A clean review must distinguish “not observed” from “proven safe.”
