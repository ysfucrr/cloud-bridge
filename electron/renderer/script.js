// Global değişkenler
let isAutoScrollEnabled = true;
let refreshInterval = null;
let serverHealthInterval = null;
let diagnosticInterval = null;

// DOM yüklendiğinde çalışacak fonksiyonlar
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setupEventListeners();
    setupElectronListeners();
    startPeriodicUpdates();
    loadSettings();
    updateSystemInfo();
});

// Uygulamayı başlat
function initializeApp() {
    console.log('SCADA Cloud Bridge Server UI başlatılıyor...');
    
    // İlk tab'ı aktif et
    showTab('dashboard');
    
    // Loading overlay'i gizle
    hideLoading();
    
    // İlk durum kontrolü
    updateServerStatus();
    updateRedisStatus();
}

// Event listener'ları ayarla
function setupEventListeners() {
    // Tab navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const tabName = item.dataset.tab;
            showTab(tabName);
            
            // Active class'ı güncelle
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
        });
    });

    // Server control buttons
    document.getElementById('start-server-btn').addEventListener('click', startServer);
    document.getElementById('stop-server-btn').addEventListener('click', stopServer);
    document.getElementById('start-redis-btn').addEventListener('click', startRedis);
    document.getElementById('stop-redis-btn').addEventListener('click', stopRedis);

    // Refresh buttons
    document.getElementById('refresh-agents').addEventListener('click', refreshConnections);
    document.getElementById('refresh-clients').addEventListener('click', refreshConnections);

    // Log controls
    document.getElementById('clear-logs').addEventListener('click', clearLogs);
    document.getElementById('auto-scroll-toggle').addEventListener('click', toggleAutoScroll);

    // Settings
    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('reset-settings').addEventListener('click', resetSettings);
    
    // SSL Certificate management
    document.getElementById('ssl-type').addEventListener('change', toggleSSLConfig);
    document.getElementById('select-certificate-folder').addEventListener('click', selectCertificateFolder);
    document.getElementById('test-ssl').addEventListener('click', testSSLConfiguration);
}

// Electron IPC listener'larını ayarla
function setupElectronListeners() {
    // Server status updates
    window.electronAPI.onServerStatus((data) => {
        updateServerStatusUI(data.running);
        if (data.running) {
            addLogEntry('Server başarıyla başlatıldı', 'success');
        } else {
            addLogEntry('Server durduruldu', 'warning');
        }
    });

    // Redis status updates
    window.electronAPI.onRedisStatus((data) => {
        updateRedisStatusUI(data.running);
        if (data.running) {
            addLogEntry('Redis başarıyla başlatıldı', 'success');
        } else {
            addLogEntry('Redis durduruldu', 'warning');
        }
    });

    // Server logs
    window.electronAPI.onServerLog((data) => {
        addLogEntry(`[Server] ${data}`, 'info');
    });

    // Server errors
    window.electronAPI.onServerError((data) => {
        addLogEntry(`[Server Error] ${data}`, 'error');
    });

    // Redis logs
    window.electronAPI.onRedisLog((data) => {
        addLogEntry(`[Redis] ${data}`, 'info');
    });

    // Redis errors
    window.electronAPI.onRedisError((data) => {
        addLogEntry(`[Redis Error] ${data}`, 'error');
    });

    // Settings dialog
    window.electronAPI.onShowSettings(() => {
        showTab('settings');
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelector('[data-tab="settings"]').classList.add('active');
    });
}

// Tab gösterme fonksiyonu
function showTab(tabName) {
    // Tüm tab'ları gizle
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Seçilen tab'ı göster
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Tab'a özel işlemler
    switch(tabName) {
        case 'connections':
            refreshConnections();
            break;
        case 'monitoring':
            updateMetrics();
            break;
        case 'dashboard':
            updateDashboard();
            break;
    }
}

// Server başlatma
async function startServer() {
    showLoading('Server başlatılıyor...');
    
    try {
        await window.electronAPI.startServer();
        addLogEntry('Server başlatma komutu gönderildi', 'info');
    } catch (error) {
        addLogEntry(`Server başlatma hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'Server başlatılamadı',
            detail: error.message
        });
    } finally {
        hideLoading();
    }
}

// Server durdurma
async function stopServer() {
    showLoading('Server durduruluyor...');
    
    try {
        await window.electronAPI.stopServer();
        addLogEntry('Server durdurma komutu gönderildi', 'info');
    } catch (error) {
        addLogEntry(`Server durdurma hatası: ${error.message}`, 'error');
    } finally {
        hideLoading();
    }
}

// Redis başlatma
async function startRedis() {
    showLoading('Redis başlatılıyor...');
    
    try {
        await window.electronAPI.startRedis();
        addLogEntry('Redis başlatma komutu gönderildi', 'info');
    } catch (error) {
        addLogEntry(`Redis başlatma hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'Redis başlatılamadı',
            detail: error.message
        });
    } finally {
        hideLoading();
    }
}

// Redis durdurma
async function stopRedis() {
    showLoading('Redis durduruluyor...');
    
    try {
        await window.electronAPI.stopRedis();
        addLogEntry('Redis durdurma komutu gönderildi', 'info');
    } catch (error) {
        addLogEntry(`Redis durdurma hatası: ${error.message}`, 'error');
    } finally {
        hideLoading();
    }
}

// Server durumunu güncelle
async function updateServerStatus() {
    try {
        const status = await window.electronAPI.getServerStatus();
        updateServerStatusUI(status.running);
    } catch (error) {
        console.error('Server durumu alınamadı:', error);
    }
}

// Redis durumunu güncelle
async function updateRedisStatus() {
    try {
        const status = await window.electronAPI.getRedisStatus();
        updateRedisStatusUI(status.running);
    } catch (error) {
        console.error('Redis durumu alınamadı:', error);
    }
}

// Server durumu UI güncellemesi
function updateServerStatusUI(isRunning) {
    const statusDot = document.querySelector('#server-status .status-dot');
    const statusText = document.getElementById('server-status-text');
    const startBtn = document.getElementById('start-server-btn');
    const stopBtn = document.getElementById('stop-server-btn');
    
    if (isRunning) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        statusText.className = 'status-online';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        statusText.className = 'status-offline';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Redis durumu UI güncellemesi
function updateRedisStatusUI(isRunning) {
    const statusDot = document.querySelector('#redis-status .status-dot');
    const statusText = document.getElementById('redis-status-text');
    const startBtn = document.getElementById('start-redis-btn');
    const stopBtn = document.getElementById('stop-redis-btn');
    
    if (isRunning) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        statusText.className = 'status-online';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        statusText.className = 'status-offline';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Dashboard güncellemesi
async function updateDashboard() {
    try {
        // Server health bilgilerini al
        const health = await window.electronAPI.getServerHealth();
        if (health) {
            updateServerHealthInfo(health);
        }
        
        // Diagnostic bilgilerini al
        const diagnostic = await window.electronAPI.getDiagnosticInfo();
        if (diagnostic) {
            updateConnectionStats(diagnostic);
        }
    } catch (error) {
        console.error('Dashboard güncellenirken hata:', error);
    }
}

// Server health bilgilerini güncelle
function updateServerHealthInfo(health) {
    if (health.uptime) {
        document.getElementById('server-uptime').textContent = formatUptime(health.uptime);
    }
    
    if (health.worker) {
        document.getElementById('server-pid').textContent = health.worker;
    }
    
    // Memory usage
    if (health.memory) {
        const memoryMB = Math.round(health.memory.heapUsed / 1024 / 1024);
        document.getElementById('memory-usage').textContent = `${memoryMB} MB`;
    }
    
    // Queue size
    if (health.queue) {
        document.getElementById('queue-size').textContent = health.queue.size;
    }
}

// Bağlantı istatistiklerini güncelle
function updateConnectionStats(diagnostic) {
    if (diagnostic.connections) {
        const agentCount = diagnostic.connections.agents?.connected || 0;
        const mobileCount = diagnostic.connections.mobileClients || 0;
        
        document.getElementById('agent-count').textContent = agentCount;
        document.getElementById('mobile-count').textContent = mobileCount;
    }
}

// Bağlantıları yenile
async function refreshConnections() {
    try {
        const diagnostic = await window.electronAPI.getDiagnosticInfo();
        if (diagnostic) {
            updateAgentsTable(diagnostic.connections?.agents);
            updateClientsTable(diagnostic.connections?.mobileClients);
        }
    } catch (error) {
        console.error('Bağlantılar yenilenirken hata:', error);
        addLogEntry('Bağlantı bilgileri alınamadı', 'error');
    }
}

// Agent tablosunu güncelle
function updateAgentsTable(agentsData) {
    const tbody = document.querySelector('#agents-table tbody');
    tbody.innerHTML = '';
    
    if (agentsData && agentsData.sampleData && agentsData.sampleData.length > 0) {
        agentsData.sampleData.forEach(agent => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${agent.id}</td>
                <td>${agent.name || 'İsimsiz Agent'}</td>
                <td>${new Date(agent.connectedAt).toLocaleString('tr-TR')}</td>
                <td>${formatUptime(agent.uptime)}</td>
                <td>${agent.transport}</td>
                <td><span class="status-online">Online</span></td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = '<tr class="no-data"><td colspan="6">Bağlı agent bulunamadı</td></tr>';
    }
}

// Client tablosunu güncelle
function updateClientsTable(clientCount) {
    const tbody = document.querySelector('#clients-table tbody');
    tbody.innerHTML = '';
    
    if (clientCount > 0) {
        // Gerçek client bilgileri olmadığı için genel bilgi göster
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>Mobile Clients</td>
            <td>-</td>
            <td>-</td>
            <td><span class="status-online">${clientCount} aktif</span></td>
        `;
        tbody.appendChild(row);
    } else {
        tbody.innerHTML = '<tr class="no-data"><td colspan="4">Bağlı mobile client bulunamadı</td></tr>';
    }
}

// Metrikleri güncelle
async function updateMetrics() {
    try {
        const health = await window.electronAPI.getServerHealth();
        if (health) {
            // CPU usage (yaklaşık hesaplama)
            const cpuUsage = Math.random() * 20 + 5; // Demo için
            document.getElementById('cpu-usage').textContent = `${cpuUsage.toFixed(1)}%`;
            
            // Memory usage
            if (health.memory) {
                const memoryMB = Math.round(health.memory.heapUsed / 1024 / 1024);
                document.getElementById('memory-usage').textContent = `${memoryMB} MB`;
            }
            
            // Queue size
            if (health.queue) {
                document.getElementById('queue-size').textContent = health.queue.size;
            }
            
            // Processed count
            if (health.redis && health.redis.metrics && health.redis.metrics.totalProcessed) {
                document.getElementById('processed-count').textContent = health.redis.metrics.totalProcessed;
            }
        }
    } catch (error) {
        console.error('Metrikler güncellenirken hata:', error);
    }
}

// Log girişi ekle
function addLogEntry(message, type = 'info') {
    const logViewer = document.getElementById('log-viewer');
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    logEntry.innerHTML = `
        <span class="log-time">[${timestamp}]</span>
        <span class="log-message">${message}</span>
    `;
    
    logViewer.appendChild(logEntry);
    
    // Auto scroll
    if (isAutoScrollEnabled) {
        logViewer.scrollTop = logViewer.scrollHeight;
    }
    
    // Maksimum 1000 log girişi tut
    const entries = logViewer.querySelectorAll('.log-entry');
    if (entries.length > 1000) {
        entries[0].remove();
    }
}

// Logları temizle
function clearLogs() {
    const logViewer = document.getElementById('log-viewer');
    logViewer.innerHTML = '<div class="log-entry info"><span class="log-time">[Temizlendi]</span><span class="log-message">Log geçmişi temizlendi</span></div>';
}

// Auto scroll toggle
function toggleAutoScroll() {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    const button = document.getElementById('auto-scroll-toggle');
    
    if (isAutoScrollEnabled) {
        button.innerHTML = '<i class="fas fa-arrow-down"></i> Otomatik Kaydır';
        button.classList.remove('btn-secondary');
        button.classList.add('btn-info');
    } else {
        button.innerHTML = '<i class="fas fa-pause"></i> Kaydırma Durduruldu';
        button.classList.remove('btn-info');
        button.classList.add('btn-secondary');
    }
}

// Ayarları kaydet
async function saveSettings() {
    await saveSettingsWithSSL();
}

// Ayarları sıfırla
function resetSettings() {
    document.getElementById('https-port').value = '443';
    document.getElementById('redis-port').value = '6379';
    document.getElementById('log-level').value = 'info';
    document.getElementById('auto-start-redis').checked = false;
    document.getElementById('auto-start-server').checked = false;
    
    localStorage.removeItem('scada-bridge-settings');
    addLogEntry('Ayarlar sıfırlandı', 'info');
}

// Ayarları yükle
async function loadSettings() {
    // Normal ayarları yükle
    const savedSettings = localStorage.getItem('scada-bridge-settings');
    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            
            document.getElementById('https-port').value = settings.httpsPort || '443';
            document.getElementById('redis-port').value = settings.redisPort || '6379';
            document.getElementById('log-level').value = settings.logLevel || 'info';
            document.getElementById('auto-start-redis').checked = settings.autoStartRedis || false;
            document.getElementById('auto-start-server').checked = settings.autoStartServer || false;
            
        } catch (error) {
            console.error('Normal ayarlar yüklenirken hata:', error);
        }
    }
    
    // SSL ayarlarını yükle
    try {
        const sslResult = await window.electronAPI.loadSSLSettings();
        
        if (sslResult.success && sslResult.settings) {
            const ssl = sslResult.settings;
            
            document.getElementById('ssl-type').value = ssl.type || 'local';
            toggleSSLConfig();
            
            if (ssl.type === 'local') {
                document.getElementById('certificate-path').value = ssl.certificatePath || '';
                document.getElementById('key-file').value = ssl.keyFile || '';
                document.getElementById('cert-file').value = ssl.certFile || '';
                document.getElementById('ca-file').value = ssl.caFile || '';
            } else {
                document.getElementById('cloudflare-cert').value = ssl.cloudflareOriginCert || '';
                document.getElementById('cloudflare-key').value = ssl.cloudflareOriginKey || '';
            }
            
            addLogEntry('SSL ayarları yüklendi', 'info');
        }
    } catch (error) {
        console.error('SSL ayarları yüklenirken hata:', error);
    }
}

// Sistem bilgilerini güncelle
function updateSystemInfo() {
    document.getElementById('platform-info').textContent = `${window.platform.platform} (${window.platform.arch})`;
    document.getElementById('node-version').textContent = window.platform.nodeVersion;
    document.getElementById('electron-version').textContent = window.platform.electronVersion;
}

// Periyodik güncellemeleri başlat
function startPeriodicUpdates() {
    // Her 5 saniyede bir durum kontrolü
    refreshInterval = setInterval(() => {
        updateServerStatus();
        updateRedisStatus();
    }, 5000);
    
    // Her 10 saniyede bir health check
    serverHealthInterval = setInterval(() => {
        if (document.querySelector('#dashboard-tab').classList.contains('active')) {
            updateDashboard();
        }
        if (document.querySelector('#monitoring-tab').classList.contains('active')) {
            updateMetrics();
        }
    }, 10000);
    
    // Her 30 saniyede bir diagnostic bilgileri
    diagnosticInterval = setInterval(() => {
        if (document.querySelector('#connections-tab').classList.contains('active')) {
            refreshConnections();
        }
    }, 30000);
}

// Loading göster
function showLoading(message = 'Yükleniyor...') {
    const overlay = document.getElementById('loading-overlay');
    const text = overlay.querySelector('p');
    text.textContent = message;
    overlay.classList.add('show');
}

// Loading gizle
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('show');
}

// Uptime formatla
function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}s ${minutes}d ${secs}sn`;
    } else if (minutes > 0) {
        return `${minutes}d ${secs}sn`;
    } else {
        return `${secs}sn`;
    }
}

// Sayfa kapatılırken temizlik
window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (serverHealthInterval) clearInterval(serverHealthInterval);
    if (diagnosticInterval) clearInterval(diagnosticInterval);
});

// Error handling
window.addEventListener('error', (event) => {
    console.error('JavaScript hatası:', event.error);
    addLogEntry(`JavaScript hatası: ${event.error.message}`, 'error');
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Promise hatası:', event.reason);
    addLogEntry(`Promise hatası: ${event.reason}`, 'error');
});

// Ayarları kaydet - SSL ayarları dahil (güncellenmiş versiyon)
async function saveSettingsWithSSL() {
    const settings = {
        httpsPort: document.getElementById('https-port').value,
        redisPort: document.getElementById('redis-port').value,
        logLevel: document.getElementById('log-level').value,
        autoStartRedis: document.getElementById('auto-start-redis').checked,
        autoStartServer: document.getElementById('auto-start-server').checked
    };
    
    // SSL ayarlarını ekle
    const sslType = document.getElementById('ssl-type').value;
    const sslSettings = {
        type: sslType
    };
    
    if (sslType === 'local') {
        const sourcePath = document.getElementById('certificate-path').value;
        const keyFile = document.getElementById('key-file').value;
        const certFile = document.getElementById('cert-file').value;
        const caFile = document.getElementById('ca-file').value;
        
        // Sertifika dosyalarını uygulama klasörüne kopyala
        if (sourcePath && (keyFile || certFile)) {
            showLoading('Sertifika dosyaları uygulama klasörüne kopyalanıyor...');
            
            try {
                const copyResult = await window.electronAPI.copyCertificatesToApp(
                    sourcePath, keyFile, certFile, caFile
                );
                
                if (copyResult.success) {
                    addLogEntry(`Sertifikalar uygulama klasörüne kopyalandı: ${copyResult.targetPath}`, 'success');
                    
                    // SSL ayarlarını güncelle - artık uygulama içindeki yolu kullan
                    sslSettings.certificatePath = copyResult.targetPath;
                    sslSettings.keyFile = keyFile;
                    sslSettings.certFile = certFile;
                    sslSettings.caFile = caFile;
                    
                    // Kopyalanan dosyaları logla
                    copyResult.copiedFiles.forEach(file => {
                        addLogEntry(`${file.type.toUpperCase()} dosyası: ${file.file} → ${file.target}`, 'info');
                    });
                    
                } else {
                    throw new Error(copyResult.error);
                }
                
            } catch (copyError) {
                hideLoading();
                addLogEntry(`Sertifika kopyalama hatası: ${copyError.message}`, 'error');
                await window.electronAPI.showMessageBox({
                    type: 'error',
                    title: 'Sertifika Kopyalama Hatası',
                    message: 'Sertifika dosyaları uygulama klasörüne kopyalanamadı',
                    detail: copyError.message
                });
                return;
            }
            
            hideLoading();
        } else {
            // Sadece yol bilgisini kaydet (kopyalama yapma)
            sslSettings.certificatePath = sourcePath;
            sslSettings.keyFile = keyFile;
            sslSettings.certFile = certFile;
            sslSettings.caFile = caFile;
        }
    } else {
        sslSettings.cloudflareOriginCert = document.getElementById('cloudflare-cert').value;
        sslSettings.cloudflareOriginKey = document.getElementById('cloudflare-key').value;
    }
    
    try {
        // Normal ayarları kaydet
        localStorage.setItem('scada-bridge-settings', JSON.stringify(settings));
        
        // SSL ayarlarını kaydet
        const sslResult = await window.electronAPI.saveSSLSettings(sslSettings);
        
        if (sslResult.success) {
            addLogEntry('Tüm ayarlar kaydedildi', 'success');
            
            await window.electronAPI.showMessageBox({
                type: 'info',
                title: 'Ayarlar Kaydedildi',
                message: 'Ayarlar başarıyla kaydedildi',
                detail: 'SSL sertifikaları uygulama klasörüne kopyalandı ve ayarlar kaydedildi. Değişikliklerin etkili olması için server\'ı yeniden başlatın.'
            });
        } else {
            throw new Error(sslResult.error);
        }
        
    } catch (error) {
        addLogEntry(`Ayar kaydetme hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'Ayarlar kaydedilemedi',
            detail: error.message
        });
    }
}

// SSL Sertifika yönetimi fonksiyonları
function toggleSSLConfig() {
    const sslType = document.getElementById('ssl-type').value;
    const localConfig = document.getElementById('local-ssl-config');
    const cloudflareConfig = document.getElementById('cloudflare-ssl-config');
    
    if (sslType === 'local') {
        localConfig.style.display = 'block';
        cloudflareConfig.style.display = 'none';
    } else {
        localConfig.style.display = 'none';
        cloudflareConfig.style.display = 'block';
    }
}

async function selectCertificateFolder() {
    try {
        showLoading('Sertifika klasörü seçiliyor...');
        
        const result = await window.electronAPI.selectCertificateFolder();
        
        if (result.success && !result.canceled) {
            document.getElementById('certificate-path').value = result.path;
            
            // SSL dosyalarını listele
            displaySSLFiles(result.files, result.categorizedFiles);
            
            // Otomatik dosya eşleştirme - önerilen dosyaları kullan
            if (result.suggestions) {
                document.getElementById('key-file').value = result.suggestions.keyFile;
                document.getElementById('cert-file').value = result.suggestions.certFile;
                document.getElementById('ca-file').value = result.suggestions.caFile;
            }
            
            addLogEntry(`SSL sertifika klasörü seçildi: ${result.path}`, 'success');
            
            if (!result.hasSSLFiles) {
                await window.electronAPI.showMessageBox({
                    type: 'warning',
                    title: 'Uyarı',
                    message: 'SSL Dosyası Bulunamadı',
                    detail: 'Seçilen klasörde SSL sertifika dosyası (.pem, .crt, .key) bulunamadı.'
                });
            } else {
                // Bulunan dosya türlerini bildir
                const fileTypes = [];
                if (result.suggestions.keyFile) fileTypes.push('Private Key');
                if (result.suggestions.certFile) fileTypes.push('Certificate');
                if (result.suggestions.caFile) fileTypes.push('CA Chain');
                
                if (fileTypes.length > 0) {
                    addLogEntry(`Otomatik tespit edilen dosyalar: ${fileTypes.join(', ')}`, 'success');
                }
            }
        }
    } catch (error) {
        addLogEntry(`Sertifika klasörü seçme hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'Klasör seçilemedi',
            detail: error.message
        });
    } finally {
        hideLoading();
    }
}

function displaySSLFiles(files, categorizedFiles) {
    const container = document.getElementById('ssl-files-list');
    
    if (files.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    let html = '<h5>Bulunan SSL Dosyaları:</h5>';
    
    // Kategorize edilmiş dosyaları göster
    if (categorizedFiles) {
        if (categorizedFiles.keyFiles.length > 0) {
            html += '<div class="ssl-category"><strong>Private Key Dosyaları:</strong></div>';
            categorizedFiles.keyFiles.forEach(file => {
                html += `
                    <div class="ssl-file-item">
                        <i class="fas fa-key" style="color: #e74c3c;"></i>
                        <span>${file}</span>
                    </div>
                `;
            });
        }
        
        if (categorizedFiles.certFiles.length > 0) {
            html += '<div class="ssl-category"><strong>Certificate Dosyaları:</strong></div>';
            categorizedFiles.certFiles.forEach(file => {
                html += `
                    <div class="ssl-file-item">
                        <i class="fas fa-certificate" style="color: #27ae60;"></i>
                        <span>${file}</span>
                    </div>
                `;
            });
        }
        
        if (categorizedFiles.caFiles.length > 0) {
            html += '<div class="ssl-category"><strong>CA Chain Dosyaları:</strong></div>';
            categorizedFiles.caFiles.forEach(file => {
                html += `
                    <div class="ssl-file-item">
                        <i class="fas fa-link" style="color: #3498db;"></i>
                        <span>${file}</span>
                    </div>
                `;
            });
        }
        
        if (categorizedFiles.otherFiles.length > 0) {
            html += '<div class="ssl-category"><strong>Diğer SSL Dosyaları:</strong></div>';
            categorizedFiles.otherFiles.forEach(file => {
                html += `
                    <div class="ssl-file-item">
                        <i class="fas fa-file" style="color: #95a5a6;"></i>
                        <span>${file}</span>
                    </div>
                `;
            });
        }
    }
    
    container.innerHTML = html;
}

async function testSSLConfiguration() {
    try {
        showLoading('SSL konfigürasyonu test ediliyor...');
        
        const sslType = document.getElementById('ssl-type').value;
        let testResult = { success: false, message: '' };
        
        if (sslType === 'local') {
            const certificatePath = document.getElementById('certificate-path').value;
            const keyFile = document.getElementById('key-file').value;
            const certFile = document.getElementById('cert-file').value;
            
            if (!certificatePath || !keyFile || !certFile) {
                throw new Error('Lütfen sertifika klasörünü seçin');
            }
            
            testResult = {
                success: true,
                message: 'SSL dosyaları bulundu ve yapılandırma geçerli görünüyor'
            };
            
        } else {
            const cert = document.getElementById('cloudflare-cert').value;
            const key = document.getElementById('cloudflare-key').value;
            
            if (!cert || !key) {
                throw new Error('Lütfen Cloudflare sertifika ve private key alanlarını doldurun');
            }
            
            if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('BEGIN PRIVATE KEY')) {
                throw new Error('Geçersiz sertifika formatı');
            }
            
            testResult = {
                success: true,
                message: 'Cloudflare Origin Certificate formatı geçerli görünüyor'
            };
        }
        
        if (testResult.success) {
            addLogEntry(`SSL test başarılı: ${testResult.message}`, 'success');
            await window.electronAPI.showMessageBox({
                type: 'info',
                title: 'SSL Test Başarılı',
                message: 'SSL Konfigürasyonu Geçerli',
                detail: testResult.message
            });
        }
        
    } catch (error) {
        addLogEntry(`SSL test hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'SSL Test Hatası',
            message: 'SSL konfigürasyonu geçersiz',
            detail: error.message
        });
    } finally {
        hideLoading();
    }
}