const { app, BrowserWindow, protocol, ipcMain, session, powerMonitor, Menu } = require('electron');
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
  isExternalOpenAllowed,
  isNavigationAllowed,
  escapeHtml,
  torRequestSchema,
  torProxySettingsSchema,
} = require('./security-utils.cjs');

let mainWindow;

const isDev = process.env.NODE_ENV === 'development';

// ============================================================================
// PORTABLE MODE SETUP - Must happen BEFORE app.whenReady()
// This ensures IndexedDB, localStorage, and all browser storage goes to USB
// ============================================================================

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
  console.log('[KYUTXO] Portable directory:', portableDir);
  console.log('[KYUTXO] Data directory:', dataDir);
  console.log('[KYUTXO] userData path set to:', app.getPath('userData'));
} else {
  ({ dataDir, attachmentsDir, needsReviewDir } = resolveDataDirs({
    baseDir: app.getPath('userData'),
    portableMode: false,
  }));
  console.log('[KYUTXO] STANDARD MODE');
  console.log('[KYUTXO] Data directory:', dataDir);
}

function ensureDirectories() {
  ensureDataDirectories({ dataDir, attachmentsDir, needsReviewDir });
}

function createWindow() {
  ensureDirectories();

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
      preload: path.join(__dirname, 'preload.cjs'),
    },
    icon: path.join(__dirname, '../client/public/icon.png'),
    title: 'KYUTXO - Bitcoin Metadata Manager',
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5000');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist', 'public', 'index.html');
    console.log('[KYUTXO] Loading from:', indexPath);
    
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error('[KYUTXO] Failed to load index.html:', err);
      mainWindow.loadURL(`data:text/html,
        <html>
          <body style="background:#1a1a2e;color:white;font-family:sans-serif;padding:40px;">
            <h1>Error Loading KYUTXO</h1>
            <p>Failed to load: ${escapeHtml(indexPath)}</p>
            <p>Error: ${escapeHtml(err.message)}</p>
            <p>App path: ${escapeHtml(app.getAppPath())}</p>
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================================
// REGISTER IPC HANDLERS
// ============================================================================

registerFileHandlers(ipcMain, { dataDir, attachmentsDir, needsReviewDir, portableMode });
registerElectrumHandlers(ipcMain, { dataDir });
registerEngineHandlers(ipcMain, { dataDir, portableMode, getWindow: () => mainWindow });

// ============================================================================
// TOR PROXY IPC HANDLERS
// ============================================================================

// Renderer pushes its stored node settings here (on load and on change); the
// allowlist and SOCKS proxy selection for 'tor-request' derive from this
// main-process state, never from per-request input.
ipcMain.handle('tor-update-settings', async (event, rawSettings) => {
  const parsed = torProxySettingsSchema.safeParse(rawSettings);
  if (!parsed.success) {
    return { success: false, error: `Invalid tor settings: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  return updateTorProxySettings(parsed.data);
});

ipcMain.handle('tor-test', async () => {
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
            proxyUrl: proxy.url,
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
    testedProxies: proxiesToTest.map(p => p.url),
  };
});

ipcMain.handle('tor-request', async (event, rawArgs) => {
  const parsedArgs = torRequestSchema.safeParse(rawArgs);
  if (!parsedArgs.success) {
    return { success: false, error: `Invalid tor-request input: ${parsedArgs.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  // Allowlisting, proxy selection, and resource bounds are enforced inside
  // handleTorRequest from main-process settings (see tor-proxy.cjs).
  return await handleTorRequest(parsedArgs.data);
});

ipcMain.handle('tor-status', async () => {
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
          url: proxy.url,
          port: proxy.port,
          available: true,
          isTor: torCheck.IsTor || false,
          exitIp: torCheck.IP,
          latency: result.latency,
        });
      } else {
        results.push({
          name: proxy.name,
          url: proxy.url,
          port: proxy.port,
          available: false,
          error: result.error,
        });
      }
    } catch (error) {
      results.push({
        name: proxy.name,
        url: proxy.url,
        port: proxy.port,
        available: false,
        error: error.message || "Unknown error",
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
});

// ============================================================================
// APP LIFECYCLE & SECURITY
// ============================================================================

app.whenReady().then(() => {
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            "img-src 'self' data: blob:",
            "connect-src 'self' https://mempool.space https://blockstream.info",
            // HTML-parsing sinks must go through the app's named Trusted Types
            // policy (client/src/lib/trusted-types.ts), so injected strings
            // can't reach innerHTML/document.write and hijack the window.
            "require-trusted-types-for 'script'",
            // Only the app's own policies (client/src/lib/trusted-types.ts)
            // may be created; any other createPolicy call throws, so injected
            // scripts can't mint a permissive policy to bypass the sink guard.
            "trusted-types kyutxo-app default",
          ].join('; ')
        }
      });
    });
  }
  
  createWindow();
  
  powerMonitor.on('suspend', () => {
    console.log('[KYUTXO] System suspending (going to sleep)');
  });
  
  powerMonitor.on('resume', () => {
    console.log('[KYUTXO] System resumed from sleep');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[KYUTXO] Reloading window after resume');
        mainWindow.reload();
      }
    }, 1000);
  });
  
  powerMonitor.on('lock-screen', () => {
    console.log('[KYUTXO] Screen locked');
  });
  
  powerMonitor.on('unlock-screen', () => {
    console.log('[KYUTXO] Screen unlocked');
  });
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
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenAllowed(url)) {
      require('electron').shell.openExternal(url);
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
