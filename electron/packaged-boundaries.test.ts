import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const mainSource = readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const vaultLockSource = readFileSync(
  path.join(root, "electron", "vault-lock-settings.cjs"),
  "utf8",
);
const preloadSource = readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const authSource = readFileSync(
  path.join(root, "client", "src", "contexts", "AuthContext.tsx"),
  "utf8",
);

describe("packaged Electron privilege boundaries", () => {
  it("serves only the secure custom bundle scheme, never file://", () => {
    expect(mainSource).toMatch(/registerSchemesAsPrivileged/);
    expect(mainSource).toMatch(/standard:\s*true/);
    expect(mainSource).toMatch(/secure:\s*true/);
    expect(mainSource).toMatch(/protocol\.handle\(PACKAGED_APP_SCHEME/);
    expect(mainSource).toMatch(/loadURL\(`\$\{PACKAGED_APP_SCHEME\}:\/\/bundle\/index\.html`\)/);
    expect(mainSource).not.toMatch(/protocol\.handle\(['"]file['"]/);
    expect(mainSource).not.toMatch(/loadFile\(/);
  });

  it("keeps provider networking behind IPC at the renderer CSP boundary", () => {
    expect(mainSource).toContain('"connect-src \'self\'"');
    expect(mainSource).not.toMatch(/connect-src[^"\n]*(mempool\.space|blockstream\.info)/);
  });

  it("disables production DevTools and spellcheck while retaining edit roles", () => {
    expect(mainSource).toMatch(/devTools:\s*isDev/);
    expect(mainSource).toMatch(/spellcheck:\s*false/);
    expect(mainSource).toMatch(/role:\s*['"]cut['"]/);
    expect(mainSource).toMatch(/role:\s*['"]copy['"]/);
    expect(mainSource).toMatch(/role:\s*['"]paste['"]/);
    expect(mainSource).toMatch(/role:\s*['"]selectAll['"]/);
    expect(mainSource).toMatch(/webContents\.closeDevTools\(\)/);
  });

  it("signals controlled locks for suspend, resume, screen lock, and idle without reload", () => {
    expect(vaultLockSource).toMatch(/powerMonitor\.on\(/);
    expect(vaultLockSource).toMatch(/shouldLock\(eventName\)[\s\S]*lockRenderer\(eventName\)/);
    expect(vaultLockSource).toMatch(/getSystemIdleTime\(\)[\s\S]*lockRenderer\(['"]idle['"]\)/);
    expect(mainSource).toMatch(/Vault lock signal: \$\{reason\}/);
    expect(mainSource).not.toMatch(/mainWindow\.reload\(/);
    expect(preloadSource).toMatch(/ipcRenderer\.on\(['"]vault-lock['"]/);
    expect(preloadSource).toMatch(/removeListener\(['"]vault-lock['"]/);
    expect(authSource).toMatch(/onVaultLock\?\.\([\s\S]*logout\(\)/);
  });

  it("accepts only a narrow validated vault-lock policy from the renderer", () => {
    expect(preloadSource).toMatch(
      /setVaultLockSettings:\s*\(settings\)\s*=>\s*ipcRenderer\.invoke\(['"]set-vault-lock-settings['"], settings\)/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\(['"]set-vault-lock-settings['"][\s\S]*validateVaultLockSettings\(rawSettings\)/,
    );
    expect(mainSource).toMatch(/event\.sender !== mainWindow\.webContents/);
    expect(mainSource).toMatch(/vaultLockLifecycle\.applyPolicy\(vaultLockSettings\)/);
    expect(mainSource).toMatch(/vaultLockLifecycle\.shutdown\(\)/);
  });
});