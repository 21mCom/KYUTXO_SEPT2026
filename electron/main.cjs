const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

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
    // In production, load the built files
    const appPath = app.getAppPath();
    console.log('[KYUTXO] App path:', appPath);
    console.log('[KYUTXO] __dirname:', __dirname);
    console.log('[KYUTXO] resourcesPath:', process.resourcesPath);
    
    // Try multiple possible paths for the index.html
    const possiblePaths = [
      path.join(appPath, 'dist', 'public', 'index.html'),
      path.join(__dirname, '..', 'dist', 'public', 'index.html'),
      path.join(process.resourcesPath, 'app', 'dist', 'public', 'index.html'),
      path.join(process.resourcesPath, 'app.asar', 'dist', 'public', 'index.html'),
    ];
    
    let loaded = false;
    for (const indexPath of possiblePaths) {
      console.log('[KYUTXO] Trying path:', indexPath, '- exists:', fs.existsSync(indexPath));
      if (fs.existsSync(indexPath)) {
        console.log('[KYUTXO] Loading from:', indexPath);
        mainWindow.loadFile(indexPath);
        loaded = true;
        break;
      }
    }
    
    if (!loaded) {
      console.error('[KYUTXO] Could not find index.html in any of the expected paths');
      mainWindow.loadURL(`data:text/html,
        <html>
          <body style="background:#1a1a2e;color:white;font-family:sans-serif;padding:40px;">
            <h1>Error Loading KYUTXO</h1>
            <p>Could not find the application files.</p>
            <p>Searched paths:</p>
            <ul>${possiblePaths.map(p => `<li>${p}</li>`).join('')}</ul>
            <p>App path: ${appPath}</p>
            <p>Resources path: ${process.resourcesPath}</p>
          </body>
        </html>
      `);
    }
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
