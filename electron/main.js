// Desktop app: runs the same server as `npm start` and shows it in its own window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { startServer } from '../server/index.js';
import { initUpdater } from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// A fixed port keeps the page's origin stable, so its saved appearance (localStorage)
// survives restarts. If it's taken, the server tries the next few ports.
const PREFERRED_PORT = 47615;

// Where things live:
//   installed app      library + Electron files in %APPDATA%\Word Collector,
//                      automatic backups in Documents\Word Collector Backups
//   npm run desktop    library in the project's data/ (same as `npm start`), Electron files
//                      in %APPDATA%\Word Collector (dev), backups in data/backups
//   WORDCOLLECTOR_DATA_DIR  everything in that folder (for tests)
// So development and test runs never touch the installed app's library, window state,
// browser storage or backups, and don't block it from starting.
const TEST_DIR = process.env.WORDCOLLECTOR_DATA_DIR;
if (TEST_DIR) {
  app.setPath('userData', path.join(TEST_DIR, 'electron'));
} else if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Word Collector (dev)'));
}
const dataDir = TEST_DIR || (app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data'));
const backupDir = app.isPackaged && !TEST_DIR
  ? path.join(app.getPath('documents'), 'Word Collector Backups')
  : path.join(dataDir, 'backups');
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let serverUrl = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    return { width: state.width, height: state.height, x: state.x, y: state.y, maximized: state.maximized };
  } catch {
    return { width: 1200, height: 820 };
  }
}

function saveWindowState(win) {
  try {
    const bounds = win.getNormalBounds();
    fs.mkdirSync(path.dirname(windowStateFile), { recursive: true });
    fs.writeFileSync(windowStateFile, JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch { /* not critical */ }
}

const isExternal = (url) => /^https?:\/\//i.test(url) && !url.startsWith(serverUrl);

// Settings → Backups: pick a folder, or open the backup folder in Explorer.
ipcMain.handle('backups:choose-folder', async (_event, current) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for automatic backups',
    defaultPath: current || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('backups:open-folder', async (_event, folder) => {
  if (typeof folder !== 'string' || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return false;
  return (await shell.openPath(folder)) === '';
});

async function start() {
  let url;
  try {
    ({ url } = await startServer({ port: PREFERRED_PORT, dataDir, backupDir }));
  } catch (err) {
    // E.g. an upgrade of the library failed. A copy taken just before is in the backups.
    dialog.showErrorBox('Word Collector couldn’t open your library',
      `${err.message}\n\nYour library hasn’t been changed. Backups are in:\n${backupDir}`);
    app.quit();
    return;
  }
  serverUrl = url;

  const state = readWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 380,
    minHeight: 500,
    title: 'Word Collector',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#F5F4EE',
    icon: app.isPackaged ? undefined : path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (state.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links to Merriam-Webster and the like open in the normal browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(serverUrl)) return;
    event.preventDefault();
    if (isExternal(target)) shell.openExternal(target);
  });

  // Register the update handlers before the page loads, since it asks for their state at once.
  initUpdater(() => mainWindow);
  await mainWindow.loadURL(serverUrl);
}
