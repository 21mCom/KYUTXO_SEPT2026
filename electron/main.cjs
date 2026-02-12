const { app, BrowserWindow, protocol, ipcMain, session, powerMonitor, Menu } = require('electron');
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

// Cache the last detected working Tor proxy to avoid repeated detection
let cachedWorkingProxy = null;
let cacheTimestamp = 0;
const PROXY_CACHE_DURATION = 60000; // 1 minute cache

// Quick test if a proxy is reachable (doesn't verify it's Tor, just that it accepts connections)
async function isProxyReachable(proxyUrl, timeoutMs = 5000) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const fetch = await getFetch();
  
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // Just try to connect - any response means the proxy is working
    const response = await fetch('https://check.torproject.org/api/ip', {
      signal: controller.signal,
      agent,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Auto-detect working Tor proxy, trying Tor Browser first
async function detectWorkingTorProxy() {
  const now = Date.now();
  
  // Return cached result if still valid
  if (cachedWorkingProxy && (now - cacheTimestamp) < PROXY_CACHE_DURATION) {
    return cachedWorkingProxy;
  }
  
  // Try Tor Browser first (port 9150), then Tor service (port 9050)
  if (await isProxyReachable(TOR_BROWSER_PROXY, 3000)) {
    cachedWorkingProxy = TOR_BROWSER_PROXY;
    cacheTimestamp = now;
    console.log('[KYUTXO] Auto-detected Tor Browser proxy at port 9150');
    return TOR_BROWSER_PROXY;
  }
  
  if (await isProxyReachable(DEFAULT_TOR_PROXY, 3000)) {
    cachedWorkingProxy = DEFAULT_TOR_PROXY;
    cacheTimestamp = now;
    console.log('[KYUTXO] Auto-detected Tor service at port 9050');
    return DEFAULT_TOR_PROXY;
  }
  
  // No proxy found - return default and let it fail with a clear error
  console.log('[KYUTXO] No Tor proxy detected, using default 9050');
  return DEFAULT_TOR_PROXY;
}

// Allowed hostnames for Bitcoin API requests - prevents SSRF attacks
const ALLOWED_API_HOSTS = [
  "mempool.space",
  "blockstream.info",
  "check.torproject.org",
];

// Check if a hostname matches private/local IP patterns
function isPrivateAddress(hostname) {
  const privatePatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,
    /\.local$/i,  // mDNS local domains
  ];
  return privatePatterns.some(p => p.test(hostname));
}

function isAllowedUrl(urlString, additionalAllowedHost, trustedLocalHosts = []) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    
    // Allow .onion addresses (Tor hidden services)
    if (hostname.endsWith('.onion')) {
      return { allowed: true };
    }
    
    // Check if this is a private/local address
    const isPrivate = isPrivateAddress(hostname);
    
    if (isPrivate) {
      // For private addresses, check against trusted local hosts whitelist
      if (trustedLocalHosts && trustedLocalHosts.length > 0) {
        const isTrusted = trustedLocalHosts.some(trusted => {
          const trustedLower = trusted.toLowerCase();
          return hostname === trustedLower || 
                 hostname.startsWith(trustedLower + ':') ||
                 // Allow if the trusted host is a prefix (e.g., "192.168.1" matches "192.168.1.50")
                 hostname.startsWith(trustedLower + '.');
        });
        
        if (isTrusted) {
          console.log(`[KYUTXO] Allowing trusted local host: ${hostname}`);
          return { allowed: true, isLocal: true };
        }
      }
      
      return { 
        allowed: false, 
        reason: `Local address '${hostname}' is not in your trusted hosts whitelist. Add it in Node Settings → Trusted Local Hosts.` 
      };
    }
    
    // For public addresses, check against allowed API hosts
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (additionalAllowedHost) {
      try {
        const additionalParsed = new URL(additionalAllowedHost);
        const additionalHostname = additionalParsed.hostname.toLowerCase();
        if (!isPrivateAddress(additionalHostname)) {
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
  
  // Use provided proxy URL, or auto-detect if not specified
  const proxyUrl = requestParams.torProxyUrl || await detectWorkingTorProxy();
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

  // Enable right-click context menu with Cut/Copy/Paste and spelling suggestions
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menuItems = [];
    
    // Add spelling suggestions if word is misspelled
    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      params.dictionarySuggestions.forEach((suggestion) => {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        });
      });
      menuItems.push({ type: 'separator' });
      
      // Add option to add word to dictionary
      menuItems.push({
        label: `Add "${params.misspelledWord}" to Dictionary`,
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      menuItems.push({ type: 'separator' });
    }
    
    // Standard editing options
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

// Make a direct HTTP request (no proxy) for trusted local hosts
async function makeDirectRequest(requestParams) {
  const fetch = await getFetch();
  const startTime = Date.now();
  const timeout = requestParams.timeout || 30000;

  console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest START - URL: ${requestParams.url}, timeout: ${timeout}ms`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`[KYUTXO] [${new Date().toISOString()}] TIMEOUT TRIGGERED after ${timeout}ms for: ${requestParams.url}`);
      controller.abort();
    }, timeout);

    // Add browser-like headers to help with nginx reverse proxies (like Umbrel's)
    const defaultHeaders = {
      'User-Agent': 'KYUTXO/1.2.1 (Electron)',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
    };

    const fetchOptions = {
      method: requestParams.method || "GET",
      headers: { ...defaultHeaders, ...requestParams.headers },
      signal: controller.signal,
    };
    
    if (requestParams.body) {
      fetchOptions.body = typeof requestParams.body === 'string' 
        ? requestParams.body 
        : JSON.stringify(requestParams.body);
    }

    console.log(`[KYUTXO] [${new Date().toISOString()}] Calling fetch() for: ${requestParams.url}`);
    const response = await fetch(requestParams.url, fetchOptions);
    console.log(`[KYUTXO] [${new Date().toISOString()}] fetch() returned - status: ${response.status}, elapsed: ${Date.now() - startTime}ms`);
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    let data;
    
    console.log(`[KYUTXO] [${new Date().toISOString()}] Reading response body - contentType: ${contentType}`);
    if (contentType.includes('application/json')) {
      data = await response.json();
      console.log(`[KYUTXO] [${new Date().toISOString()}] JSON parsed - items: ${Array.isArray(data) ? data.length : 'object'}, elapsed: ${Date.now() - startTime}ms`);
    } else {
      data = await response.text();
      console.log(`[KYUTXO] [${new Date().toISOString()}] Text read - length: ${data.length} chars, elapsed: ${Date.now() - startTime}ms`);
    }

    const latency = Date.now() - startTime;
    console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest SUCCESS - total latency: ${latency}ms`);

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        statusText: response.statusText,
        data,
        latency,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      data,
      latency,
      contentType,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error.name === 'AbortError') {
      console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest TIMEOUT - elapsed: ${latency}ms, URL: ${requestParams.url}`);
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000}s`,
        latency,
      };
    }
    
    console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest ERROR - ${error.message}, elapsed: ${latency}ms, URL: ${requestParams.url}`);
    return {
      success: false,
      error: error.message || "Direct request failed",
      latency,
    };
  }
}

// Proxy a request through Tor, or make direct request for trusted local hosts
ipcMain.handle('tor-request', async (event, { url: requestUrl, method, headers, body, timeout, torProxyUrl, allowedHost, trustedLocalHosts }) => {
  if (!requestUrl) {
    return { success: false, error: "URL is required" };
  }

  // Validate URL against allowlist (including trusted local hosts)
  const urlCheck = isAllowedUrl(requestUrl, allowedHost, trustedLocalHosts || []);
  if (!urlCheck.allowed) {
    return { success: false, error: urlCheck.reason || "URL not allowed" };
  }

  // For trusted local addresses, make a direct request (no Tor proxy needed)
  if (urlCheck.isLocal) {
    return await makeDirectRequest({
      url: requestUrl,
      method,
      headers,
      body,
      timeout,
    });
  }

  // For remote/public addresses, use Tor proxy
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

// ============================================================================
// ELECTRUM PROTOCOL SUPPORT - Connection Pooling
// ============================================================================
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// Connection pool with health tracking and request multiplexing
const electrumPool = {
  connections: new Map(), // key -> { socket, host, port, useSSL, lastUsed, healthy, pendingMap, buffer, dataHandler }
  keepaliveInterval: null,
  KEEPALIVE_INTERVAL: 30000, // Ping every 30 seconds
  CONNECTION_TIMEOUT: 60000, // Close idle connections after 60 seconds
  MAX_RETRIES: 2,
  requestIdCounter: 0,
};

// Start keepalive timer
function startKeepalive() {
  if (electrumPool.keepaliveInterval) return;
  
  electrumPool.keepaliveInterval = setInterval(async () => {
    const now = Date.now();
    
    for (const [key, conn] of electrumPool.connections.entries()) {
      // Close idle connections (no pending requests for >60s)
      if (now - conn.lastUsed > electrumPool.CONNECTION_TIMEOUT && conn.pendingMap.size === 0) {
        console.log(`[Electrum Pool] Closing idle connection: ${key}`);
        try { conn.socket.destroy(); } catch (e) {}
        electrumPool.connections.delete(key);
        continue;
      }
      
      // Ping active connections to keep them alive (only if no pending requests)
      if (conn.healthy && conn.pendingMap.size === 0) {
        try {
          await pooledRequest(key, 'server.ping', [], 5000);
          conn.lastUsed = Date.now();
        } catch (e) {
          console.log(`[Electrum Pool] Keepalive failed for ${key}: ${e.message}`);
          conn.healthy = false;
          try { conn.socket.destroy(); } catch (e) {}
          electrumPool.connections.delete(key);
        }
      }
    }
  }, electrumPool.KEEPALIVE_INTERVAL);
}

// Stop keepalive and close all connections
function stopKeepalive() {
  if (electrumPool.keepaliveInterval) {
    clearInterval(electrumPool.keepaliveInterval);
    electrumPool.keepaliveInterval = null;
  }
  
  for (const [key, conn] of electrumPool.connections.entries()) {
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      pending.reject(new Error('Connection pool shutting down'));
    }
    conn.pendingMap.clear();
    try { conn.socket.destroy(); } catch (e) {}
  }
  electrumPool.connections.clear();
}

// Setup multiplexed data handler for a connection
function setupMultiplexedHandler(conn, key) {
  conn.buffer = '';
  conn.pendingMap = new Map(); // id -> { resolve, reject, timeoutId }
  
  conn.dataHandler = (data) => {
    conn.buffer += data.toString();
    
    // Process newline-delimited JSON responses
    const lines = conn.buffer.split('\n');
    conn.buffer = lines[lines.length - 1]; // Keep incomplete line in buffer
    
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const response = JSON.parse(line);
        const id = response.id;
        
        if (id !== undefined && conn.pendingMap.has(id)) {
          const pending = conn.pendingMap.get(id);
          conn.pendingMap.delete(id);
          clearTimeout(pending.timeoutId);
          
          if (response.error) {
            pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (e) {
        // Invalid JSON, ignore
      }
    }
  };
  
  conn.socket.on('data', conn.dataHandler);
  
  conn.socket.on('error', (err) => {
    console.log(`[Electrum Pool] Socket error on ${key}: ${err.message}`);
    conn.healthy = false;
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Socket error: ${err.message}`));
    }
    conn.pendingMap.clear();
    electrumPool.connections.delete(key);
  });
  
  conn.socket.on('close', () => {
    console.log(`[Electrum Pool] Socket closed: ${key}`);
    // Reject all pending requests
    for (const [id, pending] of conn.pendingMap.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Socket closed'));
    }
    conn.pendingMap.clear();
    electrumPool.connections.delete(key);
  });
}

// Send a request on a multiplexed pooled connection
function pooledRequest(key, method, params = [], timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = electrumPool.connections.get(key);
    if (!conn || !conn.healthy || conn.socket.destroyed) {
      reject(new Error('Connection not available'));
      return;
    }
    
    const id = ++electrumPool.requestIdCounter;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    
    const timeoutId = setTimeout(() => {
      conn.pendingMap.delete(id);
      // Timeout indicates connection problems - mark unhealthy and close
      console.log(`[Electrum Pool] Request timeout on ${key}, marking connection unhealthy`);
      conn.healthy = false;
      try { conn.socket.destroy(); } catch (e) {}
      electrumPool.connections.delete(key);
      reject(new Error(`Request timeout after ${timeout/1000}s for ${method}`));
    }, timeout);
    
    conn.pendingMap.set(id, { resolve, reject, timeoutId });
    conn.lastUsed = Date.now();
    
    try {
      conn.socket.write(request);
    } catch (e) {
      conn.pendingMap.delete(id);
      clearTimeout(timeoutId);
      // Write error - mark unhealthy and close
      console.log(`[Electrum Pool] Write error on ${key}, marking connection unhealthy`);
      conn.healthy = false;
      try { conn.socket.destroy(); } catch (e2) {}
      electrumPool.connections.delete(key);
      reject(new Error(`Write error: ${e.message}`));
    }
  });
}

// Helper to create scripthash from address
function addressToScripthash(address) {
  // Import bitcoinjs-lib dynamically
  const bitcoin = require('bitcoinjs-lib');
  
  let scriptPubKey;
  try {
    // Decode the address to get the script
    const decoded = bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
    scriptPubKey = decoded;
  } catch (e) {
    // Try testnet
    try {
      const decoded = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
      scriptPubKey = decoded;
    } catch (e2) {
      throw new Error(`Invalid Bitcoin address: ${address}`);
    }
  }
  
  // SHA256 hash of the scriptPubKey, then reverse byte order
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  const reversed = Buffer.from(hash).reverse();
  return reversed.toString('hex');
}

// Clean host input - strip protocol prefixes and trailing slashes
// Electrum uses raw TCP, not HTTP - common mistake to include http://
function cleanElectrumHost(host) {
  if (!host) return host;
  let cleaned = host.trim();
  // Remove protocol prefixes (Electrum uses raw TCP, not HTTP)
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned;
}

// Create a fresh Electrum connection
function createElectrumConnection(host, port, useSSL, timeout = 30000) {
  const cleanedHost = cleanElectrumHost(host);
  
  return new Promise((resolve, reject) => {
    let socket;
    const connectOptions = { host: cleanedHost, port };
    
    console.log(`[Electrum Pool] Creating new connection to ${cleanedHost}:${port}`);
    
    if (useSSL) {
      socket = tls.connect({ ...connectOptions, rejectUnauthorized: false }, () => {
        if (!socket.authorized) {
          console.log('[Electrum Pool] TLS warning (self-signed cert accepted):', socket.authorizationError);
        }
        resolve(socket);
      });
    } else {
      socket = net.createConnection(connectOptions, () => {
        resolve(socket);
      });
    }
    
    socket.setTimeout(timeout);
    
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Connection timeout after ${timeout/1000}s`));
    });
    
    socket.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}`));
    });
  });
}

// Get or create a pooled connection with multiplexed request handling
async function getPooledConnection(host, port, useSSL, timeout = 30000) {
  const cleanedHost = cleanElectrumHost(host);
  const key = `${cleanedHost}:${port}`;
  
  // Check for existing healthy connection
  if (electrumPool.connections.has(key)) {
    const conn = electrumPool.connections.get(key);
    if (conn.healthy && conn.socket && !conn.socket.destroyed) {
      console.log(`[Electrum Pool] Reusing connection: ${key}`);
      conn.lastUsed = Date.now();
      return { key, pooled: true };
    } else {
      // Clean up unhealthy connection
      try { conn.socket.destroy(); } catch (e) {}
      electrumPool.connections.delete(key);
    }
  }
  
  // Create new connection
  console.log(`[Electrum Pool] Creating new connection: ${key}`);
  const socket = await createElectrumConnection(cleanedHost, port, useSSL, timeout);
  
  // Store in pool with multiplexed handler
  const conn = {
    socket,
    host: cleanedHost,
    port,
    useSSL,
    lastUsed: Date.now(),
    healthy: true,
    versionSent: false,
  };
  
  electrumPool.connections.set(key, conn);
  
  // Setup multiplexed data handler (handles error/close events too)
  setupMultiplexedHandler(conn, key);
  
  // Start keepalive timer if not running
  startKeepalive();
  
  return { key, pooled: false };
}

// Send server.version handshake only once per connection
async function ensureVersionHandshake(key, timeout = 15000) {
  const conn = electrumPool.connections.get(key);
  if (!conn) throw new Error('Connection not available');
  
  if (!conn.versionSent) {
    const version = await pooledRequest(key, 'server.version', ['KYUTXO', '1.4'], timeout);
    conn.versionSent = true;
    return version;
  }
  
  // Already sent version, just ping to verify connection is alive
  await pooledRequest(key, 'server.ping', [], timeout);
  return conn.cachedVersion || ['unknown', '1.4'];
}

// Electrum connection test (creates fresh connection to test connectivity)
ipcMain.handle('electrum-test', async (event, { host, port, useSSL, timeout }) => {
  const startTime = Date.now();
  const cleanedHost = cleanElectrumHost(host);
  
  try {
    // Get or create pooled connection
    const { key, pooled } = await getPooledConnection(cleanedHost, port, useSSL, timeout || 15000);
    
    // Send server.version only on fresh connections, ping on reused ones
    const version = await ensureVersionHandshake(key, timeout || 15000);
    
    // Cache version for future reuse
    const conn = electrumPool.connections.get(key);
    if (conn) conn.cachedVersion = version;
    
    // Get block height to verify full functionality
    const headerResult = await pooledRequest(key, 'blockchain.headers.subscribe', [], timeout || 15000);
    const blockHeight = headerResult?.height || headerResult?.block_height;
    
    const latency = Date.now() - startTime;
    
    return {
      success: true,
      serverVersion: Array.isArray(version) ? version.join(' ') : String(version),
      blockHeight,
      latency,
      message: `Connected to Electrum server (${Array.isArray(version) ? version[0] : version})`,
      connectionPooled: pooled,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    // If test fails, destroy the pooled connection so next attempt starts fresh
    const key = `${cleanedHost}:${port}`;
    const conn = electrumPool.connections.get(key);
    if (conn) {
      try { conn.socket.destroy(); } catch (e) {}
      electrumPool.connections.delete(key);
    }
    return {
      success: false,
      error: error.message,
      latency,
    };
  }
});

// Get address history (transactions) via Electrum - uses connection pool
ipcMain.handle('electrum-get-history', async (event, { host, port, useSSL, address, timeout }) => {
  try {
    const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
    await ensureVersionHandshake(key, timeout || 15000);
    
    const scripthash = addressToScripthash(address);
    const history = await pooledRequest(key, 'blockchain.scripthash.get_history', [scripthash], timeout || 30000);
    
    return {
      success: true,
      history: history || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      history: [],
    };
  }
});

// Get address UTXOs via Electrum - uses connection pool
ipcMain.handle('electrum-get-utxos', async (event, { host, port, useSSL, address, timeout }) => {
  try {
    const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
    await ensureVersionHandshake(key, timeout || 15000);
    
    const scripthash = addressToScripthash(address);
    const utxos = await pooledRequest(key, 'blockchain.scripthash.listunspent', [scripthash], timeout || 30000);
    
    return {
      success: true,
      utxos: utxos || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      utxos: [],
    };
  }
});

// Get transaction details via Electrum - uses connection pool
ipcMain.handle('electrum-get-transaction', async (event, { host, port, useSSL, txid, verbose, timeout }) => {
  try {
    const { key } = await getPooledConnection(host, port, useSSL, timeout || 30000);
    await ensureVersionHandshake(key, timeout || 15000);
    
    const tx = await pooledRequest(key, 'blockchain.transaction.get', [txid, verbose !== false], timeout || 30000);
    
    return {
      success: true,
      transaction: tx,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// Batch get history for multiple addresses - uses connection pool with multiplexing
ipcMain.handle('electrum-batch-get-history', async (event, { host, port, useSSL, addresses, timeout }) => {
  const startTime = Date.now();
  
  try {
    const { key, pooled } = await getPooledConnection(host, port, useSSL, timeout || 60000);
    await ensureVersionHandshake(key, timeout || 15000);
    
    console.log(`[Electrum Pool] Batch fetching ${addresses.length} addresses (connection ${pooled ? 'reused' : 'new'})`);
    
    const results = [];
    
    for (const address of addresses) {
      try {
        const scripthash = addressToScripthash(address);
        const history = await pooledRequest(key, 'blockchain.scripthash.get_history', [scripthash], timeout || 30000);
        results.push({
          address,
          success: true,
          history: history || [],
        });
      } catch (err) {
        results.push({
          address,
          success: false,
          error: err.message,
          history: [],
        });
      }
    }
    
    const latency = Date.now() - startTime;
    
    return {
      success: true,
      results,
      latency,
      addressCount: addresses.length,
      connectionReused: pooled,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      results: [],
      latency: Date.now() - startTime,
    };
  }
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

// Cleanup Electrum connection pool on quit
app.on('before-quit', () => {
  console.log('[Electrum Pool] Cleaning up connections before quit');
  stopKeepalive();
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
