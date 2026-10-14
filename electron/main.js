// Desktop app: runs the same server as `npm start` and shows it in its own window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { startServer } from '../server/index.js';
import { initUpdater } from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// A fixed port keeps the page's origin stable, so its saved appearance (localStorage)
// survives restarts. If it's taken, the server tries the next few ports.
const PREFERRED_PORT = 47615;

// Installed app: data in the user's app-data folder. `npm run desktop` while developing:
// the project's data/ folder, the same library as `npm start`. WORDCOLLECTOR_DATA_DIR
// overrides both (handy for testing with a throwaway library).
const dataDir = process.env.WORDCOLLECTOR_DATA_DIR
  || (app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data'));
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

async function start() {
  const { url } = await startServer({ port: PREFERRED_PORT, dataDir });
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
