// Automatic updates from this repo's GitHub Releases (see `npm run release`).
// The installed app checks at startup and every few hours, downloads new versions in
// the background, and installs them when you restart (or the next time you quit).
import { app, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function initUpdater(getWindow) {
  let state = { status: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };

  const update = (patch) => {
    state = { ...state, ...patch };
    getWindow()?.webContents.send('update:state', state);
  };

  async function check() {
    if (!app.isPackaged) return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      update({ status: 'error', message: err.message });
    }
    return state;
  }

  ipcMain.handle('update:get', () => state);
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => {
    if (state.status === 'downloaded') autoUpdater.quitAndInstall();
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // For testing the update flow against a local folder instead of GitHub Releases.
  if (process.env.WORDCOLLECTOR_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.WORDCOLLECTOR_UPDATE_URL });
  }
  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'downloaded') update({ status: 'checking' });
  });
  autoUpdater.on('update-not-available', () => update({ status: 'up-to-date', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => update({ status: 'downloading', available: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => update({ percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => update({ status: 'downloaded', available: info.version }));
  autoUpdater.on('error', (err) => {
    // Nothing released yet isn't a problem worth flagging.
    if (/No published versions|latest\.yml.*404|HttpError: 404/i.test(String(err?.message))) {
      update({ status: 'up-to-date', checkedAt: Date.now() });
    } else {
      update({ status: 'error', message: friendlyError(err) });
    }
  });

  check();
  setInterval(check, CHECK_EVERY_MS);
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return 'No internet connection';
  return msg.split('\n')[0].slice(0, 200);
}
