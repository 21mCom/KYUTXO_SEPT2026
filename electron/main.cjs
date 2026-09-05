const { app, BrowserWindow, protocol, ipcMain, session, powerMonitor, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const {
  DEFAULT_TOR_PROXY,
  TOR_BROWSER_PROXY,
  makeProxiedRequest,
  getTorProxySettings,
  updateTorProxySettings,
  handleTorRequest,
} = require('./tor-proxy.cjs');

const { registerFileHandlers } = require('./file-handlers.cjs');
const { resolveDataDirs, ensureDirectories: ensureDataDirectories } = require('./paths.cjs');
const { registerElectrumHandlers, stopKeepalive } = require('./electrum-client.cjs');
const { registerEngineHandlers, stopEngineWorker } = require('./engine-handlers.cjs');
const {
  parseIdleLockTimeoutEnv,
  validateVaultLockSettings,
  createVaultLockLifecycle,
} = require('./vault-lock-settings.cjs');
const { registerProtectedStoreHandlers } = require('./protected-store.cjs');
const {
  ProtectedVaultMigrationController,
  runProtectedVaultScenario,
} = require('./protected-vault-migration.cjs');

const {
  isExternalOpenAllowed,
  isNavigationAllowed,
  isQrWorkflowUrl,
  isCameraOnlyMediaPermission,
  PACKAGED_APP_SCHEME,
  escapeHtml,
  sanitizeIpcError,
  logMainError,
  torRequestSchema,
  torProxySettingsSchema,
} = require('./security-utils.cjs');

let mainWindow;

const isDev = process.env.NODE_ENV === 'development';

// Register the packaged scheme before app.ready. A standard, secure scheme
// supports relative asset URLs while keeping the renderer off file://.
if (!isDev) {
  protocol.registerSchemesAsPrivileged([{
    scheme: PACKAGED_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  }]);
}

const LOCK_ON_SUSPEND = process.env.KYUTXO_LOCK_ON_SUSPEND !== '0';
const LOCK_ON_SCREEN_LOCK = process.env.KYUTXO_LOCK_ON_SCREEN_LOCK !== '0';
const LOCK_ON_RESUME = process.env.KYUTXO_LOCK_ON_RESUME !== '0';
const IDLE_LOCK_TIMEOUT_SECONDS = parseIdleLockTimeoutEnv(
  process.env.KYUTXO_IDLE_LOCK_SECONDS,
);
let vaultLockSettings = {
  idleTimeoutSeconds: IDLE_LOCK_TIMEOUT_SECONDS,
  lockOnSuspend: LOCK_ON_SUSPEND,
  lockOnResume: LOCK_ON_RESUME,
  lockOnScreenLock: LOCK_ON_SCREEN_LOCK,
};

async function lockRenderer(reason) {
  try {
    await protectedStoreLifecycle.lock();
  } finally {
    // OS lifecycle locking must always cross the renderer boundary, even if a
    // worker is unavailable. LOCK itself is never forbidden by migration.
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[KYUTXO] Vault lock signal: ${reason}`);
      mainWindow.webContents.send('vault-lock', { reason });
    }
  }
}

const vaultLockLifecycle = createVaultLockLifecycle({
  powerMonitor,
  lockRenderer,
  logError: (error) => logMainError('[KYUTXO] Failed to read system idle time', error),
  logPowerEvent: (eventName) => {
    const messages = {
      suspend: '[KYUTXO] System suspending (going to sleep)',
      resume: '[KYUTXO] System resumed from sleep',
      'lock-screen': '[KYUTXO] Screen locked',
    };
    console.log(messages[eventName]);
  },
});

// ----------------------------------------------------------------------------
// PORTABLE MODE SETUP - Must happen BEFORE app.whenReady()
// This ensures IndexedDB, localStorage, and all browser storage goes to USB
// ----------------------------------------------------------------------------

function getPortableDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return null;
}

function checkPortableMode() {
  if (isDev) return false;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return true;
  }
  return false;
}

const portableMode = checkPortableMode();
let dataDir = '';
let attachmentsDir = '';
let needsReviewDir = '';

if (portableMode) {
  const portableDir = getPortableDir();
  ({ dataDir, attachmentsDir, needsReviewDir } = resolveDataDirs({
    baseDir: portableDir,
    portableMode: true,
  }));

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  app.setPath('userData', dataDir);
  
  console.log('[KYUTXO] PORTABLE MODE ENABLED');
  // Absolute paths stay out of main-process logs.
  console.log('[KYUTXO] Portable mode enabled');
  // Never log the resolved data directory: absolute paths stay out of logs.
  console.log('[KYUTXO] Data directory resolved');
  console.log('[KYUTXO] userData path configured');
} else {
  ({ dataDir, attachmentsDir, needsReviewDir } = resolveDataDirs({
    baseDir: app.getPath('userData'),
    portableMode: false,
  }));
  console.log('[KYUTXO] STANDARD MODE');
  // Never log the resolved data directory: absolute paths stay out of logs.
  console.log('[KYUTXO] Data directory resolved');
}

function ensureDirectories() {
  ensureDataDirectories({ dataDir, attachmentsDir, needsReviewDir });
}

function createWindow() {
  ensureDirectories();
  const { version: appVersion } = require('../package.json');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: isDev,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    icon: path.join(__dirname, '../client/public/icon.png'),
    title: `KYUTXO v${appVersion} - Bitcoin Metadata Manager`,
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Keep packaged-startup diagnostics path-free and payload-free. These
  // lifecycle markers remain safe for release logs while distinguishing a
  // document-load failure from renderer JavaScript that never mounts React.
  mainWindow.webContents.on('dom-ready', () => {
    console.log('[KYUTXO] Packaged renderer DOM ready');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[KYUTXO] Packaged renderer document loaded');
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode) => {
    console.log(`[KYUTXO] Packaged renderer load failed (code=${errorCode})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[KYUTXO] Packaged renderer exited (${details.reason})`);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5000');
    mainWindow.webContents.openDevTools();
  } else {
    console.log('[KYUTXO] Loading packaged renderer');

    mainWindow.loadURL(`${PACKAGED_APP_SCHEME}://bundle/index.html`).catch((err) => {
      // No absolute paths or raw error text in logs or the fallback page.
      logMainError('[KYUTXO] Failed to load packaged renderer', err);
      mainWindow.loadURL(`data:text/html,
        <html>
          <body style="background:#1a1a2e;color:white;font-family:sans-serif;padding:40px;">
            <h1>Error Loading KYUTXO</h1>
            <p>The application interface could not be loaded.</p>
            <p>${escapeHtml(sanitizeIpcError(err, 'Failed to load the application files. Try reinstalling the app.'))}</p>
          </body>
        </html>
      `);
    });
  }

  mainWindow.webContents.on('context-menu', (event, params) => {
    const menuItems = [];
    
    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      params.dictionarySuggestions.forEach((suggestion) => {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        });
      });
      menuItems.push({ type: 'separator' });
      
      menuItems.push({
        label: `Add "${params.misspelledWord}" to Dictionary`,
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      menuItems.push({ type: 'separator' });
    }
    
    menuItems.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    );
    
    const contextMenu = Menu.buildFromTemplate(menuItems);
    contextMenu.popup();
  });

  if (!isDev) {
    // Block production reload/DevTools shortcuts without intercepting ordinary
    // cut/copy/paste/select-all accelerators.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      const reloadShortcut =
        key === 'f5' ||
        ((input.control || input.meta) && key === 'r');
      const devToolsShortcut =
        key === 'f12' ||
        ((input.control || input.meta) && input.shift && key === 'i') ||
        ((input.control || input.meta) && input.alt && key === 'i');
      if (reloadShortcut || devToolsShortcut) event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ----------------------------------------------------------------------------
// REGISTER IPC HANDLERS
// ----------------------------------------------------------------------------

// Register before the renderer is created. Packaged builds expose the protected
// worker; browser/Electron development remains the explicit plaintext fallback.
// Recovery is main-owned and registered before renderer data requests. Task 66
// will supply the IndexedDB adapter/session; until then this controller can
// recover durable markers but has no authority to delete a plaintext source.
const protectedMigrationController = new ProtectedVaultMigrationController({ root: dataDir });
const protectedMigrationRecovery = protectedMigrationController.recover();
const protectedStoreLifecycle = registerProtectedStoreHandlers(ipcMain, {
  dataDir,
  enabled: !isDev,
  operationAllowed: (type) => protectedMigrationController.operationAllowed(type),
});
// This bridge exists only in the disposable packaged release-gate process.
// The scenario runner creates its own main-owned source and protected stores;
// no production renderer can select a filesystem location or invoke it.
if (process.env.KYUTXO_PROTECTED_VAULT_TEST === '1') {
  ipcMain.handle('protected-vault-test:run-scenario', async (_event, payload) => {
    try {
      if (!payload || typeof payload.scenario !== 'string' ||
          !Array.isArray(payload.fixtureTokens) ||
          !payload.fixtureTokens.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
        throw new Error('invalid protected vault test request');
      }
      return await runProtectedVaultScenario({
        root: process.cwd(),
        scenario: payload.scenario,
        fixtureTokens: payload.fixtureTokens,
      });
    } catch {
      // Test API callers receive no paths, keys, password, or source data.
      return { scenario: payload && payload.scenario, status: 'failed', locked: true };
    }
  });
}
registerFileHandlers(ipcMain, { dataDir, attachmentsDir, needsReviewDir, portableMode });
registerElectrumHandlers(ipcMain, { dataDir });
registerEngineHandlers(ipcMain, { dataDir, portableMode, getWindow: () => mainWindow });

// ----------------------------------------------------------------------------
// TOR PROXY IPC HANDLERS
// ----------------------------------------------------------------------------

// Renderer pushes its stored node settings here (on load and on change); the
// allowlist and SOCKS proxy selection for 'tor-request' derive from this
// main-process state, never from per-request input.
ipcMain.handle('tor-update-settings', async (event, rawSettings) => {
  try {
    const parsed = torProxySettingsSchema.safeParse(rawSettings);
    if (!parsed.success) {
      return { success: false, error: `Invalid tor settings: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    return updateTorProxySettings(parsed.data);
  } catch (error) {
    logMainError('[KYUTXO] tor-update-settings failed', error);
    return { success: false, error: sanitizeIpcError(error, 'Failed to update Tor settings') };
  }
});

ipcMain.handle('tor-test', async () => {
  try {
    const proxiesToTest = [
      { name: "Tor Browser", url: TOR_BROWSER_PROXY },
      { name: "Tor Service", url: DEFAULT_TOR_PROXY },
    ];

    // Test the configured custom proxy first (from main-process settings).
    const configuredProxy = getTorProxySettings().torProxyUrl;
    if (configuredProxy && configuredProxy !== TOR_BROWSER_PROXY && configuredProxy !== DEFAULT_TOR_PROXY) {
      proxiesToTest.unshift({ name: "Custom", url: configuredProxy });
    }

    for (const proxy of proxiesToTest) {
      try {
        const result = await makeProxiedRequest({
          url: "https://check.torproject.org/api/ip",
          torProxyUrl: proxy.url,
          timeout: 15000,
        });

        if (result.success && result.data) {
          const torCheck = result.data;
          if (torCheck.IsTor) {
            return {
              success: true,
              // Proxy URLs never cross the IPC bridge; the renderer maps the
              // proxy name back to its known built-in URL (and already holds
              // any custom URL in its own settings).
              proxyName: proxy.name,
              isTor: true,
              torIp: torCheck.IP,
              latency: result.latency,
              message: `Connected via ${proxy.name}. Exit IP: ${torCheck.IP}`,
            };
          }
        }
      } catch {
        continue;
      }
    }

    return {
      success: false,
      error: "Could not connect to Tor. Make sure Tor Browser or Tor service is running.",
      // Report only proxy names — a renderer-supplied custom proxy URL must not
      // be echoed back in the failure payload.
      testedProxies: proxiesToTest.map(p => p.name),
    };
  } catch (error) {
    logMainError('[KYUTXO] tor-test failed', error);
    return { success: false, error: sanitizeIpcError(error, 'Tor connection test failed') };
  }
});

ipcMain.handle('tor-request', async (event, rawArgs) => {
  try {
    const parsedArgs = torRequestSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      return { success: false, error: `Invalid tor-request input: ${parsedArgs.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    // Allowlisting, proxy selection, and resource bounds are enforced inside
    // handleTorRequest from main-process settings (see tor-proxy.cjs).
    return await handleTorRequest(parsedArgs.data);
  } catch (error) {
    logMainError('[KYUTXO] tor-request failed', error);
    return { success: false, error: sanitizeIpcError(error, 'Tor request failed') };
  }
});

ipcMain.handle('set-vault-lock-settings', async (event, rawSettings) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { success: false, error: 'Vault lock settings are not available to this renderer' };
    }

    const parsed = validateVaultLockSettings(rawSettings);
    if (!parsed.ok) {
      return { success: false, error: parsed.error };
    }

    vaultLockSettings = parsed.settings;
    vaultLockLifecycle.applyPolicy(vaultLockSettings);
    return { success: true };
  } catch (error) {
    logMainError('[KYUTXO] Failed to apply vault lock settings', error);
    return {
      success: false,
      error: sanitizeIpcError(error, 'Failed to apply vault lock settings'),
    };
  }
});

ipcMain.handle('tor-status', async () => {
  try {
    const proxiesToTest = [
      { name: "Tor Browser", url: TOR_BROWSER_PROXY, port: 9150 },
      { name: "Tor Service", url: DEFAULT_TOR_PROXY, port: 9050 },
    ];

    const results = [];

    for (const proxy of proxiesToTest) {
      try {
        const result = await makeProxiedRequest({
          url: "https://check.torproject.org/api/ip",
          torProxyUrl: proxy.url,
          timeout: 10000,
        });

        if (result.success) {
          const torCheck = result.data;
          results.push({
            name: proxy.name,
            port: proxy.port,
            available: true,
            isTor: torCheck.IsTor || false,
            exitIp: torCheck.IP,
            latency: result.latency,
          });
        } else {
          results.push({
            name: proxy.name,
            port: proxy.port,
            available: false,
            error: result.error,
          });
        }
      } catch (error) {
        // Raw exception text can embed proxy URLs/paths — keep it off the bridge.
        logMainError(`[KYUTXO] Tor status check (${proxy.name}) failed`, error);
        results.push({
          name: proxy.name,
          port: proxy.port,
          available: false,
          error: sanitizeIpcError(error, "Status check failed"),
        });
      }
    }

    const anyAvailable = results.some(r => r.available && r.isTor);

    return {
      torAvailable: anyAvailable,
      proxies: results,
      recommendation: anyAvailable 
        ? `Tor is available via ${results.find(r => r.available && r.isTor)?.name}`
        : "No Tor proxy detected. Please start Tor Browser or install the Tor service.",
    };
  } catch (error) {
    logMainError('[KYUTXO] tor-status failed', error);
    return { torAvailable: false, proxies: [], recommendation: sanitizeIpcError(error, 'Tor status check failed') };
  }
});

// ----------------------------------------------------------------------------
// APP LIFECYCLE & SECURITY
// ----------------------------------------------------------------------------

// The packaged renderer is served only from dist/public inside app.asar. No
// request path is ever treated as an operating-system path.
const RENDERER_MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

// Single source of truth for the packaged app's CSP. Delivered BOTH via the
// custom-scheme handler below and via onHeadersReceived for any http(s)
// resources.
const PACKAGED_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' permits WebAssembly compilation only (NOT JS
  // eval). Required by the Argon2id KDF (hash-wasm) — without it the
  // packaged app cannot derive vault/backup keys.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  // Blockchain providers are IPC-only in packaged Electron.
  "connect-src 'self'",
  // HTML-parsing sinks must go through the app's named Trusted Types
  // policy (client/src/lib/trusted-types.ts), so injected strings
  // can't reach innerHTML/document.write and hijack the window.
  "require-trusted-types-for 'script'",
  // Only the app's own policies (client/src/lib/trusted-types.ts)
  // may be created; any other createPolicy call throws, so injected
  // scripts can't mint a permissive policy to bypass the sink guard.
  "trusted-types kyutxo-app default",
].join('; ');

function registerPackagedRendererProtocol() {
  const publicDir = path.join(app.getAppPath(), 'dist', 'public');
  protocol.handle(PACKAGED_APP_SCHEME, async (request) => {
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (parsed.hostname !== 'bundle') {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const pathname = decodeURIComponent(parsed.pathname);
      const relativePath = pathname.replace(/^[/\\]+/, '');
      if (
        pathname.includes('\0') ||
        /^[A-Za-z]:[\\/]/.test(relativePath) ||
        relativePath.startsWith('\\\\')
      ) {
        return new Response('Forbidden', { status: 403 });
      }

      const resolved = path.resolve(publicDir, relativePath);
      const relativeToBundle = path.relative(publicDir, resolved);
      if (
        !relativeToBundle ||
        relativeToBundle === '..' ||
        relativeToBundle.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToBundle)
      ) {
        return new Response('Forbidden', { status: 403 });
      }

      let data = await fs.promises.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const type = RENDERER_MIME[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': type };
      if (ext === '.html') {
        // Keep a meta-delivered policy as the enforcement source across the
        // Electron versions supported by the desktop build.
        headers['Content-Security-Policy'] = PACKAGED_CSP;
        const html = data.toString('utf8');
        const metaTag = `<meta http-equiv="Content-Security-Policy" content="${PACKAGED_CSP}">`;
        data = Buffer.from(
          html.includes('http-equiv="Content-Security-Policy"')
            ? html
            : html.replace(/<head>/i, `<head>\n    ${metaTag}`),
          'utf8',
        );
      }
      return new Response(data, { headers });
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logMainError('[KYUTXO] Packaged renderer asset failed', error);
      }
      return new Response('Not found', { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  // Recovery without a password safely discards only unverified stages. A
  // verified publication remains frozen and awaits the trusted task-66 unlock
  // handoff; marker state alone is never accepted as proof.
  await protectedMigrationRecovery.catch(() => {
    // Fail closed: recover() leaves the controller frozen for ambiguous state.
  });
  if (!isDev) {
    registerPackagedRendererProtocol();
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PACKAGED_CSP]
        }
      });
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const cameraOnly =
        isCameraOnlyMediaPermission(permission, details) &&
        isQrWorkflowUrl(webContents.getURL());
      callback(cameraOnly);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      return isCameraOnlyMediaPermission(permission, details) &&
        isQrWorkflowUrl(webContents?.getURL?.() || requestingOrigin);
    });
    // Keep native edit roles but omit reload and developer tooling.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]));
  }
  
  // Development deliberately keeps the browser/Dexie fallback.  A packaged
  // build must prove that the native repository can be selected before its
  // renderer (and therefore an authenticated vault route) is mounted.
  if (!isDev) {
    return protectedStoreLifecycle.call('status').then((status) => {
      if (!status || status.mode !== 'protected' || status.available !== true) {
        throw new Error('Protected store unavailable');
      }
      createWindow();
      vaultLockLifecycle.registerPowerMonitorListeners();
      vaultLockLifecycle.applyPolicy(vaultLockSettings);
    }).catch(() => {
      const blocked = new BrowserWindow({
        width: 700, height: 360, resizable: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        backgroundColor: '#1a1a2e',
      });
      blocked.loadURL('data:text/html,<body style="background:%231a1a2e;color:white;font-family:sans-serif;padding:40px"><h1>Secure storage unavailable</h1><p>KYUTXO could not load its protected vault storage. Reinstall the application.</p></body>');
    });
  }

  createWindow();
  
  vaultLockLifecycle.registerPowerMonitorListeners();
  vaultLockLifecycle.applyPolicy(vaultLockSettings);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  console.log('[Electrum Pool] Cleaning up connections before quit');
  stopKeepalive();
  stopEngineWorker();
  vaultLockLifecycle.shutdown();
  void protectedStoreLifecycle.close();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenAllowed(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, navigationUrl) => {
    if (!isNavigationAllowed(navigationUrl, { isDev })) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
  });
});

app.on('remote-require', (event) => {
  event.preventDefault();
});

app.on('remote-get-builtin', (event) => {
  event.preventDefault();
});

app.on('remote-get-global', (event) => {
  event.preventDefault();
});

app.on('remote-get-current-window', (event) => {
  event.preventDefault();
});

app.on('remote-get-current-web-contents', (event) => {
  event.preventDefault();
});
