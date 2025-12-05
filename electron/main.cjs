const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// Determine if running in development or production
const isDev = process.env.NODE_ENV === 'development';

// Portable mode detection:
// electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds
// Also check for 'portable' marker file or KYUTXO_Data folder next to executable
function getPortableDir() {
  // electron-builder portable mode sets this env var to the folder containing the .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  
  // Fallback: check next to the executable
  try {
    const exePath = app.getPath('exe');
    return path.dirname(exePath);
  } catch (e) {
    return null;
  }
}

function isPortableMode() {
  if (isDev) return false;
  
  // Check for electron-builder's portable mode env var
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    console.log('[KYUTXO] Portable mode detected via PORTABLE_EXECUTABLE_DIR:', process.env.PORTABLE_EXECUTABLE_DIR);
    return true;
  }
  
  // Fallback: check for marker file or data directory
  const portableDir = getPortableDir();
  if (!portableDir) return false;
  
  const portableMarker = path.join(portableDir, 'portable');
  const portableDataDir = path.join(portableDir, 'KYUTXO_Data');
  
  const hasMarker = fs.existsSync(portableMarker);
  const hasDataDir = fs.existsSync(portableDataDir);
  
  if (hasMarker || hasDataDir) {
    console.log('[KYUTXO] Portable mode detected via marker/data folder in:', portableDir);
    return true;
  }
  
  return false;
}

// Get data directory based on portable mode
function getDataDirectory() {
  if (isPortableMode()) {
    const portableDir = getPortableDir();
    const dataPath = path.join(portableDir, 'KYUTXO_Data');
    console.log('[KYUTXO] Using portable data directory:', dataPath);
    return dataPath;
  }
  const userDataPath = path.join(app.getPath('userData'), 'data');
  console.log('[KYUTXO] Using standard data directory:', userDataPath);
  return userDataPath;
}

// These must be initialized after app is ready for accurate paths
let portableMode = false;
let dataDir = '';
let attachmentsDir = '';

// Ensure data directories exist
function ensureDirectories() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }
}

function initializePaths() {
  portableMode = isPortableMode();
  dataDir = getDataDirectory();
  attachmentsDir = path.join(dataDir, 'attachments');
  console.log('[KYUTXO] Paths initialized - Portable:', portableMode, 'Data:', dataDir, 'Attachments:', attachmentsDir);
}

function createWindow() {
  initializePaths();
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
    // Use app.getAppPath() for correct path in packaged apps
    const appPath = app.getAppPath();
    const indexPath = path.join(appPath, 'dist', 'public', 'index.html');
    
    if (fs.existsSync(indexPath)) {
      mainWindow.loadFile(indexPath);
    } else {
      // Fallback: try resources path
      const resourcePath = path.join(process.resourcesPath, 'app', 'dist', 'public', 'index.html');
      if (fs.existsSync(resourcePath)) {
        mainWindow.loadFile(resourcePath);
      }
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
