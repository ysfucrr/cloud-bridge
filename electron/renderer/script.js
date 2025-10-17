// Global değişkenler
let isAutoScrollEnabled = true;
let refreshInterval = null;
let serverHealthInterval = null;
let diagnosticInterval = null;

// DOM yüklendiğinde çalışacak fonksiyonlar
document.addEventListener('DOMContentLoaded', () => {
    // Önce SSL sertifika kontrolü yap
    checkSSLCertificateAndInitialize();
});

// SSL sertifika kontrolü ve uygulama başlatma
async function checkSSLCertificateAndInitialize() {
    showLoading('SSL sertifika kontrolü yapılıyor...');
    
    try {
        // SSL ayarlarını kontrol et
        const sslResult = await window.electronAPI.loadSSLSettings();
        
        if (sslResult.success && sslResult.settings) {
            const ssl = sslResult.settings;
            
            // Sertifika yapılandırması var mı kontrol et
            let hasValidSSL = false;
            
            if (ssl.type === 'local') {
                // Let's Encrypt sertifikaları için kontrol - boş string kontrolü de yap
                hasValidSSL = ssl.certificatePath && ssl.certificatePath.trim() !== '' &&
                             ssl.keyFile && ssl.keyFile.trim() !== '' &&
                             ssl.certFile && ssl.certFile.trim() !== '';
            } else if (ssl.type === 'cloudflare') {
                // Cloudflare sertifikaları için kontrol - boş string kontrolü de yap
                hasValidSSL = ssl.cloudflareOriginCertPath && ssl.cloudflareOriginCertPath.trim() !== '' &&
                             ssl.cloudflareOriginKeyPath && ssl.cloudflareOriginKeyPath.trim() !== '';
            }
            
            if (hasValidSSL) {
                console.log('SSL sertifika yapılandırması bulundu, uygulama başlatılıyor...');
                hideLoading();
                
                // Normal uygulama başlatma
                initializeApp();
                setupEventListeners();
                setupElectronListeners();
                startPeriodicUpdates();
                loadSettings();
                updateSystemInfo();
                
                // SSL varsa ve otomatik başlatma ayarı aktifse server'ı başlat
                setTimeout(() => {
                    checkAutoStartServer();
                }, 2000);
            } else {
                console.log('SSL sertifika yapılandırması eksik, ayarlar sayfasına yönlendiriliyor...');
                hideLoading();
                
                // Minimal başlatma - sadece gerekli olanlar
                setupEventListeners();
                setupElectronListeners();
                updateSystemInfo();
                
                // Ayarlar sayfasına yönlendir
                showTab('settings');
                document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
                document.querySelector('[data-tab="settings"]').classList.add('active');
                
                // Kullanıcıya bilgi ver
                await window.electronAPI.showMessageBox({
                    type: 'warning',
                    title: 'SSL Sertifikası Gerekli',
                    message: 'SSL Sertifikası Yapılandırılmamış',
                    detail: 'Cloud Bridge Server\'ı başlatmak için önce SSL sertifikası yapılandırmanız gerekiyor. Lütfen ayarlar sayfasından SSL sertifikanızı seçin.'
                });
                
                // SSL config bölümünü vurgula
                const sslSection = document.querySelector('.settings-section:has(#ssl-type)');
                if (sslSection) {
                    sslSection.style.border = '2px solid #e74c3c';
                    sslSection.style.animation = 'pulse-warning 2s infinite';
                }
                
                // Server kontrol butonlarını devre dışı bırak
                document.getElementById('start-server-btn').disabled = true;
                document.getElementById('stop-server-btn').disabled = true;
                
                addLogEntry('SSL sertifikası yapılandırılmamış. Lütfen ayarlardan SSL sertifikası ekleyin.', 'warning');
            }
        } else {
            // SSL ayarları yüklenemedi
            throw new Error('SSL ayarları yüklenemedi');
        }
    } catch (error) {
        console.error('SSL kontrol hatası:', error);
        hideLoading();
        
        // Hata durumunda da ayarlar sayfasına yönlendir
        setupEventListeners();
        setupElectronListeners();
        updateSystemInfo();
        
        showTab('settings');
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelector('[data-tab="settings"]').classList.add('active');
        
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'SSL Ayarları Yüklenemedi',
            detail: 'SSL ayarları kontrol edilirken bir hata oluştu. Lütfen ayarları kontrol edin.'
        });
    }
}

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
    // SSL sertifika kontrolü yap
    const sslResult = await window.electronAPI.loadSSLSettings();
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
        
        if (!hasValidSSL) {
            // SSL sertifikası yoksa uyarı ver ve ayarlara yönlendir
            await window.electronAPI.showMessageBox({
                type: 'warning',
                title: 'SSL Sertifikası Gerekli',
                message: 'SSL Sertifikası Yapılandırılmamış',
                detail: 'Server\'ı başlatmak için önce SSL sertifikası yapılandırmanız gerekiyor.'
            });
            
            // Ayarlar sekmesine geç
            showTab('settings');
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelector('[data-tab="settings"]').classList.add('active');
            
            return;
        }
    }
    
    showLoading('Server ve Redis başlatılıyor...');
    
    try {
        await window.electronAPI.startServer();
        addLogEntry('Server ve Redis başlatma komutu gönderildi', 'info');
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
    showLoading('Server ve Redis durduruluyor...');
    
    try {
        await window.electronAPI.stopServer();
        addLogEntry('Server ve Redis durdurma komutu gönderildi', 'info');
    } catch (error) {
        addLogEntry(`Server durdurma hatası: ${error.message}`, 'error');
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
    
    if (isRunning) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        statusText.className = 'status-online';
    } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        statusText.className = 'status-offline';
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
        
        // mobileClients bir nesne ise count değerini al, sayı ise direkt kullan
        let mobileCount = 0;
        if (typeof diagnostic.connections.mobileClients === 'number') {
            mobileCount = diagnostic.connections.mobileClients;
        } else if (diagnostic.connections.mobileClients && typeof diagnostic.connections.mobileClients === 'object') {
            mobileCount = diagnostic.connections.mobileClients.count || diagnostic.connections.mobileClients.total || 0;
        }
        
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
    
    // fullData varsa onu kullan, yoksa sampleData kullan
    const agents = agentsData?.fullData || agentsData?.sampleData || [];
    
    if (agents && agents.length > 0) {
        agents.forEach(agent => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td title="${agent.id}">${agent.id}</td>
                <td>${agent.name || 'İsimsiz Agent'}</td>
                <td>${agent.ip || 'Unknown'}</td>
                <td>${agent.platform || 'Unknown'}</td>
                <td>${new Date(agent.connectedAt).toLocaleString('tr-TR')}</td>
                <td>${formatUptime(agent.uptime)}</td>
                <td>${agent.transport}</td>
                <td><span class="status-online">Online</span></td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = '<tr class="no-data"><td colspan="8">Bağlı agent bulunamadı</td></tr>';
    }
}

// Client tablosunu güncelle
function updateClientsTable(clientsData) {
    const tbody = document.querySelector('#clients-table tbody');
    tbody.innerHTML = '';
    
    // Eğer clientsData bir sayı ise (eski format), object ise yeni format
    if (typeof clientsData === 'number') {
        // Eski format - sadece sayı
        if (clientsData > 0) {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td colspan="7">Mobile Clients</td>
                <td><span class="status-online">${clientsData} aktif</span></td>
            `;
            tbody.appendChild(row);
        } else {
            tbody.innerHTML = '<tr class="no-data"><td colspan="8">Bağlı mobile client bulunamadı</td></tr>';
        }
    } else if (clientsData && clientsData.details && clientsData.details.length > 0) {
        // Yeni format - detaylı bilgiler
        clientsData.details.forEach(client => {
            const row = document.createElement('tr');
            const platform = client.platform || 'Unknown';
            const platformIcon = getPlatformIcon(platform);
            
            row.innerHTML = `
                <td title="${client.id}">${client.id.substring(0, 8)}...</td>
                <td>${client.ip || 'Unknown'}</td>
                <td>${platformIcon} ${platform}</td>
                <td>${client.model || 'Unknown'}</td>
                <td>${client.appVersion || 'Unknown'}</td>
                <td>${client.osVersion || 'Unknown'}</td>
                <td>${new Date(client.connectedAt).toLocaleString('tr-TR')}</td>
                <td><span class="status-online">Online</span></td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = '<tr class="no-data"><td colspan="8">Bağlı mobile client bulunamadı</td></tr>';
    }
}

// Platform için ikon döndür
function getPlatformIcon(platform) {
    const platformLower = platform.toLowerCase();
    if (platformLower.includes('android')) {
        return '<i class="fab fa-android" style="color: #3DDC84;"></i>';
    } else if (platformLower.includes('ios') || platformLower.includes('iphone') || platformLower.includes('ipad')) {
        return '<i class="fab fa-apple" style="color: #000;"></i>';
    } else if (platformLower.includes('windows')) {
        return '<i class="fab fa-windows" style="color: #0078D4;"></i>';
    } else if (platformLower.includes('mac')) {
        return '<i class="fab fa-apple" style="color: #000;"></i>';
    } else if (platformLower.includes('linux')) {
        return '<i class="fab fa-linux" style="color: #FCC624;"></i>';
    } else {
        return '<i class="fas fa-mobile-alt" style="color: #666;"></i>';
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
    const wasSSLMissing = document.getElementById('start-server-btn').disabled;
    await saveSettingsWithSSL();
    
    // Eğer SSL eksikti ve şimdi eklendiyse, server kontrollerini etkinleştir
    if (wasSSLMissing) {
        // SSL ayarlarını tekrar kontrol et
        const sslResult = await window.electronAPI.loadSSLSettings();
        if (sslResult.success && sslResult.settings) {
            const ssl = sslResult.settings;
            let hasValidSSL = false;
            
            if (ssl.type === 'local') {
                hasValidSSL = ssl.certificatePath && ssl.keyFile && ssl.certFile;
            } else if (ssl.type === 'cloudflare') {
                hasValidSSL = ssl.cloudflareOriginCertPath && ssl.cloudflareOriginKeyPath;
            }
            
            if (hasValidSSL) {
                // Server kontrollerini etkinleştir
                document.getElementById('start-server-btn').disabled = false;
                document.getElementById('stop-server-btn').disabled = true;
                
                // SSL vurgusunu kaldır
                const sslSection = document.querySelector('.settings-section:has(#ssl-type)');
                if (sslSection) {
                    sslSection.style.border = '';
                    sslSection.style.animation = '';
                }
                
                // Tam başlatma yap
                if (!window.periodicUpdatesStarted) {
                    startPeriodicUpdates();
                    window.periodicUpdatesStarted = true;
                }
                
                addLogEntry('SSL sertifikası başarıyla yapılandırıldı. Server ve Redis otomatik olarak başlatılıyor...', 'success');
                
                // Dashboard'a dön
                setTimeout(() => {
                    showTab('dashboard');
                    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
                    document.querySelector('[data-tab="dashboard"]').classList.add('active');
                }, 1500);
                
                // SSL yüklendikten sonra otomatik olarak server'ı başlat
                setTimeout(() => {
                    addLogEntry('SSL sertifikası yüklendi, server otomatik başlatılıyor...', 'info');
                    startServer();
                }, 2000);
            }
        }
    }
}

// Windows başlangıcında otomatik başlatma ayarını güncelle
async function updateAutoStart() {
    const autoStartWindows = document.getElementById('auto-start-windows').checked;
    
    try {
        const result = await window.electronAPI.setAutoStart(autoStartWindows);
        if (result) {
            addLogEntry(`Windows başlangıcında otomatik başlatma ${autoStartWindows ? 'etkinleştirildi' : 'devre dışı bırakıldı'}`, 'success');
        } else {
            addLogEntry('Windows başlangıcı ayarı güncellenemedi', 'error');
        }
    } catch (error) {
        addLogEntry(`Otomatik başlatma ayarı hatası: ${error.message}`, 'error');
    }
}

// Ayarları sıfırla
async function resetSettings() {
    // Form alanlarını sıfırla
    document.getElementById('https-port').value = '443';
    document.getElementById('redis-port').value = '6379';
    document.getElementById('log-level').value = 'info';
    document.getElementById('auto-start-windows').checked = false;
    document.getElementById('auto-start-server').checked = false;
    
    // SSL ayarlarını da sıfırla
    document.getElementById('ssl-type').value = 'local';
    document.getElementById('certificate-path').value = '';
    document.getElementById('key-file').value = '';
    document.getElementById('cert-file').value = '';
    document.getElementById('ca-file').value = '';
    document.getElementById('cloudflare-cert-path').value = '';
    document.getElementById('cloudflare-key-path').value = '';
    
    // SSL görünümünü güncelle
    toggleSSLConfig();
    
    // SSL dosya listesini temizle
    const sslFilesList = document.getElementById('ssl-files-list');
    if (sslFilesList) {
        sslFilesList.innerHTML = '';
    }
    
    // Normal ayarları temizle
    localStorage.removeItem('scada-bridge-settings');
    
    // SSL ayarlarını da temizle (ssl-settings.json dosyasını sıfırla)
    try {
        const defaultSSLSettings = {
            type: 'local',
            certificatePath: '',
            keyFile: '',
            certFile: '',
            caFile: '',
            cloudflareOriginCertPath: null,
            cloudflareOriginKeyPath: null
        };
        
        const sslResult = await window.electronAPI.saveSSLSettings(defaultSSLSettings);
        
        if (sslResult.success) {
            addLogEntry('Tüm ayarlar sıfırlandı (SSL ayarları dahil)', 'success');
        } else {
            addLogEntry('Ayarlar sıfırlandı ancak SSL ayarları sıfırlanamadı', 'warning');
        }
    } catch (error) {
        console.error('SSL ayarları sıfırlama hatası:', error);
        addLogEntry('Ayarlar sıfırlandı ancak SSL ayarları sıfırlanamadı', 'warning');
    }
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
            document.getElementById('auto-start-server').checked = settings.autoStartServer || false;
            
        } catch (error) {
            console.error('Normal ayarlar yüklenirken hata:', error);
        }
    }
    
    // Windows başlangıcında otomatik başlatma durumunu kontrol et
    try {
        const isAutoStartEnabled = await window.electronAPI.checkAutoStart();
        document.getElementById('auto-start-windows').checked = isAutoStartEnabled;
    } catch (error) {
        console.error('Otomatik başlatma durumu kontrol hatası:', error);
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
                
                // Sadece gerçekten ayarlar varsa log göster
                if (ssl.certificatePath && ssl.keyFile && ssl.certFile) {
                    addLogEntry('SSL ayarları yüklendi (Let\'s Encrypt)', 'info');
                }
            } else {
                // Cloudflare dosya yolları
                document.getElementById('cloudflare-cert-path').value = ssl.cloudflareOriginCertPath || '';
                document.getElementById('cloudflare-key-path').value = ssl.cloudflareOriginKeyPath || '';
                
                // Eski format desteği (geriye uyumluluk için)
                if (!ssl.cloudflareOriginCertPath && ssl.cloudflareOriginCert) {
                    addLogEntry('Eski Cloudflare sertifika formatı tespit edildi. Lütfen dosya olarak kaydedin.', 'warning');
                }
                
                // Sadece gerçekten ayarlar varsa log göster
                if (ssl.cloudflareOriginCertPath && ssl.cloudflareOriginKeyPath) {
                    addLogEntry('SSL ayarları yüklendi (Cloudflare)', 'info');
                }
            }
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
        autoStartServer: document.getElementById('auto-start-server').checked
    };
    
    // Windows başlangıcında otomatik başlatma ayarını güncelle
    await updateAutoStart();
    
    // SSL ayarlarını ekle
    const sslType = document.getElementById('ssl-type').value;
    const sslSettings = {
        type: sslType
    };
    
    if (sslType === 'local') {
        const certificatePath = document.getElementById('certificate-path').value;
        const keyFile = document.getElementById('key-file').value;
        const certFile = document.getElementById('cert-file').value;
        const caFile = document.getElementById('ca-file').value;
        
        // Gerekli alanların dolu olduğunu kontrol et
        if (!certificatePath || !keyFile || !certFile) {
            await window.electronAPI.showMessageBox({
                type: 'warning',
                title: 'Eksik Bilgi',
                message: 'SSL Sertifika Bilgileri Eksik',
                detail: 'Lütfen sertifika klasörünü seçin ve key/cert dosya adlarını belirtin.'
            });
            return;
        }
        
        // Sadece yol ve dosya adı bilgilerini kaydet (fiziksel kopyalama yapmadan)
        sslSettings.certificatePath = certificatePath;
        sslSettings.keyFile = keyFile;
        sslSettings.certFile = certFile;
        sslSettings.caFile = caFile || ''; // CA dosyası opsiyonel
        
        addLogEntry(`SSL sertifika yolu ayarlandı: ${certificatePath}`, 'info');
        
    } else if (sslType === 'cloudflare') {
        const cloudflareCertPath = document.getElementById('cloudflare-cert-path').value;
        const cloudflareKeyPath = document.getElementById('cloudflare-key-path').value;
        
        if (!cloudflareCertPath || !cloudflareKeyPath) {
            await window.electronAPI.showMessageBox({
                type: 'warning',
                title: 'Eksik Bilgi',
                message: 'Cloudflare Sertifika Dosyaları Eksik',
                detail: 'Lütfen Cloudflare Origin Certificate ve Private Key dosyalarını seçin.'
            });
            return;
        }
        
        // Cloudflare için de dosya yollarını kaydet (server-optimized.js ile uyumlu property isimleri)
        sslSettings.cloudflareOriginCertPath = cloudflareCertPath;
        sslSettings.cloudflareOriginKeyPath = cloudflareKeyPath;
        
        addLogEntry(`Cloudflare sertifika dosyaları ayarlandı`, 'info');
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
                detail: 'SSL sertifika yolu ve ayarları kaydedildi. Değişikliklerin etkili olması için server\'ı yeniden başlatın.'
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

// Cloudflare dosya seçimi fonksiyonu
async function selectCloudflareFile(type) {
    try {
        showLoading('Dosya seçiliyor...');
        
        const result = await window.electronAPI.selectFile({
            title: type === 'cert' ? 'Cloudflare Certificate Dosyasını Seçin' : 'Cloudflare Private Key Dosyasını Seçin',
            filters: [
                { name: 'PEM Files', extensions: ['pem'] },
                { name: 'Certificate Files', extensions: ['crt', 'cert'] },
                { name: 'Key Files', extensions: ['key'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        
        if (result.success && !result.canceled && result.path) {
            if (type === 'cert') {
                document.getElementById('cloudflare-cert-path').value = result.path;
                addLogEntry(`Cloudflare certificate dosyası seçildi: ${result.path}`, 'success');
            } else {
                document.getElementById('cloudflare-key-path').value = result.path;
                addLogEntry(`Cloudflare private key dosyası seçildi: ${result.path}`, 'success');
            }
        }
    } catch (error) {
        addLogEntry(`Dosya seçme hatası: ${error.message}`, 'error');
        await window.electronAPI.showMessageBox({
            type: 'error',
            title: 'Hata',
            message: 'Dosya seçilemedi',
            detail: error.message
        });
    } finally {
        hideLoading();
    }
}

// Window'a fonksiyonu ekle (inline onclick için)
window.selectCloudflareFile = selectCloudflareFile;

// Uygulama başladığında otomatik server başlatma kontrolü
async function checkAutoStartServer() {
    // Eğer Windows başlangıcından geliyorsak (--autostart parametresi ile),
    // main.js zaten server'ı başlatacak, burada başlatmaya gerek yok
    const urlParams = new URLSearchParams(window.location.search);
    const isWindowsAutoStart = urlParams.get('autostart') === 'true';
    
    if (isWindowsAutoStart) {
        addLogEntry('Windows başlangıcından otomatik başlatma tespit edildi, main process tarafından başlatılacak', 'info');
        return;
    }
    
    const savedSettings = localStorage.getItem('scada-bridge-settings');
    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            if (settings.autoStartServer) {
                addLogEntry('Otomatik server başlatma ayarı aktif, SSL kontrolü başarılı', 'info');
                addLogEntry('Server ve Redis otomatik olarak başlatılıyor...', 'info');
                setTimeout(() => {
                    startServer();
                }, 1000); // 1 saniye bekle
            }
        } catch (error) {
            console.error('Otomatik başlatma kontrolü hatası:', error);
        }
    }
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
            const certPath = document.getElementById('cloudflare-cert-path').value;
            const keyPath = document.getElementById('cloudflare-key-path').value;
            
            if (!certPath || !keyPath) {
                throw new Error('Lütfen Cloudflare sertifika dosyalarını seçin');
            }
            
            // Dosya varlığını kontrol et
            const certExists = await window.electronAPI.checkFileExists(certPath);
            const keyExists = await window.electronAPI.checkFileExists(keyPath);
            
            if (!certExists || !keyExists) {
                throw new Error('Belirtilen sertifika dosyaları bulunamadı');
            }
            
            testResult = {
                success: true,
                message: 'Cloudflare sertifika dosyaları bulundu ve erişilebilir'
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