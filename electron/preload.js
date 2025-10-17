const { contextBridge, ipcRenderer } = require('electron');

// Güvenli API'yi renderer process'e expose et
contextBridge.exposeInMainWorld('electronAPI', {
  // Server kontrolü
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getServerHealth: () => ipcRenderer.invoke('get-server-health'),
  
  // Redis kontrolü
  startRedis: () => ipcRenderer.invoke('start-redis'),
  stopRedis: () => ipcRenderer.invoke('stop-redis'),
  getRedisStatus: () => ipcRenderer.invoke('get-redis-status'),
  
  // Diagnostic bilgileri
  getDiagnosticInfo: () => ipcRenderer.invoke('get-diagnostic-info'),
  
  // SSL Sertifika yönetimi
  saveSSLSettings: (settings) => ipcRenderer.invoke('save-ssl-settings', settings),
  loadSSLSettings: () => ipcRenderer.invoke('load-ssl-settings'),
  selectCertificateFolder: () => ipcRenderer.invoke('select-certificate-folder'),
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
  
  // Otomatik başlatma
  setAutoStart: (enable) => ipcRenderer.invoke('set-auto-start', enable),
  checkAutoStart: () => ipcRenderer.invoke('check-auto-start'),
  
  // Dialog'lar
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  
  // Event listeners
  onServerStatus: (callback) => {
    ipcRenderer.on('server-status', (event, data) => callback(data));
  },
  onServerLog: (callback) => {
    ipcRenderer.on('server-log', (event, data) => callback(data));
  },
  onServerError: (callback) => {
    ipcRenderer.on('server-error', (event, data) => callback(data));
  },
  onRedisStatus: (callback) => {
    ipcRenderer.on('redis-status', (event, data) => callback(data));
  },
  onRedisLog: (callback) => {
    ipcRenderer.on('redis-log', (event, data) => callback(data));
  },
  onRedisError: (callback) => {
    ipcRenderer.on('redis-error', (event, data) => callback(data));
  },
  onShowSettings: (callback) => {
    ipcRenderer.on('show-settings', () => callback());
  },
  
  // Event listener'ları temizle
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

// Platform bilgisi
contextBridge.exposeInMainWorld('platform', {
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  isLinux: process.platform === 'linux',
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron
});

// Uygulama bilgileri
contextBridge.exposeInMainWorld('appInfo', {
  name: 'SCADA Cloud Bridge Server',
  version: '2.0.0',
  description: 'SCADA yazılımları ve mobile uygulamalar arasında köprü kuran yüksek performanslı server'
});