const { app, BrowserWindow, protocol, ipcMain, session, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// ============================================================================
// TOR PROXY SUPPORT
// ============================================================================
const DEFAULT_TOR_PROXY = "socks5h://127.0.0.1:9050";
const TOR_BROWSER_PROXY = "socks5h://127.0.0.1:9150";

// Use node-fetch for Node.js compatibility in Electron main process
let nodeFetch;
async function getFetch() {
  if (!nodeFetch) {
    try {
      // Dynamic import for node-fetch (ESM module)
      nodeFetch = (await import('node-fetch')).default;
    } catch (error) {
      console.error('[KYUTXO] Failed to load node-fetch for Tor proxy:', error.message);
      throw new Error('Tor proxy requires node-fetch module. Please ensure it is installed.');
    }
  }
  return nodeFetch;
}

// Allowed hostnames for Bitcoin API requests - prevents SSRF attacks
const ALLOWED_API_HOSTS = [
  "mempool.space",
  "blockstream.info",
  "check.torproject.org",
];

function isAllowedUrl(urlString, additionalAllowedHost) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    
    // Allow .onion addresses
    if (hostname.endsWith('.onion')) {
      return { allowed: true };
    }
    
    // Block private IP ranges
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^0\./,
      /^169\.254\./,
    ];
    
    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) {
        return { allowed: false, reason: "Internal network addresses are not allowed" };
      }
    }
    
    // Build dynamic allowlist
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (additionalAllowedHost) {
      try {
        const additionalParsed = new URL(additionalAllowedHost);
        const additionalHostname = additionalParsed.hostname.toLowerCase();
        const isPrivate = privatePatterns.some(p => p.test(additionalHostname));
        if (!isPrivate) {
          allowedHosts.push(additionalHostname);
        }
      } catch {
        // Invalid URL, ignore
      }
    }
    
    // Check against allowlist
    const isAllowed = allowedHosts.some(allowed => 
      hostname === allowed || hostname.endsWith('.' + allowed)
    );
    
    if (!isAllowed) {
      return { allowed: false, reason: `Host '${hostname}' is not in the allowed list` };
    }
    
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
}

async function makeProxiedRequest(requestParams) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const fetch = await getFetch();
  const startTime = Date.now();
  const proxyUrl = requestParams.torProxyUrl || DEFAULT_TOR_PROXY;
  const timeout = requestParams.timeout || 60000;

  try {
    const agent = new SocksProxyAgent(proxyUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions = {
      method: requestParams.method || "GET",
      headers: requestParams.headers,
      signal: controller.signal,
      agent,
    };

    if (requestParams.body && (requestParams.method === "POST" || requestParams.method === "PUT")) {
      fetchOptions.body = JSON.stringify(requestParams.body);
    }

    const response = await fetch(requestParams.url, fetchOptions);
    clearTimeout(timeoutId);

    const latency = Date.now() - startTime;
    
    let data;
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      latency,
      contentType: contentType || undefined,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error.name === "AbortError") {
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000}s. Tor connections can be slow - try increasing the timeout.`,
        latency,
      };
    }
    
    if (error.message && error.message.includes("ECONNREFUSED")) {
      return {
        success: false,
        error: `Cannot connect to Tor proxy at ${proxyUrl}. Make sure Tor is running.`,
        latency,
      };
    }
    
    return {
      success: false,
      error: error.message || "Unknown error occurred",
      latency,
    };
  }
}

// Determine if running in development or production
const isDev = process.env.NODE_ENV === 'development';

// ============================================================================
// PORTABLE MODE SETUP - Must happen BEFORE app.whenReady()
// This ensures IndexedDB, localStorage, and all browser storage goes to USB
// ============================================================================

// Get portable directory from electron-builder env var
function getPortableDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return null;
}

// Check for portable mode early (before app is ready)
function checkPortableMode() {
  if (isDev) return false;
  
  // electron-builder sets this for portable builds
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return true;
  }
  
  return false;
}

// Initialize portable mode IMMEDIATELY (before app.whenReady)
const portableMode = checkPortableMode();
let dataDir = '';
let attachmentsDir = '';

if (portableMode) {
  const portableDir = getPortableDir();
  dataDir = path.join(portableDir, 'KYUTXO_Data');
  attachmentsDir = path.join(dataDir, 'attachments');
  
  // Create data directory if it doesn't exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // CRITICAL: Set userData path BEFORE app is ready
  // This makes IndexedDB, localStorage, cookies, etc. all go to the portable folder
  app.setPath('userData', dataDir);
  
  console.log('[KYUTXO] PORTABLE MODE ENABLED');
  console.log('[KYUTXO] Portable directory:', portableDir);
  console.log('[KYUTXO] Data directory:', dataDir);
  console.log('[KYUTXO] userData path set to:', app.getPath('userData'));
} else {
  // Standard mode - use default userData location
  dataDir = path.join(app.getPath('userData'), 'data');
  attachmentsDir = path.join(dataDir, 'attachments');
  console.log('[KYUTXO] STANDARD MODE');
  console.log('[KYUTXO] Data directory:', dataDir);
}

// Ensure data directories exist
function ensureDirectories() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }
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

  // Show window when ready to prevent flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the app
  if (isDev) {
    // In development, connect to Vite dev server
    mainWindow.loadURL('http://localhost:5000');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the built files from the asar package
    // app.getAppPath() returns the path to app.asar which contains dist/public/index.html
    const indexPath = path.join(app.getAppPath(), 'dist', 'public', 'index.html');
    console.log('[KYUTXO] Loading from:', indexPath);
    
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error('[KYUTXO] Failed to load index.html:', err);
      mainWindow.loadURL(`data:text/html,
        <html>
          <body style="background:#1a1a2e;color:white;font-family:sans-serif;padding:40px;">
            <h1>Error Loading KYUTXO</h1>
            <p>Failed to load: ${indexPath}</p>
            <p>Error: ${err.message}</p>
            <p>App path: ${app.getAppPath()}</p>
          </body>
        </html>
      `);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handle file operations via IPC
ipcMain.handle('get-app-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('get-data-path', () => {
  return dataDir;
});

ipcMain.handle('get-attachments-path', () => {
  return attachmentsDir;
});

ipcMain.handle('is-portable-mode', () => {
  return portableMode;
});

ipcMain.handle('save-attachment', async (event, { identifier, filename, data }) => {
  try {
    const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
    const recordDir = path.join(attachmentsDir, sanitizedIdentifier);
    
    if (!fs.existsSync(recordDir)) {
      fs.mkdirSync(recordDir, { recursive: true });
    }
    
    // Add 3-character random suffix to prevent overwrites
    const randomSuffix = Math.random().toString(36).substring(2, 5);
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const uniqueFilename = `${baseName}_${randomSuffix}${ext}`;
    
    const filePath = path.join(recordDir, uniqueFilename);
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    
    return { success: true, path: path.join(sanitizedIdentifier, uniqueFilename) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-attachment', async (event, relativePath) => {
  try {
    const filePath = path.join(attachmentsDir, relativePath);
    const data = fs.readFileSync(filePath);
    return { success: true, data: data.buffer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-attachment', async (event, relativePath) => {
  try {
    const filePath = path.join(attachmentsDir, relativePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('list-attachments', async (event, identifier) => {
  try {
    const sanitizedIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
    const recordDir = path.join(attachmentsDir, sanitizedIdentifier);
    
    if (!fs.existsSync(recordDir)) {
      return { success: true, files: [] };
    }
    
    const files = fs.readdirSync(recordDir);
    return { success: true, files };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// List ALL attachments recursively (for backup)
ipcMain.handle('list-all-attachments', async () => {
  try {
    const result = [];
    
    if (!fs.existsSync(attachmentsDir)) {
      return { success: true, files: [] };
    }
    
    // Get all subdirectories (record identifiers)
    const entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(attachmentsDir, entry.name);
        const files = fs.readdirSync(subDir);
        
        for (const file of files) {
          // Return relative paths like "identifier/filename.ext"
          result.push(path.join(entry.name, file));
        }
      }
    }
    
    return { success: true, files: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Write attachment from backup (for restore)
ipcMain.handle('write-attachment', async (event, { relativePath, data }) => {
  try {
    // Security: Validate relative path doesn't contain path traversal
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
      return { success: false, error: 'Invalid relative path' };
    }
    
    const filePath = path.join(attachmentsDir, relativePath);
    
    // Security: Ensure resolved path is within attachmentsDir
    const resolvedPath = path.resolve(filePath);
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);
    if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep) && resolvedPath !== resolvedAttachmentsDir) {
      return { success: false, error: 'Path traversal detected' };
    }
    
    const dir = path.dirname(filePath);
    
    // Create directory if needed
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================================================
// TOR PROXY IPC HANDLERS
// ============================================================================

// Test Tor connection
ipcMain.handle('tor-test', async (event, { torProxyUrl }) => {
  const proxiesToTest = [
    { name: "Tor Browser", url: TOR_BROWSER_PROXY },
    { name: "Tor Service", url: DEFAULT_TOR_PROXY },
  ];

  if (torProxyUrl) {
    proxiesToTest.unshift({ name: "Custom", url: torProxyUrl });
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

// Proxy a request through Tor
ipcMain.handle('tor-request', async (event, { url: requestUrl, method, headers, body, timeout, torProxyUrl, allowedHost }) => {
  if (!requestUrl) {
    return { success: false, error: "URL is required" };
  }

  // Validate URL to prevent SSRF attacks
  const urlCheck = isAllowedUrl(requestUrl, allowedHost);
  if (!urlCheck.allowed) {
    return { success: false, error: urlCheck.reason || "URL not allowed" };
  }

  return await makeProxiedRequest({
    url: requestUrl,
    method,
    headers,
    body,
    timeout,
    torProxyUrl,
  });
});

// Get Tor status
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

// Security: Set Content Security Policy
app.whenReady().then(() => {
  // Set CSP headers for production
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "connect-src 'self' https://mempool.space https://blockstream.info",
          ].join('; ')
        }
      });
    });
  }
  
  createWindow();
  
  // ============================================================================
  // SLEEP/WAKE HANDLING - Prevent crash when computer sleeps/wakes
  // ============================================================================
  
  // Handle system suspend (going to sleep)
  powerMonitor.on('suspend', () => {
    console.log('[KYUTXO] System suspending (going to sleep)');
  });
  
  // Handle system resume (waking up) - reload window to prevent grey screen/crash
  powerMonitor.on('resume', () => {
    console.log('[KYUTXO] System resumed from sleep');
    // Give the system a moment to stabilize after wake, then reload
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[KYUTXO] Reloading window after resume');
        mainWindow.reload();
      }
    }, 1000);
  });
  
  // Handle screen lock (optional logging)
  powerMonitor.on('lock-screen', () => {
    console.log('[KYUTXO] Screen locked');
  });
  
  // Handle screen unlock
  powerMonitor.on('unlock-screen', () => {
    console.log('[KYUTXO] Screen unlocked');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  // Block new windows
  contents.setWindowOpenHandler(({ url }) => {
    // Allow opening external links in default browser
    if (url.startsWith('https://mempool.space') || 
        url.startsWith('https://blockstream.info') ||
        url.startsWith('https://')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Prevent navigation to external sites
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    // Only allow navigation to the app's own pages
    if (parsedUrl.origin !== 'http://localhost:5000' && 
        !parsedUrl.protocol.startsWith('file')) {
      event.preventDefault();
    }
  });

  // Disable webview creation
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
  });
});

// Security: Disable remote module (deprecated but ensure it's off)
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
