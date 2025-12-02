const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// Determine if running in development or production
const isDev = process.env.NODE_ENV === 'development';

// Portable mode detection:
// If a 'portable' file/folder exists next to the executable, use portable mode
// This allows running from USB drives with all data stored alongside the app
function isPortableMode() {
  if (isDev) return false;
  
  const exePath = app.getPath('exe');
  const exeDir = path.dirname(exePath);
  const portableMarker = path.join(exeDir, 'portable');
  const portableDataDir = path.join(exeDir, 'KYUTXO_Data');
  
  return fs.existsSync(portableMarker) || fs.existsSync(portableDataDir);
}

// Get data directory based on portable mode
function getDataDirectory() {
  if (isPortableMode()) {
    const exeDir = path.dirname(app.getPath('exe'));
    return path.join(exeDir, 'KYUTXO_Data');
  }
  return path.join(app.getPath('userData'), 'data');
}

const portableMode = isPortableMode();
const dataDir = getDataDirectory();
const attachmentsDir = path.join(dataDir, 'attachments');

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
    // Vite builds to dist/public/ (see vite.config.ts outDir)
    const indexPath = path.join(__dirname, '../dist/public/index.html');
    if (fs.existsSync(indexPath)) {
      mainWindow.loadFile(indexPath);
    } else {
      // Fallback to packaged location
      mainWindow.loadFile(path.join(process.resourcesPath, 'dist/public/index.html'));
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
    
    const filePath = path.join(recordDir, filename);
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    
    return { success: true, path: path.join(sanitizedIdentifier, filename) };
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
