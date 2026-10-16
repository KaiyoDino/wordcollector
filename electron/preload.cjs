// Exposes a small, fixed API to the page for app updates and the backup folder. The page
// gets no other access to Electron or Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getUpdateState: () => ipcRenderer.invoke('update:get'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  chooseBackupFolder: (current) => ipcRenderer.invoke('backups:choose-folder', current),
  openBackupFolder: (folder) => ipcRenderer.invoke('backups:open-folder', folder),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
});
