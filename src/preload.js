const { contextBridge, ipcRenderer } = require('electron');
const crypto = require('crypto');

contextBridge.exposeInMainWorld('tech', {
  latestFirmware: () => ipcRenderer.invoke('fw:latest'),
  firmwareBytes: () => ipcRenderer.invoke('fw:bytes'),
  recoveryFiles: () => ipcRenderer.invoke('recovery:files'),
  lanList: () => ipcRenderer.invoke('lan:list'),
  lanQuery: ip => ipcRenderer.invoke('lan:query', ip),
  appVersion: () => ipcRenderer.invoke('app:version'),
  saveReport: (suggestedName, text) => ipcRenderer.invoke('report:save', { suggestedName, text }),
  updateReady: () => ipcRenderer.invoke('app:update-ready'),
  onUpdateReady: fn => ipcRenderer.on('app:update-ready', (e, v) => fn(v)),
  installUpdate: () => ipcRenderer.send('app:install-update'),
  setBusy: v => ipcRenderer.send('busy', !!v),
  choosePort: id => ipcRenderer.send('serial:chosen', id),
  onLanUpdate: fn => ipcRenderer.on('lan:update', (e, list) => fn(list)),
  onChoosePort: fn => ipcRenderer.on('serial:choose', (e, list) => fn(list)),
  // The flasher compares this with the checksum the chip computes after writing.
  md5: bytes => crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex'),
});
