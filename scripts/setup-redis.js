const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const REDIS_VERSION = '3.0.504';
const REDIS_URL = `https://github.com/microsoftarchive/redis/releases/download/win-${REDIS_VERSION}/Redis-x64-${REDIS_VERSION}.zip`;

console.log('Setting up Redis for SCADA application...');

// Redis klasörünü oluştur
const redisDir = path.join(__dirname, '..', 'redis');
if (!fs.existsSync(redisDir)) {
    fs.mkdirSync(redisDir, { recursive: true });
}

// Redis konfigürasyon dosyası oluştur (Redis 3.0 compatible)
const redisConf = `# Redis configuration for SCADA (Redis 3.0 compatible)
port 6379
daemonize no
loglevel notice
databases 16
# Kalıcı depolama kapatıldı - MongoDB kullanıldığı için Redis snapshot'larına gerek yok
save ""
dbfilename dump.rdb
dir ./
appendonly no`;

fs.writeFileSync(path.join(redisDir, 'redis.conf'), redisConf);

console.log('Redis configuration created.');

// Redis binary'sini indir (Windows için)
console.log('Downloading Redis binary...');

const downloadRedis = () => {
    return new Promise((resolve, reject) => {
        const filePath = path.join(redisDir, 'redis.zip');
        const file = fs.createWriteStream(filePath);

        const request = https.get(REDIS_URL, (response) => {
            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize > 0) {
                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    process.stdout.write(`\rDownload progress: ${progress}%`);
                }
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log('\nRedis download completed.');

                // Dosya boyutunu kontrol et
                const stats = fs.statSync(filePath);
                console.log(`Downloaded file size: ${stats.size} bytes`);

                if (stats.size < 1000000) { // 1MB'den küçükse muhtemelen bozuk
                    console.log('Warning: Downloaded file seems too small, might be corrupted');
                    fs.unlinkSync(filePath);
                    reject(new Error('Downloaded file is too small'));
                } else {
                    resolve();
                }
            });
        });

        request.on('error', (err) => {
            console.error('Download error:', err.message);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            reject(err);
        });

        // Timeout ekle
        request.setTimeout(30000, () => {
            console.error('Download timeout');
            request.destroy();
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            reject(new Error('Download timeout'));
        });
    });
};

// Zip'i çıkar
const extractRedis = () => {
    try {
        console.log('Extracting Redis...');

        // İlk olarak PowerShell ile dene
        try {
            const psCommand = `powershell -command "Expand-Archive -Path '${path.join(redisDir, 'redis.zip').replace(/\\/g, '\\\\')}' -DestinationPath '${redisDir.replace(/\\/g, '\\\\')}' -Force"`;
            execSync(psCommand, { stdio: 'inherit' });
            console.log('PowerShell extraction successful.');
        } catch (psError) {
            console.log('PowerShell extraction failed, trying 7zip...');

            // 7zip ile dene
            try {
                execSync(`7z x "${path.join(redisDir, 'redis.zip')}" -o"${redisDir}" -y`, { stdio: 'inherit' });
                console.log('7zip extraction successful.');
            } catch (zipError) {
                console.log('7zip not available. Please extract manually.');
                throw new Error('Extraction tools not available');
            }
        }

        // Redis-server.exe'yi ana dizine taşı
        const extractedDir = path.join(redisDir, `Redis-x64-${REDIS_VERSION}`);
        if (fs.existsSync(extractedDir)) {
            const redisServer = path.join(extractedDir, 'redis-server.exe');
            if (fs.existsSync(redisServer)) {
                fs.copyFileSync(redisServer, path.join(redisDir, 'redis-server.exe'));
                console.log('Redis server extracted successfully.');
            } else {
                console.log('redis-server.exe not found in extracted directory');
                throw new Error('redis-server.exe not found');
            }
        } else {
            console.log(`Extracted directory not found: ${extractedDir}`);
            console.log('Available directories:', fs.readdirSync(redisDir));
            throw new Error('Extraction directory not found');
        }

        // Zip dosyasını sil
        if (fs.existsSync(path.join(redisDir, 'redis.zip'))) {
            fs.unlinkSync(path.join(redisDir, 'redis.zip'));
        }
        console.log('Cleanup completed.');
    } catch (error) {
        console.error('Error extracting Redis:', error.message);
        console.log('\n=== MANUAL EXTRACTION REQUIRED ===');
        console.log('Please follow these steps:');
        console.log(`1. Go to folder: ${redisDir}`);
        console.log('2. Right-click redis.zip and extract it');
        console.log('3. Open the extracted folder: Redis-x64-7.2.4');
        console.log('4. Copy redis-server.exe to the redis/ folder (same level as redis.zip)');
        console.log('5. Run: yarn setup-redis (to complete setup)');
        console.log('\nAfter manual extraction, the redis folder should contain:');
        console.log('- redis.conf');
        console.log('- redis-server.exe');
    }
};

// Setup'ı tamamla
const completeSetup = () => {
    const redisServerPath = path.join(redisDir, 'redis-server.exe');
    const redisConfPath = path.join(redisDir, 'redis.conf');

    if (fs.existsSync(redisServerPath) && fs.existsSync(redisConfPath)) {
        console.log('✅ Redis setup completed successfully!');
        console.log('Available commands:');
        console.log('- yarn electron-dev (development with Redis)');
        console.log('- yarn electron:package:win (package with Redis)');
        return true;
    } else {
        console.log('❌ Redis setup incomplete. Missing files:');
        if (!fs.existsSync(redisServerPath)) console.log('- redis-server.exe');
        if (!fs.existsSync(redisConfPath)) console.log('- redis.conf');
        console.log('\nPlease complete manual extraction first.');
        return false;
    }
};

// Alternatif download method
const downloadWithCurl = () => {
    return new Promise((resolve, reject) => {
        const filePath = path.join(redisDir, 'redis.zip');
        const { spawn } = require('child_process');

        console.log('Trying download with curl...');
        const curl = spawn('curl', ['-L', '-o', filePath, REDIS_URL], { stdio: 'inherit' });

        curl.on('close', (code) => {
            if (code === 0) {
                const stats = fs.statSync(filePath);
                console.log(`Curl download completed. File size: ${stats.size} bytes`);
                if (stats.size > 1000000) {
                    resolve();
                } else {
                    fs.unlinkSync(filePath);
                    reject(new Error('Downloaded file too small'));
                }
            } else {
                reject(new Error(`Curl failed with code ${code}`));
            }
        });

        curl.on('error', (err) => {
            reject(err);
        });
    });
};

// Ana fonksiyon
async function setup() {
    // Eğer redis-server.exe varsa, setup tamamlandı demektir
    if (fs.existsSync(path.join(redisDir, 'redis-server.exe'))) {
        console.log('Redis already set up, completing...');
        completeSetup();
        return;
    }

    try {
        console.log('Step 1: Downloading Redis...');
        try {
            await downloadRedis();
        } catch (httpsError) {
            console.log('HTTPS download failed, trying curl...');
            await downloadWithCurl();
        }

        console.log('Step 2: Extracting Redis...');
        extractRedis();

        completeSetup();
    } catch (error) {
        console.error('❌ Automatic setup failed:', error.message);
        console.log('\n=== MANUAL DOWNLOAD REQUIRED ===');
        console.log('Please download Redis manually:');
        console.log(`URL: ${REDIS_URL}`);
        console.log(`Save as: ${path.join(redisDir, 'redis.zip')}`);
        console.log('\nThen run: yarn setup-redis');
        console.log('\n=== ALTERNATIVE: USE DOCKER ===');
        console.log('If manual download fails, use Docker:');
        console.log('docker run -d -p 6379:6379 redis:alpine');
        console.log('Then comment out Redis startup in electron/main.ts');
    }
}

setup();