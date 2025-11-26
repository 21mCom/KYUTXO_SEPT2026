const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// Determine if running in development or production
const isDev = process.env.NODE_ENV === 'development';

// Get app data directory for storing files
const appDataPath = app.getPath('userData');
const dataDir = path.join(appDataPath, 'data');
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
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../public/icon.png'),
    title: 'KYBTC - Bitcoin Metadata Manager',
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
    const indexPath = path.join(__dirname, '../dist/client/index.html');
    if (fs.existsSync(indexPath)) {
      mainWindow.loadFile(indexPath);
    } else {
      // Fallback to packaged location
      mainWindow.loadFile(path.join(process.resourcesPath, 'dist/client/index.html'));
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handle file operations via IPC
ipcMain.handle('get-app-data-path', () => {
  return appDataPath;
});

ipcMain.handle('get-attachments-path', () => {
  return attachmentsDir;
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

app.whenReady().then(createWindow);

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

// Security: prevent navigation to external sites
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    // Only allow navigation to the app's own pages
    if (parsedUrl.origin !== 'http://localhost:5000' && 
        !parsedUrl.protocol.startsWith('file')) {
      event.preventDefault();
    }
  });
});
