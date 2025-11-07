const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const os = require('os');

// Sunucu ortamı için performans ve uyumluluk parametreleri
// Windows Server ve RDP oturumlarında grafik sorunlarını çözen gerekli ayarlar
app.disableHardwareAcceleration(); // Donanım hızlandırmayı tamamen devre dışı bırak - çok önemli
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('no-zygote');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-gl-drawing-for-tests'); // WebGL sorunlarını önle
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Hata yakalama ve loglama
process.on('uncaughtException', (err) => {
  console.error('Yakalanmayan istisna:', err);
  
  // Hata logu dosyasına yaz (sorun tespiti için)
  try {
    const logPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'error.log')
      : path.join(__dirname, '..', 'error.log');
    
    fs.appendFileSync(logPath, `${new Date().toISOString()} - Hata: ${err.message}\nYığın: ${err.stack}\n\n`);
  } catch (logErr) {
    console.error('Hata logu yazılamadı:', logErr);
  }
});

// Electron uygulaması için genel değişkenler
let mainWindow;
let serverProcess = null;
let redisProcess = null;
let isServerRunning = false;
let isRedisRunning = false;

// Uygulama ayarları - dinamik yol belirleme
function getAppConfig() {
  if (app.isPackaged) {
    return {
      serverScript: path.join(process.resourcesPath, 'app.asar.unpacked', 'server-optimized.js'),
      redisPath: path.join(process.resourcesPath, 'redis', 'redis-server.exe'),
      redisConfig: path.join(process.resourcesPath, 'redis', 'redis.conf'),
      serverPort: process.env.HTTPS_PORT || 443,
      redisPort: process.env.REDIS_PORT || 6379,
      isDev: false
    };
  } else {
    return {
      serverScript: path.join(__dirname, '..', 'server-optimized.js'),
      redisPath: path.join(__dirname, '..', 'redis', 'redis-server.exe'),
      redisConfig: path.join(__dirname, '..', 'redis', 'redis.conf'),
      serverPort: process.env.HTTPS_PORT || 443,
      redisPort: process.env.REDIS_PORT || 6379,
      isDev: process.env.NODE_ENV === 'development'
    };
  }
}

const APP_CONFIG = getAppConfig();

// Ana pencereyi oluştur
function createWindow() {
  try {
    console.log('Pencere oluşturuluyor...');
    
    // Electron BrowserWindow seçenekleri
    const windowOptions = {
      width: 1200,
      height: 800,
      minWidth: 1000,
      minHeight: 600,
      backgroundColor: '#ffffff',
      show: false, // Başlangıçta gizli, hazır olunca göster
      frame: true,
      autoHideMenuBar: false, // Menü çubuğunu göster (Windows Server'da daha iyi çalışır)
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
        devTools: APP_CONFIG.isDev, // Sadece dev modunda DevTools etkin olsun
        spellcheck: false, // Gereksiz özellikleri kapat
        webgl: false, // Windows Server'da WebGL sorunlarını önle
      }
    };
    
    console.log('BrowserWindow seçenekleri hazırlandı');
    
    // BrowserWindow oluştur
    mainWindow = new BrowserWindow(windowOptions);
    console.log('BrowserWindow başarıyla oluşturuldu');
    
    // Hata izleme
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error(`Sayfa yükleme hatası: ${errorDescription} (${errorCode})`);
      
      // 3 saniye sonra yeniden yüklemeyi dene
      setTimeout(() => {
        if (mainWindow) {
          console.log('Sayfa yeniden yükleniyor...');
          mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        }
      }, 3000);
    });
    
    // Crashleri izle
    mainWindow.webContents.on('crashed', (event) => {
      console.error('Renderer process çöktü!');
      
      // Pencereyi yeniden oluştur
      if (mainWindow) {
        mainWindow.destroy();
        setTimeout(createWindow, 1000);
      }
    });
    
    // HTML dosyasını yükle
    console.log('HTML dosyası yükleniyor...');
    
    // Eğer autostart ile başlatıldıysa, renderer'a bildir
    const args = process.argv;
    const isAutoStart = args.includes('--autostart');
    
    if (isAutoStart) {
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
            query: { autostart: 'true' }
        });
    } else {
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    }

    // Pencere hazır olduğunda göster
    mainWindow.once('ready-to-show', () => {
      console.log('Pencere hazır, gösteriliyor...');
      mainWindow.show();
      
      // Development modunda DevTools'u aç
      if (APP_CONFIG.isDev) {
        mainWindow.webContents.openDevTools();
      }
    });

    // Pencere kapatıldığında
    mainWindow.on('closed', () => {
      console.log('Pencere kapatıldı');
      mainWindow = null;
    });

    // External linkleri varsayılan tarayıcıda aç
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    
  } catch (error) {
    console.error('Pencere oluşturma hatası:', error);
    
    // Hata logu dosyasına yaz
    try {
      const logPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'window-error.log')
        : path.join(__dirname, '..', 'window-error.log');
      
      fs.appendFileSync(logPath, `${new Date().toISOString()} - Pencere hatası: ${error.message}\nYığın: ${error.stack}\n\n`);
    } catch (logErr) {
      console.error('Hata logu yazılamadı:', logErr);
    }
    
    // 5 saniye sonra yeniden deneme
    console.log('5 saniye sonra pencere oluşturma yeniden denenecek...');
    setTimeout(() => {
      try {
        createWindow();
      } catch (retryError) {
        console.error('Pencere oluşturma yeniden deneme hatası:', retryError);
      }
    }, 5000);
  }
}

// Uygulama menüsünü oluştur
function createMenu() {
  const template = [
    {
      label: 'Dosya',
      submenu: [
        {
          label: 'Ayarlar',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('show-settings');
          }
        },
        { type: 'separator' },
        {
          label: 'Çıkış',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Server\'ı Başlat',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            startServer();
          }
        },
        {
          label: 'Server\'ı Durdur',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            stopServer();
          }
        }
      ]
    },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload', label: 'Yenile' },
        { role: 'forceReload', label: 'Zorla Yenile' },
        { role: 'toggleDevTools', label: 'Geliştirici Araçları' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom Sıfırla' },
        { role: 'zoomIn', label: 'Yakınlaştır' },
        { role: 'zoomOut', label: 'Uzaklaştır' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tam Ekran' }
      ]
    },
    {
      label: 'Yardım',
      submenu: [
        {
          label: 'Hakkında',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Hakkında',
              message: 'SCADA Cloud Bridge Server',
              detail: 'Version 2.0.0\nSCADA yazılımları ve mobile uygulamalar arasında köprü kuran yüksek performanslı server.'
            });
          }
        },
        {
          label: 'Dokümantasyon',
          click: () => {
            shell.openExternal('https://github.com/your-repo/cloud-bridge');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Redis server'ı başlat
async function startRedis() {
  if (isRedisRunning) {
    console.log('Redis zaten çalışıyor');
    return;
  }

  try {
    // Önce Redis'in zaten çalışıp çalışmadığını kontrol et
    const isRedisAlreadyRunning = await checkRedisRunning();
    if (isRedisAlreadyRunning) {
      console.log('Redis zaten başka bir process tarafından çalıştırılıyor');
      isRedisRunning = true;
      mainWindow?.webContents.send('redis-status', { running: true });
      return;
    }

    // Windows için redis-server.exe'yi kontrol et
    if (process.platform === 'win32') {
      if (!fs.existsSync(APP_CONFIG.redisPath)) {
        throw new Error('Redis binary bulunamadı. Lütfen setup-redis.js çalıştırın.');
      }

      redisProcess = spawn(APP_CONFIG.redisPath, [APP_CONFIG.redisConfig], {
        cwd: path.dirname(APP_CONFIG.redisPath),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      // Linux/Mac için sistem Redis'ini kullan
      redisProcess = spawn('redis-server', [], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    redisProcess.stdout.on('data', (data) => {
      console.log(`Redis: ${data}`);
      mainWindow?.webContents.send('redis-log', data.toString());
    });

    redisProcess.stderr.on('data', (data) => {
      console.error(`Redis Error: ${data}`);
      mainWindow?.webContents.send('redis-error', data.toString());
      
      // Port çakışması hatası kontrolü
      if (data.toString().includes('bind: No such file or directory') ||
          data.toString().includes('Could not create server TCP listening socket')) {
        console.log('Redis port çakışması tespit edildi');
        isRedisRunning = true; // Başka bir Redis instance çalışıyor
        mainWindow?.webContents.send('redis-status', { running: true });
      }
    });

    redisProcess.on('close', (code) => {
      console.log(`Redis process exited with code ${code}`);
      isRedisRunning = false;
      mainWindow?.webContents.send('redis-status', { running: false, code });
    });

    // Redis'in başlamasını bekle
    setTimeout(() => {
      if (redisProcess && !redisProcess.killed) {
        isRedisRunning = true;
        mainWindow?.webContents.send('redis-status', { running: true });
        console.log('Redis başlatıldı');
      }
    }, 2000);

  } catch (error) {
    console.error('Redis başlatma hatası:', error);
    mainWindow?.webContents.send('redis-error', error.message);
  }
}

// Redis'in çalışıp çalışmadığını kontrol et
async function checkRedisRunning() {
  return new Promise((resolve) => {
    const testClient = spawn('redis-cli', ['ping'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    testClient.stdout.on('data', (data) => {
      if (data.toString().trim() === 'PONG') {
        resolve(true);
      }
    });
    
    testClient.on('error', () => {
      resolve(false);
    });
    
    testClient.on('close', (code) => {
      if (code !== 0) {
        resolve(false);
      }
    });
    
    // Timeout
    setTimeout(() => {
      testClient.kill();
      resolve(false);
    }, 1000);
  });
}

// Redis server'ı durdur
function stopRedis() {
  if (redisProcess) {
    redisProcess.kill();
    redisProcess = null;
    isRedisRunning = false;
    mainWindow?.webContents.send('redis-status', { running: false });
    console.log('Redis durduruldu');
  }
}

// SCADA server'ı başlat
async function startServer() {
  if (isServerRunning) {
    console.log('Server zaten çalışıyor');
    return;
  }

  try {
    // Önce server'ın zaten çalışıp çalışmadığını kontrol et
    const serverHealth = await checkServerHealth();
    if (serverHealth) {
      console.log('Server zaten başka bir process tarafından çalıştırılıyor');
      isServerRunning = true;
      mainWindow?.webContents.send('server-status', { running: true });
      mainWindow?.webContents.send('server-log', 'Server zaten çalışıyor durumda');
      return;
    }

    // Önce Redis'i başlat
    if (!isRedisRunning) {
      await startRedis();
      // Redis'in başlamasını bekle
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Server için node_modules yolunu belirle
    const appRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : path.join(__dirname, '..');
      
    const nodePath = path.join(appRoot, 'node_modules');
    console.log('Server için node_modules yolu:', nodePath);
    
    const serverEnv = {
      ...process.env,
      SHOW_STARTUP_INFO: 'true',
      NODE_PATH: nodePath,
      ELECTRON_RUN_AS_NODE: '1'
    };

    // Electron'ın kendi Node runtime'ını kullanarak server scriptini çalıştır
    serverProcess = spawn(process.execPath, [APP_CONFIG.serverScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: serverEnv
    });

    let serverStarted = false;

    serverProcess.stdout.on('data', (data) => {
      console.log(`Server: ${data}`);
      mainWindow?.webContents.send('server-log', data.toString());
      
      // Server başarıyla başladığını tespit et
      if (data.toString().includes('Cloud Bridge Server ready on HTTPS port')) {
        serverStarted = true;
        isServerRunning = true;
        mainWindow?.webContents.send('server-status', { running: true });
        console.log('SCADA Server başarıyla başlatıldı');
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server Error: ${data}`);
      mainWindow?.webContents.send('server-error', data.toString());
      
      // Port çakışması hatası kontrolü
      if (data.toString().includes('EADDRINUSE') ||
          data.toString().includes('address already in use')) {
        console.log('Server port çakışması tespit edildi');
        isServerRunning = true; // Başka bir server instance çalışıyor
        mainWindow?.webContents.send('server-status', { running: true });
        mainWindow?.webContents.send('server-log', 'Server zaten çalışıyor (port kullanımda)');
        
        // Process'i temizle
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
        }
      }
    });

    serverProcess.on('close', (code) => {
      console.log(`Server process exited with code ${code}`);
      
      // Eğer server başarıyla başlamadıysa
      if (!serverStarted) {
        isServerRunning = false;
        mainWindow?.webContents.send('server-status', { running: false, code });
      }
      
      // Server kapandığında Redis'i de durdur (sadece normal kapanmalarda)
      if (code !== null && code !== 0 && isRedisRunning) {
        stopRedis();
      }
    });

    // Server'ın başlamasını bekle (timeout ile)
    setTimeout(() => {
      if (!serverStarted && serverProcess && !serverProcess.killed) {
        // Hala başlamadıysa, varsayılan olarak başarılı say
        isServerRunning = true;
        mainWindow?.webContents.send('server-status', { running: true });
        console.log('SCADA Server başlatıldı (timeout)');
      }
    }, 10000); // 10 saniye bekle

  } catch (error) {
    console.error('Server başlatma hatası:', error);
    mainWindow?.webContents.send('server-error', error.message);
  }
}

// SCADA server'ı durdur
function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    isServerRunning = false;
    mainWindow?.webContents.send('server-status', { running: false });
    console.log('SCADA Server durduruldu');
    
    // Server durdurulduğunda Redis'i de durdur
    if (isRedisRunning) {
      stopRedis();
    }
  }
}

// Server durumunu kontrol et
async function checkServerHealth() {
  try {
    const response = await axios.get(`https://localhost:${APP_CONFIG.serverPort}/health`, {
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      }),
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

// Diagnostic bilgilerini al
async function getDiagnosticInfo() {
  try {
    const response = await axios.get(`https://localhost:${APP_CONFIG.serverPort}/api/mobile/diagnostic`, {
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      }),
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

// SSL Sertifika yönetimi
async function saveSSLSettings(settings) {
  // SSL ayarlarını her zaman app.asar.unpacked içinde tut
  let settingsPath;
  
  if (app.isPackaged) {
    // Paketlenmiş uygulamada app.asar.unpacked klasörünü kullan
    settingsPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'ssl-settings.json');
  } else {
    // Development modunda proje kök klasöründe
    settingsPath = path.join(__dirname, '..', 'ssl-settings.json');
  }
  
  try {
    // Klasörün var olduğundan emin ol
    const settingsDir = path.dirname(settingsPath);
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`SSL ayarları kaydedildi: ${settingsPath}`);
    return { success: true, path: settingsPath };
  } catch (error) {
    console.error('SSL ayarları kaydetme hatası:', error);
    return { success: false, error: error.message };
  }
}

// Artık sertifika kopyalama fonksiyonuna gerek yok
// Sertifikalar kullanıcının seçtiği yoldan doğrudan okunacak

async function loadSSLSettings() {
  // SSL ayarlarını her zaman app.asar.unpacked içinden oku
  let settingsPath;
  
  if (app.isPackaged) {
    // Paketlenmiş uygulamada app.asar.unpacked klasörünü kullan
    settingsPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'ssl-settings.json');
  } else {
    // Development modunda proje kök klasöründe
    settingsPath = path.join(__dirname, '..', 'ssl-settings.json');
  }
  
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      console.log(`SSL ayarları yüklendi: ${settingsPath}`);
      return { success: true, settings, path: settingsPath };
    } else {
      // Varsayılan ayarlar - boş değerlerle başla
      const defaultSettings = {
        type: 'local',
        certificatePath: '',
        keyFile: '',
        certFile: '',
        caFile: '',
        cloudflareOriginCertPath: null,
        cloudflareOriginKeyPath: null
      };
      
      console.log(`SSL ayarları dosyası bulunamadı, varsayılan ayarlar kullanılıyor: ${settingsPath}`);
      return { success: true, settings: defaultSettings, path: settingsPath };
    }
  } catch (error) {
    console.error('SSL ayarları yükleme hatası:', error);
    return { success: false, error: error.message };
  }
}

async function selectCertificateFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'SSL Sertifika Klasörünü Seçin',
    properties: ['openDirectory'],
    message: 'SSL sertifika dosyalarının bulunduğu klasörü seçin'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const selectedPath = result.filePaths[0];
    
    // Klasörde SSL dosyalarını bul ve kategorize et
    const foundFiles = fs.readdirSync(selectedPath);
    const sslFiles = foundFiles.filter(file =>
      file.endsWith('.pem') || file.endsWith('.crt') || file.endsWith('.key') || file.endsWith('.cert')
    );
    
    // SSL dosyalarını türlerine göre grupla
    const categorizedFiles = {
      keyFiles: [],
      certFiles: [],
      caFiles: [],
      otherFiles: []
    };
    
    sslFiles.forEach(file => {
      const lowerFile = file.toLowerCase();
      
      if (lowerFile.includes('key') || lowerFile.endsWith('.key')) {
        categorizedFiles.keyFiles.push(file);
      } else if (lowerFile.includes('cert') || lowerFile.includes('crt') || lowerFile.endsWith('.crt')) {
        // CA dosyalarını ayır
        if (lowerFile.includes('chain') || lowerFile.includes('ca') || lowerFile.includes('intermediate')) {
          categorizedFiles.caFiles.push(file);
        } else {
          categorizedFiles.certFiles.push(file);
        }
      } else if (lowerFile.includes('chain') || lowerFile.includes('ca') || lowerFile.includes('intermediate')) {
        categorizedFiles.caFiles.push(file);
      } else {
        categorizedFiles.otherFiles.push(file);
      }
    });
    
    // En uygun dosyaları otomatik seç
    const suggestions = {
      keyFile: categorizedFiles.keyFiles[0] || '',
      certFile: categorizedFiles.certFiles[0] || '',
      caFile: categorizedFiles.caFiles[0] || ''
    };
    
    return {
      success: true,
      path: selectedPath,
      files: sslFiles,
      categorizedFiles,
      suggestions,
      hasSSLFiles: sslFiles.length > 0
    };
  }
  
  return { success: false, canceled: true };
}

// IPC Event Handlers
ipcMain.handle('start-server', startServer);
ipcMain.handle('stop-server', stopServer);
ipcMain.handle('start-redis', startRedis);
ipcMain.handle('stop-redis', stopRedis);
ipcMain.handle('get-server-status', () => ({ running: isServerRunning }));
ipcMain.handle('get-redis-status', () => ({ running: isRedisRunning }));
ipcMain.handle('get-server-health', checkServerHealth);
ipcMain.handle('get-diagnostic-info', getDiagnosticInfo);
ipcMain.handle('set-auto-start', async (event, enable) => setAutoStart(enable));
ipcMain.handle('check-auto-start', checkAutoStart);

// SSL Sertifika IPC handlers
ipcMain.handle('save-ssl-settings', async (event, settings) => saveSSLSettings(settings));
ipcMain.handle('load-ssl-settings', loadSSLSettings);
ipcMain.handle('select-certificate-folder', selectCertificateFolder);

ipcMain.handle('show-message-box', async (event, options) => {
  const result = await dialog.showMessageBox(mainWindow, options);
  return result;
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

// Sunucu ortamını kontrol eden fonksiyon
function checkServerEnvironment() {
  const envInfo = {
    isWindowsServer: false,
    isRDP: false,
    platform: process.platform,
    arch: process.arch,
    ram: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB'
  };
  
  try {
    // Windows Server kontrolü
    if (process.platform === 'win32') {
      // Windows sürümünü kontrol et
      const osRelease = os.release().split('.');
      const isServer = os.type().includes('Server') ||
                      (osRelease[0] >= 6 && (osRelease[1] == 0 || osRelease[1] == 2 || osRelease[1] == 3));
      
      envInfo.isWindowsServer = isServer;
      
      // RDP kontrolü
      envInfo.isRDP = process.env.SESSIONNAME && process.env.SESSIONNAME.startsWith('RDP');
    }
    
    console.log('Sistem ortamı:', envInfo);
    return envInfo;
  } catch (err) {
    console.error('Ortam kontrolü yapılırken hata:', err);
    return envInfo;
  }
}

// Windows başlangıcına ekleme/kaldırma fonksiyonları
async function setAutoStart(enable) {
  if (process.platform !== 'win32') {
    console.log('Otomatik başlatma sadece Windows\'ta desteklenir');
    return false;
  }

  try {
    const appPath = app.getPath('exe');
    const appName = 'SCADA Cloud Bridge Server';
    
    if (enable) {
      // Registry'ye ekle
      const command = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /t REG_SZ /d "\\"${appPath}\\" --autostart" /f`;
      await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
          if (error) {
            console.error('Registry ekleme hatası:', error);
            reject(error);
          } else {
            console.log('Uygulama Windows başlangıcına eklendi');
            resolve(stdout);
          }
        });
      });
      return true;
    } else {
      // Registry'den kaldır
      const command = `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /f`;
      await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
          if (error && !error.message.includes('unable to find')) {
            console.error('Registry silme hatası:', error);
            reject(error);
          } else {
            console.log('Uygulama Windows başlangıcından kaldırıldı');
            resolve(stdout);
          }
        });
      });
      return true;
    }
  } catch (error) {
    console.error('Otomatik başlatma ayarı hatası:', error);
    return false;
  }
}

// Otomatik başlatma durumunu kontrol et
async function checkAutoStart() {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const appName = 'SCADA Cloud Bridge Server';
    const command = `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}"`;
    
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  } catch (error) {
    console.error('Otomatik başlatma kontrolü hatası:', error);
    return false;
  }
}

// Uygulama event handlers
app.whenReady().then(async () => {
  try {
    console.log('Uygulama başlatılıyor...');
    console.log('Çalışma dizini:', process.cwd());
    
    // Sunucu ortamını kontrol et
    const envInfo = checkServerEnvironment();
    
    // Windows Server ortamına göre ek optimizasyonlar
    if (envInfo.isWindowsServer) {
      console.log('Windows Server ortamı algılandı, sunucu optimizasyonları uygulanıyor...');
      // Burada Windows Server'a özel ekstra ayarlar yapılabilir
    }
    
    createWindow();
    createMenu();
    
    console.log('Uygulama başlatıldı');
    
    // Komut satırı parametrelerini kontrol et
    const args = process.argv;
    const isAutoStart = args.includes('--autostart');
    
    if (isAutoStart) {
      console.log('Windows başlangıcından otomatik başlatma tespit edildi');
      
      // Pencere tamamen yüklendikten sonra server'ı başlat
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            // SSL kontrolü yap
            const sslResult = await loadSSLSettings();
            if (sslResult.success && sslResult.settings) {
              const ssl = sslResult.settings;
              let hasValidSSL = false;
              
              if (ssl.type === 'local') {
                hasValidSSL = ssl.certificatePath && ssl.certificatePath.trim() !== '' &&
                             ssl.keyFile && ssl.keyFile.trim() !== '' &&
                             ssl.certFile && ssl.certFile.trim() !== '';
              } else if (ssl.type === 'cloudflare') {
                hasValidSSL = ssl.cloudflareOriginCertPath && ssl.cloudflareOriginCertPath.trim() !== '' &&
                             ssl.cloudflareOriginKeyPath && ssl.cloudflareOriginKeyPath.trim() !== '';
              }
              
              if (hasValidSSL) {
                console.log('SSL sertifikası mevcut, server başlatılıyor...');
                await startServer();
                mainWindow?.webContents.send('server-log', 'Server otomatik olarak başlatıldı (Windows başlangıcı)');
              } else {
                console.log('SSL sertifikası eksik, server başlatılmıyor');
                mainWindow?.webContents.send('server-log', 'SSL sertifikası eksik, otomatik başlatma iptal edildi');
              }
            }
          } catch (error) {
            console.error('Otomatik server başlatma hatası:', error);
            mainWindow?.webContents.send('server-error', `Otomatik başlatma hatası: ${error.message}`);
          }
        }, 3000); // 3 saniye bekle
      });
    }
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error('Uygulama başlatılırken hata oluştu:', error);
  }
});

app.on('window-all-closed', () => {
  // macOS'ta uygulamalar dock'ta kalır
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Windows ve özellikle RDP oturumları için ek event handler
app.on('ready', () => {
  // Windows işletim sisteminde ise ek önlemler al
  if (process.platform === 'win32') {
    // RDP oturumu algılama (Windows Server üzerinde)
    try {
      const isRdpSession = process.env.SESSIONNAME && process.env.SESSIONNAME.startsWith('RDP');
      if (isRdpSession) {
        console.log('RDP oturumu algılandı, görüntüleme optimizasyonları uygulanıyor...');
        // RDP oturumlarında performansı artırmak için ek ayarlar buraya eklenebilir
      }
    } catch (err) {
      console.error('RDP oturum kontrolü yapılırken hata:', err);
    }
  }
});

app.on('before-quit', () => {
  // Uygulamadan çıkarken server'ları durdur
  stopServer();
  stopRedis();
});

// Güvenlik: Sadece güvenli URL'lere izin ver
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// SSL sertifika kopyalama handler'ı kaldırıldı - artık gerek yok

// Tek dosya seçimi için IPC handler
ipcMain.handle('select-file', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Dosya Seç',
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return {
        success: true,
        canceled: false,
        path: result.filePaths[0]
      };
    }
    
    return { success: true, canceled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Dosya varlığı kontrolü için IPC handler
ipcMain.handle('check-file-exists', async (event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
});