# SCADA Cloud Bridge Server - Desktop Uygulaması

Bu proje, SCADA yazılımları ve mobile uygulamalar arasında köprü kuran yüksek performanslı server'ın desktop uygulaması versiyonudur. Electron framework'ü kullanılarak geliştirilmiştir ve Windows, Linux, Mac platformlarında çalışabilir.

## Özellikler

### 🖥️ Desktop UI
- Modern ve kullanıcı dostu arayüz
- Real-time server durumu izleme
- Bağlı agent'ları ve mobile client'ları görüntüleme
- Performans metrikleri ve monitoring
- Log görüntüleme ve yönetimi
- Ayarlar paneli

### 🚀 Server Yönetimi
- Server'ı başlatma/durdurma
- Redis'i başlatma/durdurma
- Otomatik başlatma seçenekleri
- Durum kontrolü ve health check

### 📊 Monitoring ve İstatistikler
- CPU ve bellek kullanımı
- Bağlantı sayıları (Agent/Mobile)
- İşlenen veri miktarı
- Kuyruk boyutu
- Uptime bilgileri

### 🔧 Konfigürasyon
- HTTPS port ayarları
- Redis port ayarları
- Log seviyesi ayarları
- Otomatik başlatma seçenekleri

## Kurulum

### Gereksinimler
- Node.js 16.0.0 veya üzeri
- npm veya yarn
- Windows: Visual Studio Build Tools (C++ geliştirme araçları)
- Linux: build-essential, libnss3-dev, libatk-bridge2.0-dev, libdrm2, libxcomposite1, libxdamage1, libxrandr2, libgbm1, libxss1, libasound2
- macOS: Xcode Command Line Tools

### Bağımlılıkları Yükleme
```bash
npm install
```

### Redis Kurulumu
```bash
npm run setup-redis
```

## Geliştirme

### Development Modunda Çalıştırma
```bash
npm run electron:dev
```

### Server'ı Ayrı Çalıştırma (Test için)
```bash
npm run start:with-redis
```

## Build ve Paketleme

### Tüm Platformlar için Build
```bash
npm run build
```

### Platform Spesifik Build
```bash
# Windows için
npm run electron:pack:win

# macOS için
npm run electron:pack:mac

# Linux için
npm run electron:pack:linux
```

### Portable Sürüm
Windows için portable .exe dosyası oluşturulur. Bu dosya kurulum gerektirmez ve doğrudan çalıştırılabilir.

## Dosya Yapısı

```
cloud-bridge/
├── electron/                 # Electron uygulaması
│   ├── main.js              # Ana Electron process
│   ├── preload.js           # Preload script (güvenlik)
│   └── renderer/            # UI dosyaları
│       ├── index.html       # Ana HTML
│       ├── styles.css       # CSS stilleri
│       └── script.js        # Frontend JavaScript
├── server-optimized.js      # SCADA server
├── redis-service.js         # Redis servisi
├── register-processor-worker.js # Worker thread
├── scripts/                 # Yardımcı scriptler
│   └── setup-redis.js       # Redis kurulum
├── redis/                   # Redis binary'leri
├── Certificates/            # SSL sertifikaları
└── package.json            # Proje konfigürasyonu
```

## Kullanım

### İlk Başlatma
1. Uygulamayı başlatın
2. Redis'i başlatın (Redis Başlat butonu)
3. Server'ı başlatın (Server Başlat butonu)
4. Dashboard'da bağlantı durumunu kontrol edin

### Monitoring
- **Dashboard**: Genel durum ve istatistikler
- **Bağlantılar**: Bağlı agent'lar ve mobile client'lar
- **Monitoring**: Performans metrikleri
- **Loglar**: Server ve Redis logları
- **Ayarlar**: Konfigürasyon seçenekleri

### Menü Kısayolları
- `Ctrl+S`: Server'ı başlat
- `Ctrl+Shift+S`: Server'ı durdur
- `Ctrl+,`: Ayarlar
- `F12`: Geliştirici araçları
- `F11`: Tam ekran

## Güvenlik

- Context isolation aktif
- Node integration devre dışı
- Güvenli IPC iletişimi
- HTTPS zorunlu
- SSL sertifika doğrulaması

## Sorun Giderme

### Redis Başlatma Sorunları
```bash
# Redis'i manuel kurulum
npm run setup-redis

# Redis durumunu kontrol et
npm run redis:cli
```

### Server Başlatma Sorunları
- Port 443'ün kullanımda olup olmadığını kontrol edin
- SSL sertifikalarının mevcut olduğunu kontrol edin
- Yönetici yetkileriyle çalıştırın (Windows)

### Build Sorunları
```bash
# Node modules'ları temizle
rm -rf node_modules
npm install

# Electron rebuild
npm run postinstall
```

## Performans

### Sistem Gereksinimleri
- **Minimum**: 2GB RAM, 1GB disk alanı
- **Önerilen**: 4GB RAM, 2GB disk alanı
- **CPU**: Çift çekirdek veya üzeri

### Optimizasyon
- Worker thread'ler CPU yoğun işlemler için
- Redis batch processing
- Clustering desteği
- Memory leak koruması

## Lisans

MIT License - Detaylar için LICENSE dosyasına bakın.

## Destek

Sorunlar için GitHub Issues kullanın veya geliştirici ekibiyle iletişime geçin.

## Changelog

### v2.0.0
- Electron desktop uygulaması eklendi
- Modern UI tasarımı
- Real-time monitoring
- Çapraz platform desteği
- Otomatik Redis kurulumu
- Portable executable desteği