import { execSync } from 'node:child_process';

export const PACKAGED_BINARY_LOOKUP_TIMEOUT_MS = 15_000;

// Keep the release-gate runtime requirements in one place. In particular, the
// nix Electron 29 runtime is intentional: newer upstream Electron binaries
// FPE-crash in this environment, while the old Xvfb bundled by xvfb-run
// segfaults. The narrow store globs avoid scanning /nix/store, which can block
// for minutes on Replit's store mount.
export const PACKAGED_BINARY_SPECS = Object.freeze({
  electron: Object.freeze({
    envVar: 'KYUTXO_ELECTRON_BIN',
    storePattern: '/nix/store/*-electron-29.*/bin/electron',
    binName: 'electron',
    requirement: 'nix electron 29.x — upstream Electron binaries FPE-crash here',
  }),
  xvfb: Object.freeze({
    envVar: 'KYUTXO_XVFB_BIN',
    storePattern: '/nix/store/*-xorg-server-2*/bin/Xvfb',
    binName: 'Xvfb',
    requirement: 'nix xorg-server Xvfb — xvfb-run\u2019s bundled 1.20 Xvfb segfaults here',
  }),
});

/**
 * Finds a packaged-check binary using an explicit override first, then one
 * narrow /nix/store glob. The exec option is intentionally injectable so this
 * contract can be tested without touching the real nix store.
 *
 * @param {{
 *   envVar: string,
 *   storePattern: string,
 *   binName: string,
 *   requirement: string,
 *   tag?: string,
 *   env?: NodeJS.ProcessEnv,
 *   exec?: typeof execSync,
 *   timeoutMs?: number,
 * }} options
 */
export function findPackagedBinary({
  envVar,
  storePattern,
  binName,
  requirement,
  tag = '[packaged-electron]',
  env = process.env,
  exec = execSync,
  timeoutMs = PACKAGED_BINARY_LOOKUP_TIMEOUT_MS,
}) {
  if (env[envVar]) return env[envVar];

  try {
    const candidate = exec(
      `for candidate in ${storePattern}; do ` +
        `[ -x "$candidate" ] && { printf '%s\\n' "$candidate"; break; }; done`,
      { encoding: 'utf8', timeout: timeoutMs },
    ).trim();
    if (candidate) return candidate;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error(
    `${tag} could not find ${binName} (${requirement}). Set ${envVar} to override.`,
  );
}

/**
 * Resolves the exact Electron/Xvfb pair used by every packaged-app check.
 *
 * @param {{
 *   tag?: string,
 *   env?: NodeJS.ProcessEnv,
 *   exec?: typeof execSync,
 *   timeoutMs?: number,
 * }} [options]
 */
export function findPackagedBinaries(options = {}) {
  const { tag, env, exec, timeoutMs } = options;
  return {
    electronBin: findPackagedBinary({
      ...PACKAGED_BINARY_SPECS.electron,
      tag,
      env,
      exec,
      timeoutMs,
    }),
    xvfbBin: findPackagedBinary({
      ...PACKAGED_BINARY_SPECS.xvfb,
      tag,
      env,
      exec,
      timeoutMs,
    }),
  };
}