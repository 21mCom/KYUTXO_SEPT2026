# Release validation and checksum verification

## Validation tiers

`npm run check` and `npm run test:fast` are the required pre-package checks for
pull requests, main-branch builds, and release builds. The fast tier covers
core Bitcoin normalization, vault KDFs, backup round-trips, server launch-token
boundaries, Electron security utilities, dependency-audit behavior, release
workflow policy, and checksum generation.

`npm run test:full` runs every Vitest suite serially (avoiding native database
and browser-resource contention) plus every Node test under `scripts/`. It is
required for version tags and for a manually dispatched
workflow with **Publish a GitHub release** enabled. Packaging and publishing
cannot start if either tier fails.

Routine pushes to `main` or `master` build a downloadable Actions artifact but
do not create a public GitHub release. Public releases are created only by:

- pushing a `v*` tag whose value exactly matches `package.json` (for example,
  tag `v1.2.3` for package version `1.2.3`); or
- manually dispatching the workflow with **Publish a GitHub release** enabled.

All package and release jobs fail closed unless GitHub identifies the repository
as `21mCom/KYUTXO_SEPT2026`. The local pre-push hook applies the same restriction
to normal Git pushes from this project.

## Verify a downloaded Windows build

Each released `.exe` has a sibling `.exe.sha256` file. Keep both files in the
same directory and verify before running the executable.

PowerShell:

```powershell
$expected = (Get-Content .\KYUTXO-1.2.3-Portable.exe.sha256).Split()[0]
$actual = (Get-FileHash .\KYUTXO-1.2.3-Portable.exe -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 checksum mismatch" }
```

Linux or macOS:

```sh
shasum -a 256 -c KYUTXO-1.2.3-Portable.exe.sha256
```

The checksum proves the downloaded bytes match the release asset. It is not a
code-signing certificate and does not establish publisher identity.