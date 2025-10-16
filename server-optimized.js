/**
 * Cloud Bridge Server - High Performance Clustered Version
 * 
 * Optimized for handling 500-600+ register updates without blocking
 * Features:
 * - Multi-core clustering with sticky sessions
 * - Batch processing for register updates
 * - Rate limiting and backpressure handling
 * - Redis for distributed state management
 * - Worker threads for CPU-intensive tasks
 * - Advanced monitoring and metrics
 */

const cluster = require('cluster');
const os = require('os');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const compression = require('compression');
const { Worker } = require('worker_threads');
const pino = require('pino');
const rateLimit = require('express-rate-limit');
const path = require('path');
const redisService = require('./redis-service');

// Performance monitoring
const prometheus = require('prom-client');

// Configuration
const CONFIG = {
  HTTPS_PORT: process.env.HTTPS_PORT || 443,
  REQUEST_TIMEOUT: 60000, // 60 saniye - büyük veri transferleri için artırıldı
  BATCH_SIZE: 50, // Process register updates in batches
  BATCH_INTERVAL: 100, // ms between batch processing
  MAX_QUEUE_SIZE: 10000, // Maximum queued updates
  WORKER_COUNT: process.env.WORKER_COUNT || 1, // Tek worker kullan - cross-worker sorunlarını önlemek için
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX: 1000, // Max requests per window
  WORKER_POOL_SIZE: 4, // Number of worker threads for processing
  SHOW_STARTUP_INFO: process.env.SHOW_STARTUP_INFO !== 'false', // Başlangıç bilgilerini göster
};

// High-performance logger
const logger = pino({
  level: CONFIG.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

// Prometheus metrics
const metrics = {
  registerUpdates: new prometheus.Counter({
    name: 'cloud_bridge_register_updates_total',
    help: 'Total number of register updates processed',
    labelNames: ['status']
  }),
  batchProcessingTime: new prometheus.Histogram({
    name: 'cloud_bridge_batch_processing_duration_seconds',
    help: 'Time taken to process a batch of updates',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
  }),
  activeConnections: new prometheus.Gauge({
    name: 'cloud_bridge_active_connections',
    help: 'Number of active connections',
    labelNames: ['type']
  }),
  queueSize: new prometheus.Gauge({
    name: 'cloud_bridge_queue_size',
    help: 'Current size of the update queue'
  }),
  workerPoolUtilization: new prometheus.Gauge({
    name: 'cloud_bridge_worker_pool_utilization',
    help: 'Worker thread pool utilization percentage'
  })
};

// Register default metrics
prometheus.collectDefaultMetrics();

// Worker thread pool for CPU-intensive tasks
class WorkerPool {
  constructor(size, workerScript) {
    this.size = size;
    this.workerScript = workerScript;
    this.workers = [];
    this.queue = [];
    this.activeWorkers = 0;
    this.init();
  }

  init() {
    for (let i = 0; i < this.size; i++) {
      this.createWorker();
    }
  }

  createWorker() {
    const worker = new Worker(this.workerScript);
    
    worker.on('message', (message) => {
      if (message.type === 'ready') {
        worker.ready = true;
        this.processQueue();
      } else {
        const { resolve, reject } = worker.currentTask;
        if (message.type === 'success') {
          resolve(message.result);
        } else {
          reject(new Error(message.error.message));
        }
        worker.ready = true;
        worker.currentTask = null;
        this.activeWorkers--;
        this.updateUtilization();
        this.processQueue();
      }
    });

    worker.on('error', (error) => {
      logger.error('Worker error:', error);
      if (worker.currentTask) {
        worker.currentTask.reject(error);
        this.activeWorkers--;
      }
      this.workers = this.workers.filter(w => w !== worker);
      this.createWorker(); // Replace failed worker
    });

    worker.ready = false;
    this.workers.push(worker);
  }

  processQueue() {
    const availableWorker = this.workers.find(w => w.ready);
    if (!availableWorker || this.queue.length === 0) return;

    const task = this.queue.shift();
    availableWorker.ready = false;
    availableWorker.currentTask = task;
    this.activeWorkers++;
    this.updateUtilization();
    availableWorker.postMessage(task.message);
  }

  updateUtilization() {
    const utilization = (this.activeWorkers / this.size) * 100;
    metrics.workerPoolUtilization.set(utilization);
  }

  execute(type, data) {
    return new Promise((resolve, reject) => {
      const message = {
        id: uuidv4(),
        type,
        data
      };

      this.queue.push({ message, resolve, reject });
      this.processQueue();
    });
  }

  terminate() {
    this.workers.forEach(worker => worker.terminate());
  }
}

if (cluster.isMaster) {
  if (CONFIG.SHOW_STARTUP_INFO) {
    console.log('\n========================================');
    console.log(' Cloud Bridge Server Starting...');
    console.log('========================================');
    console.log(` Port: ${CONFIG.HTTPS_PORT} (HTTPS only)`);
    console.log(` Workers: ${CONFIG.WORKER_COUNT}`);
    console.log(` Log Level: ${CONFIG.LOG_LEVEL}`);
    console.log(` Request Timeout: ${CONFIG.REQUEST_TIMEOUT / 1000}s`);
    console.log('========================================\n');
  }
  
  logger.info(`Master process ${process.pid} starting with ${CONFIG.WORKER_COUNT} workers...`);

  // Initialize Redis connection in master
  redisService.connect().then(async () => {
    logger.debug('Master: Redis connection established');
    
    // Clear all agent records on server startup
    await redisService.clearAllAgents();
    logger.info('Master: Cleared all agent records on startup');
  }).catch(err => {
    logger.error('Master: Failed to connect to Redis:', err);
    process.exit(1);
  });

  // Fork workers
  for (let i = 0; i < CONFIG.WORKER_COUNT; i++) {
    const worker = cluster.fork();
    logger.debug(`Worker ${worker.process.pid} started`);
  }

  // Handle worker crashes
  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Master received SIGTERM, shutting down gracefully...');
    redisService.disconnect();
    for (const id in cluster.workers) {
      cluster.workers[id].send('shutdown');
    }
  });

} else {
  // Worker process
  startWorker();
}

async function startWorker() {
  logger.debug(`Worker ${process.pid} starting...`);

  // Connect to Redis
  try {
    await redisService.connect();
    logger.debug(`Worker ${process.pid}: Redis connection established`);
  } catch (err) {
    logger.error(`Worker ${process.pid}: Failed to connect to Redis:`, err);
    process.exit(1);
  }

  // Get Redis clients for Socket.IO adapter
  const { pubClient, subClient } = redisService.getAdapterClients();
  
  // Initialize Express app
  const app = express();
  app.use(express.json({ limit: '10mb' })); // Increased limit for batch updates
  app.use(cors());
  
  // Rate limiting
  const limiter = rateLimit({
    windowMs: CONFIG.RATE_LIMIT_WINDOW,
    max: CONFIG.RATE_LIMIT_MAX,
    message: 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);
  
  // Compression with optimized settings
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) {
        return false;
      }
      return compression.filter(req, res);
    }
  }));

  // SSL sertifikalarını dinamik olarak yükle
  function loadSSLCertificates() {
    // Paketlenmiş uygulamada ssl-settings.json dosyasını userData klasöründe ara
    let settingsPath;
    let defaultCertPath;
    
    // Electron uygulaması içinde mi kontrol et
    const isElectronApp = process.env.ELECTRON_RUN_AS_NODE || process.versions.electron;
    
    if (isElectronApp) {
      // Electron uygulaması
      if (__dirname.includes('app.asar.unpacked')) {
        // Paketlenmiş uygulamada, sertifikaları doğrudan app.asar.unpacked içindeki Certificates klasöründen oku
        defaultCertPath = path.join(__dirname, 'Certificates');
        logger.info(`Sertifika yolu (paketlenmiş): ${defaultCertPath}`);
      } else {
        // Geliştirme ortamı
        defaultCertPath = path.join(__dirname, '..', 'Certificates');
        logger.info(`Sertifika yolu (geliştirme): ${defaultCertPath}`);
      }
      
      // SSL ayarları için userData klasörünü kullan (Windows)
      const userDataPath = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'SCADA Cloud Bridge Server')
        : path.join(__dirname, '..');
      settingsPath = path.join(userDataPath, 'ssl-settings.json');
      
      logger.info('Electron SSL yolları:', {
        dirname: __dirname,
        certificates: defaultCertPath,
        settings: settingsPath
      });
    } else {
      // Standalone Node.js uygulaması
      settingsPath = path.join(__dirname, 'ssl-settings.json');
      defaultCertPath = path.join(__dirname, 'Certificates');
    }
    
    let sslConfig = {
      type: 'local', // 'local' veya 'cloudflare'
      certificatePath: defaultCertPath,
      keyFile: 'imajstone.com-key.pem',
      certFile: 'imajstone.com-crt.pem',
      caFile: 'imajstone.com-chain-only.pem',
      cloudflareOriginCert: null,
      cloudflareOriginKey: null
    };

    // Ayarlar dosyası varsa yükle
    if (fs.existsSync(settingsPath)) {
      try {
        const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        sslConfig = { ...sslConfig, ...savedSettings };
        logger.info('SSL ayarları yüklendi:', { type: sslConfig.type, path: sslConfig.certificatePath });
      } catch (error) {
        logger.warn('SSL ayarları yüklenemedi, varsayılan ayarlar kullanılıyor:', error.message);
      }
    } else {
      logger.info('SSL ayarları bulunamadı, varsayılan ayarlar kullanılıyor:', { path: defaultCertPath });
    }

    let httpsOptions;

    if (sslConfig.type === 'cloudflare' && sslConfig.cloudflareOriginCert && sslConfig.cloudflareOriginKey) {
      // Cloudflare Origin Certificate kullan
      httpsOptions = {
        key: sslConfig.cloudflareOriginKey,
        cert: sslConfig.cloudflareOriginCert
      };
      logger.info('Cloudflare Origin Certificate kullanılıyor');
    } else {
      // Yerel sertifika dosyalarını kullan
      const keyPath = path.join(sslConfig.certificatePath, sslConfig.keyFile);
      const certPath = path.join(sslConfig.certificatePath, sslConfig.certFile);
      const caPath = path.join(sslConfig.certificatePath, sslConfig.caFile);

      // Dosyaların varlığını kontrol et ve detaylı log tut
      logger.info(`SSL dosya yolları kontrol ediliyor:`, {
        keyPath,
        certPath,
        caPath,
        dirname: __dirname,
        certPathExists: fs.existsSync(sslConfig.certificatePath)
      });

      if (!fs.existsSync(keyPath)) {
        throw new Error(`SSL key dosyası bulunamadı: ${keyPath}`);
      }
      if (!fs.existsSync(certPath)) {
        throw new Error(`SSL cert dosyası bulunamadı: ${certPath}`);
      }

      httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };

      // CA dosyası varsa ekle
      if (fs.existsSync(caPath)) {
        httpsOptions.ca = fs.readFileSync(caPath);
        logger.info('SSL sertifikaları yüklendi (CA dahil):', { keyPath, certPath, caPath });
      } else {
        logger.info('SSL sertifikaları yüklendi (CA olmadan):', { keyPath, certPath });
      }
    }

    return httpsOptions;
  }

  const httpsOptions = loadSSLCertificates();
  
  // Sadece HTTPS sunucusu oluştur
  const httpsServer = https.createServer(httpsOptions, app);

  // Socket.IO yapılandırma ayarları
  const ioOptions = {
    cors: {
      origin: '*', // Allow connections from any origin
      methods: ['GET', 'POST']
    },
    // Performance optimizations - hem websocket hem polling destekle
    transports: ['websocket', 'polling'], // Orijinal gibi her ikisini de destekle
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: {
        level: 6
      }
    },
    // Büyük veri transferleri için timeout ayarları
    pingTimeout: 60000,   // 60 saniye - client'ın pong göndermesi için bekleme süresi
    pingInterval: 25000,  // 25 saniye - ping gönderme aralığı
    upgradeTimeout: 30000, // 30 saniye - transport upgrade timeout
    maxHttpBufferSize: 1e8 // 100 MB - büyük veri transferleri için
  };
  
  // Set up Socket.IO server - sadece HTTPS sunucusuna bağlantı
  const io = new Server({
    ...ioOptions,
    // Tek bir namespace üzerinden çalışacak şekilde yapılandır
    path: '/socket.io/',
    // Sticky sessions kullan - Redis adapter'ı doğru kullanması için
    allowEIO3: true,
  });
  
  // Socket.IO'yu sadece HTTPS sunucusuna bağla
  io.attach(httpsServer);
  
  logger.debug('Socket.IO server configured to work with HTTPS only');

  // Use Redis adapter for multi-instance support with additional options for reliability
  io.adapter(createAdapter(pubClient, subClient, {
    // Retry communication on error
    requestsTimeout: 5000, // Increase timeout to 5 seconds
    publishRetries: 3,     // Retry up to 3 times on failure
  }));

  logger.debug('Socket.IO Redis adapter configured');

  // Initialize worker pool for processing
  const workerPool = new WorkerPool(
    CONFIG.WORKER_POOL_SIZE,
    path.join(__dirname, 'register-processor-worker.js')
  );

  // Batch processing queue with Redis persistence
  class BatchProcessor {
    constructor(io, workerPool) {
      this.io = io;
      this.workerPool = workerPool;
      this.processing = false;
      this.timer = null;
    }

    async add(data) {
      // Add to Redis queue for persistence
      await redisService.enqueueBatch(data);
      
      // Update metrics
      const queueSize = await redisService.getQueueSize();
      metrics.queueSize.set(queueSize);
      
      if (!this.processing) {
        this.scheduleProcessing();
      }
    }

    scheduleProcessing() {
      if (this.timer) return;
      
      this.timer = setTimeout(() => {
        this.processBatch();
      }, CONFIG.BATCH_INTERVAL);
    }

    async processBatch() {
      if (this.processing) return;
      
      this.processing = true;
      this.timer = null;
      
      const startTime = Date.now();
      
      try {
        // Get batch from Redis queue
        const batch = await redisService.dequeueBatch(CONFIG.BATCH_SIZE);
        
        if (batch.length === 0) {
          this.processing = false;
          return;
        }
        
        // Update metrics
        const queueSize = await redisService.getQueueSize();
        metrics.queueSize.set(queueSize);
        
        // Process batch through worker thread
        const processed = await this.workerPool.execute('PROCESS_BATCH', {
          batch: batch.map(item => item.data),
          options: { validate: true, transform: true }
        });

        // Group updates by client
        const updatesByClient = new Map();
        
        for (let i = 0; i < batch.length; i++) {
          const { registerKey, clientIds } = batch[i];
          const processedData = processed.results[i];
          
          if (processedData) {
            for (const clientId of clientIds) {
              if (!updatesByClient.has(clientId)) {
                updatesByClient.set(clientId, []);
              }
              updatesByClient.get(clientId).push({
                registerKey,
                data: processedData
              });
            }
          }
        }
        
        // Send updates to each client (orijinal format korunuyor)
        for (const [clientId, updates] of updatesByClient) {
          const clientSocket = this.io.sockets.sockets.get(clientId);
          if (clientSocket) {
            // Her bir güncellemeyi ayrı ayrı gönder (orijinal davranış)
            for (const update of updates) {
              clientSocket.emit('register-value', update.data);
            }
          }
        }
        
        // Update metrics
        metrics.registerUpdates.inc({ status: 'success' }, batch.length);
        metrics.batchProcessingTime.observe((Date.now() - startTime) / 1000);
        await redisService.updateMetrics('lastBatchProcessed', Date.now());
        await redisService.updateMetrics('totalProcessed', 
          parseInt(await redisService.client.hget('metrics', 'totalProcessed') || '0') + batch.length
        );
        
      } catch (error) {
        logger.error('Error processing batch:', error);
        metrics.registerUpdates.inc({ status: 'error' }, 0);
      } finally {
        this.processing = false;
        
        // Check if there are more items to process
        const queueSize = await redisService.getQueueSize();
        if (queueSize > 0) {
          this.scheduleProcessing();
        }
      }
    }
  }

  const batchProcessor = new BatchProcessor(io, workerPool);

  // Store connected agents with timestamp and name for diagnostics
  const connectedAgents = new Set();
  const agentConnectTimes = new Map(); // Track when each agent connected
  const agentNames = new Map(); // Track agent names for identification
  const pendingRequests = new Map();
  
  // Log connection stats every 5 minutes for diagnostics (only if there are connections)
  setInterval(async () => {
    if (connectedAgents.size > 0 || (await getClientCount()) > 0) {
      const clientCount = await getClientCount();
      logger.info(`Connections: ${connectedAgents.size} agents, ${clientCount} mobile clients`);
    }
  }, 300000); // 5 dakika

  // Helper function to get a list of connected agents with names
  async function getConnectedAgentsList() {
    const agentsList = [];
    
    for (const agent of connectedAgents) {
      const agentId = agent.id;
      const agentName = agentNames.get(agentId) || `Agent-${agentId.substring(0, 6)}`;
      const connectTime = agentConnectTimes.get(agentId);
      
      agentsList.push({
        id: agentId,
        name: agentName,
        connectedAt: connectTime ? new Date(connectTime).toISOString() : null,
        uptime: connectTime ? Math.floor((Date.now() - connectTime) / 1000) : 0
      });
    }
    
    return agentsList;
  }

  // Diagnostic endpoint - provides detailed information for mobile debugging
  app.get('/api/mobile/diagnostic', async (req, res) => {
    try {
      const { connectedCount, pingableCount } = await checkAgentConnections();
      const mobileClients = await getClientCount();
      const redisConnected = redisService.isConnected();
      
      // Get agent data from local connections (tek worker)
      const agentData = [];
      for (const agent of connectedAgents) {
        const connectTime = agentConnectTimes.get(agent.id);
        const agentName = agentNames.get(agent.id) || `Agent-${agent.id.substring(0, 6)}`;
        
        if (connectTime) {
          agentData.push({
            id: agent.id.substring(0, 8),
            name: agentName,
            connectedAt: new Date(connectTime).toISOString(),
            uptime: Math.floor((Date.now() - connectTime) / 1000),
            transport: agent.conn?.transport?.name || 'unknown'
          });
        }
      }
      
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: {
          version: '1.0.0',
          uptime: process.uptime(),
          pid: process.pid,
          nodejs: process.version,
          platform: process.platform,
          workers: 1 // Tek worker
        },
        connections: {
          agents: {
            connected: connectedCount,
            pingable: pingableCount,
            sampleData: agentData.slice(0, 3) // Only show up to 3 samples
          },
          mobileClients,
          redis: {
            connected: redisConnected
          }
        },
        ports: {
          https: CONFIG.HTTPS_PORT
        }
      });
    } catch (error) {
      logger.error('Error in diagnostic endpoint:', error);
      res.status(500).json({
        error: 'Internal error while fetching diagnostics',
        message: error.message
      });
    }
  });

  // Health check endpoint
  app.get('/health', async (req, res) => {
    const redisMetrics = await redisService.getMetrics();
    const queueSize = await redisService.getQueueSize();
    const { connectedCount, pingableCount } = await checkAgentConnections();
    
    // Get connected agent names
    const connectedAgentNames = [];
    for (const agent of connectedAgents) {
      const agentName = agentNames.get(agent.id) || `Agent-${agent.id.substring(0, 6)}`;
      connectedAgentNames.push(agentName);
    }
    
    const health = {
      status: 'ok',
      worker: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: {
        agents: {
          total: connectedCount,
          responsive: pingableCount,
          names: connectedAgentNames
        },
        clients: await getClientCount()
      },
      queue: {
        size: queueSize,
        processing: batchProcessor.processing
      },
      redis: {
        connected: redisService.isConnected(),
        metrics: redisMetrics
      },
      workerPool: {
        utilization: metrics.workerPoolUtilization._getValue() || 0
      },
      timestamp: new Date().toISOString()
    };
    
    res.json(health);
  });
  
  // Agent list endpoint for mobile clients
  app.get('/api/mobile/agents', async (req, res) => {
    try {
      const agentList = await getConnectedAgentsList();
      
      res.json({
        status: 'ok',
        count: agentList.length,
        agents: agentList
      });
    } catch (error) {
      logger.error('Error in agent list endpoint:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  });

  // Metrics endpoint
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', prometheus.register.contentType);
    res.end(await prometheus.register.metrics());
  });

  // Yardımcı fonksiyon: Agent bağlantı durumunu kontrol et - Tek worker için basitleştirilmiş
  async function checkAgentConnections() {
    let connectedCount = connectedAgents.size;
    let pingableCount = 0;
    
    for (const agent of connectedAgents) {
      try {
        // Agent'a ping gönder ve cevap gelip gelmediğini kontrol et
        const pongReceived = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve(false); // Zaman aşımı - pong alınamadı
          }, 1000);
          
          agent.emit('ping', () => {
            clearTimeout(timeout);
            resolve(true); // Pong alındı
          });
        });
        
        if (pongReceived) {
          pingableCount++;
        }
      } catch (err) {
        logger.error(`Error pinging agent ${agent.id}:`, err);
      }
    }
    
    return { connectedCount, pingableCount };
  }
  
  // Düzenli olarak agent bağlantılarını kontrol et (her 30 saniyede bir)
  setInterval(async () => {
    try {
      // Tek worker olduğu için sadece local agent'ları kontrol et
      if (connectedAgents.size > 0) {
        const { connectedCount, pingableCount } = await checkAgentConnections();
        
        if (connectedCount > 0 && pingableCount === 0) {
          logger.warn(`Agents appear connected (${connectedCount}) but none responded to ping.`);
        } else if (connectedCount > 0 && pingableCount > 0) {
          logger.debug(`Agent ping check: ${pingableCount}/${connectedCount} responded`);
        }
      }
    } catch (error) {
      logger.error('Error in agent health check:', error);
    }
  }, 30000); // 30 saniye

  // Main proxy API endpoint with agent selection support
  app.use('/api/proxy', async (req, res) => {
    // Tek worker olduğu için sadece local agent'ları kontrol et
    if (connectedAgents.size === 0) {
      logger.warn('API request received but no agents connected');
      
      return res.status(503).json({
        error: 'No Agent Connected',
        message: 'There are no SCADA agents currently connected to the bridge.'
      });
    }

    let method, path, body, targetAgentId;
    
    if (req.method === 'POST') {
      ({ method, path, body, targetAgentId } = req.body);
      // Add debug logging for login requests
      if (path && path.includes('/api/mobile-users/login')) {
        logger.info(`Login request received for agent: ${targetAgentId}`, {
          path,
          username: body?.username,
          hasTargetAgent: !!targetAgentId
        });
      }
    } else if (req.method === 'GET') {
      method = req.query.method || 'GET';
      path = req.query.path;
      targetAgentId = req.query.targetAgentId;
      try {
        body = req.query.body ? JSON.parse(req.query.body) : {};
      } catch (err) {
        body = {};
      }
    } else {
      return res.status(405).json({
        error: 'Method Not Allowed',
        message: 'Only GET and POST methods are supported'
      });
    }

    if (!path) {
      logger.warn('API request missing path parameter', {
        method: method,
        body: body ? JSON.stringify(body).substring(0, 100) : null
      });
      
      return res.status(400).json({
        error: 'Invalid Request',
        message: 'Path is required'
      });
    }

    try {
      // Belirli bir agent ID'si belirtilmişse onu kullan, yoksa ilk bağlı agent'ı seç
      let selectedAgent;
      
      if (targetAgentId) {
        // Agent ID'sine göre seçim yap
        selectedAgent = Array.from(connectedAgents).find(agent => agent.id === targetAgentId);
        
        // Belirtilen ID ile agent bulunamadıysa hata ver
        if (!selectedAgent) {
          logger.warn(`Requested agent ID ${targetAgentId} is not connected`);
          return res.status(404).json({
            error: 'Agent Not Found',
            message: `The specified agent (${targetAgentId}) is not connected`
          });
        }
        
        // Login işlemleri için özel log
        if (path && path.includes('/api/mobile-users/login')) {
          logger.info(`Routing login request to agent: ${targetAgentId} (${agentNames.get(targetAgentId) || 'Unknown'})`);
        }
      } else {
        // ID belirtilmediyse ilk agent'ı kullan
        selectedAgent = Array.from(connectedAgents)[0];
        logger.warn(`No target agent specified for request to ${path}, using default agent: ${selectedAgent.id}`);
      }
      
      const requestId = uuidv4();
      
      const requestData = {
        requestId,
        method,
        path,
        body: body || {}
      };

      logger.debug(`API request to agent ${selectedAgent.id}: ${method} ${path} (ID: ${requestId})`);

      const result = await new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        
        const timeoutId = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            logger.warn(`API request timeout (ID: ${requestId}): ${method} ${path}`);
            reject(new Error('Request timeout'));
          }
        }, CONFIG.REQUEST_TIMEOUT);
        
        // Debug için login request details
        if (path && path.includes('/api/mobile-users/login')) {
          logger.debug('Sending login request to agent', {
            agentId: selectedAgent.id,
            agentName: agentNames.get(selectedAgent.id) || 'Unknown',
            requestId
          });
        }
        
        selectedAgent.emit('api-request', requestData, (response) => {
          if (response && response.status) {
            clearTimeout(timeoutId);
            pendingRequests.delete(requestId);
            logger.debug(`API response from agent ${selectedAgent.id}: status ${response.status} (ID: ${requestId})`);
            resolve(response);
          } else {
            logger.warn(`Invalid API response format from agent ${selectedAgent.id} (ID: ${requestId})`, { response });
            // Still resolve with what we got to prevent hanging
            clearTimeout(timeoutId);
            pendingRequests.delete(requestId);
            resolve(response || { status: 500, data: { error: 'Invalid response format from agent' } });
          }
        });
      });
      
      logger.debug(`API complete: ${result.status} (ID: ${requestId})`);
      
      // Login response için özel log
      if (path && path.includes('/api/mobile-users/login')) {
        logger.info(`Login response from agent ${selectedAgent.id}: status ${result.status}`, {
          success: result.status === 200,
          agentName: agentNames.get(selectedAgent.id) || 'Unknown'
        });
      }
      
      return res.status(result.status).json(result.data);
      
    } catch (err) {
      logger.error('Error processing API request:', {
        error: err.message,
        stack: err.stack,
        method,
        path,
        bodySize: body ? JSON.stringify(body).length : 0
      });
      return res.status(500).json({
        error: 'Bridge Error',
        message: err.message
      });
    }
  });

  // Socket.IO connection handling
  io.on('connection', async (socket) => {
    const clientIp = socket.handshake.address;
    const protocol = 'https'; // Sadece HTTPS destekleniyor
    const port = CONFIG.HTTPS_PORT;
    
    logger.debug(`New socket connection: ${socket.id} from ${clientIp}`);
    
    // Bağlanan cihazın agent mi yoksa mobile client mi olduğunu belirle
    const isMobileClient = socket.handshake.query && socket.handshake.query.type === 'mobile';
    
    if (isMobileClient) {
      logger.debug(`Mobile client connected: ${socket.id}`);
      metrics.activeConnections.inc({ type: 'mobile' });
      
      // Mobile istemciye özgü izlenen register listesini oluştur
      await redisService.client.sadd(`mobile:${socket.id}`, ''); // Boş set oluştur
      await redisService.client.expire(`mobile:${socket.id}`, 86400); // 24 saat TTL
      
      // Selected agent bilgisini saklamak için bir değişken
      let selectedAgentId = null;
      
      // Mobil istemcinin agent seçme event'i
      socket.on('select-agent', (data) => {
        const { agentId } = data;
        
        // Belirtilen agent ID var mı kontrol et
        const agentExists = Array.from(connectedAgents).some(agent => agent.id === agentId);
        
        if (agentExists) {
          selectedAgentId = agentId;
          logger.debug(`Mobile client ${socket.id} selected agent: ${agentId}`);
          
          // Agent seçimi başarılı olduğunu bildir
          socket.emit('agent-selected', {
            success: true,
            agentId,
            agentName: agentNames.get(agentId) || `Agent-${agentId.substring(0, 6)}`
          });
        } else {
          logger.warn(`Mobile client ${socket.id} tried to select non-existent agent: ${agentId}`);
          
          // Agent seçimi başarısız olduğunu bildir
          socket.emit('agent-selected', {
            success: false,
            error: 'Selected agent not found or not connected'
          });
        }
      });
      
      socket.on('watch-register', async (registerData) => {
        const registerKey = `${registerData.analyzerId}-${registerData.address}`;
        
        const isFirstWatcher = await redisService.addWatch(socket.id, registerKey);
        
        if (isFirstWatcher && connectedAgents.size > 0) {
          // Eğer seçili bir agent varsa ona gönder, yoksa ilk agent'a gönder
          let targetAgent;
          
          if (selectedAgentId) {
            targetAgent = Array.from(connectedAgents).find(agent => agent.id === selectedAgentId);
          }
          
          if (!targetAgent) {
            targetAgent = Array.from(connectedAgents)[0];
          }
          
          targetAgent.emit('watch-register-mobile', registerData);
          logger.debug(`Watch request forwarded to agent ${targetAgent.id}: ${registerKey}`);
        }
      });
      
      socket.on('unwatch-register', async (registerData) => {
        const registerKey = `${registerData.analyzerId}-${registerData.address}`;
        
        const noMoreWatchers = await redisService.removeWatch(socket.id, registerKey);
        
        if (noMoreWatchers && connectedAgents.size > 0) {
          // Eğer seçili bir agent varsa ona gönder, yoksa ilk agent'a gönder
          let targetAgent;
          
          if (selectedAgentId) {
            targetAgent = Array.from(connectedAgents).find(agent => agent.id === selectedAgentId);
          }
          
          if (!targetAgent) {
            targetAgent = Array.from(connectedAgents)[0];
          }
          
          targetAgent.emit('unwatch-register-mobile', registerData);
          logger.debug(`Unwatch complete to agent ${targetAgent.id}: ${registerKey}`);
        }
      });
      
      socket.on('disconnect', async () => {
        logger.debug(`Mobile client disconnected: ${socket.id}`);
        metrics.activeConnections.dec({ type: 'mobile' });
        
        // Clean up all watches for this client
        const removedRegisters = await redisService.removeClient(socket.id);
        
        if (removedRegisters.length > 0 && connectedAgents.size > 0) {
          // Eğer seçili bir agent varsa ona gönder, yoksa ilk agent'a gönder
          let targetAgent;
          
          if (selectedAgentId) {
            targetAgent = Array.from(connectedAgents).find(agent => agent.id === selectedAgentId);
          }
          
          if (!targetAgent) {
            targetAgent = Array.from(connectedAgents)[0];
          }
          
          for (const registerKey of removedRegisters) {
            const [analyzerId, address] = registerKey.split('-');
            targetAgent.emit('unwatch-register-mobile', {
              analyzerId,
              address: parseInt(address)
            });
            logger.debug(`Unwatch notification sent to agent ${targetAgent.id}: ${registerKey}`);
          }
        }
        
        // Mobile istemci listesinden temizle
        await redisService.client.del(`mobile:${socket.id}`);
        
        // Seçili agent bilgisini temizle
        selectedAgentId = null;
      });
      
    } else {
      // Agent connection
      logger.info(`Agent connected from ${clientIp}`);
      metrics.activeConnections.inc({ type: 'agent' });
      
      // Tüm agent bağlantılarını göster ve zaman damgasını kaydet
      connectedAgents.add(socket);
      agentConnectTimes.set(socket.id, Date.now());
      
      logger.info(`Agent count: ${connectedAgents.size}`);
      
      socket.emit('system', {
        message: 'Connected to SCADA Cloud Bridge Server (Optimized)'
      });
      
      socket.on('identify', async (data) => {
        logger.info('Agent identified:', data);
        socket.agentInfo = data;
        
        // Eğer agent ismi belirtilmişse kaydet
        if (data && data.agentName) {
          const agentName = data.agentName;
          agentNames.set(socket.id, agentName);
          logger.info(`Agent name registered: ${socket.id} => ${agentName}`);
        } else {
          // İsim yoksa default bir isim ata
          const defaultName = `Agent-${socket.id.substring(0, 6)}`;
          agentNames.set(socket.id, defaultName);
          logger.info(`No agent name provided, using default: ${defaultName}`);
        }
        
        // Name ataması zaten yukarıda yapıldı
        
        // Agent bağlandığında mevcut tüm watch'ları agent'a bildir
        try {
          // Redis'ten tüm register watcher key'lerini al - prefix dahil
          const keyPrefix = redisService.config.keyPrefix || 'cloud-bridge:';
          logger.info(`Searching for watched registers with prefix: ${keyPrefix}`);
          
          const watcherKeys = await redisService.client.keys(`${keyPrefix}register:*:watchers`);
          logger.info(`Redis KEYS command returned ${watcherKeys.length} results`);
          
          if (watcherKeys.length > 0) {
            logger.info(`Found ${watcherKeys.length} watched registers, notifying agent`);
            
            let notifiedCount = 0;
            for (const key of watcherKeys) {
              logger.debug(`Processing key: ${key}`);
              
              // Prefix'i kaldır ve parse et
              const keyWithoutPrefix = key.replace(keyPrefix, '');
              logger.debug(`Key without prefix: ${keyWithoutPrefix}`);
              
              // Key formatı: register:analyzerId-address:watchers
              const match = keyWithoutPrefix.match(/register:(.+)-(\d+):watchers/);
              if (match) {
                const analyzerId = match[1];
                const address = parseInt(match[2]);
                logger.debug(`Parsed - analyzerId: ${analyzerId}, address: ${address}`);
                
                // Bu register'ı izleyen client var mı kontrol et
                const watchers = await redisService.getWatchers(`${analyzerId}-${address}`);
                logger.debug(`Watchers for ${analyzerId}-${address}: ${watchers.length} clients`);
                
                if (watchers.length > 0) {
                  // Agent'a bu register'ı izlemesini söyle
                  socket.emit('watch-register-mobile', {
                    analyzerId,
                    address
                  });
                  notifiedCount++;
                  logger.info(`Notified agent to watch: ${analyzerId}-${address} (${watchers.length} watchers)`);
                }
              } else {
                logger.warn(`Could not parse key: ${keyWithoutPrefix}`);
              }
            }
            
            logger.info(`Agent notification complete. Notified about ${notifiedCount} registers`);
          } else {
            logger.info('No watched registers found in Redis');
            
            // Redis'teki tüm key'leri kontrol edelim (debug için)
            const allKeys = await redisService.client.keys('*');
            logger.debug(`All keys in Redis: ${allKeys.length} total`);
            const watchRelatedKeys = allKeys.filter(k => k.includes('register') || k.includes('watch') || k.includes('mobile'));
            if (watchRelatedKeys.length > 0) {
              logger.debug('Watch-related keys found:', watchRelatedKeys);
            }
          }
        } catch (error) {
          logger.error('Error notifying agent about existing watches:', error);
          logger.error('Error stack:', error.stack);
        }
      });
      
      // Handle register value updates with batching
      socket.on('forward-register-value', async (data) => {
        const registerKey = `${data.analyzerId}-${data.address}`;
        
        // Get all watchers for this register from Redis
        const watchers = await redisService.getWatchers(registerKey);
        
        if (watchers.length > 0) {
          logger.debug(`Register update: ${registerKey} = ${data.value}`);
          
          // Add to batch queue
          await batchProcessor.add({
            registerKey,
            data,
            clientIds: watchers
          });
          
          logger.debug(`Update queued for ${watchers.length} clients`);
        } else {
          logger.debug(`Unwatched register update ignored: ${registerKey}`);
        }
      });
      
      socket.on('api-response', (response) => {
        const { requestId, status, data } = response;
        logger.debug(`API response received: ${requestId}, status: ${status}`);
        
        const pendingRequest = pendingRequests.get(requestId);
        
        if (pendingRequest) {
          pendingRequest.resolve({ status, data });
          pendingRequests.delete(requestId);
          logger.debug(`Request resolved: ${requestId}`);
        } else {
          logger.warn(`Received API response for unknown request ID: ${requestId}`);
        }
      });
      
      socket.on('disconnect', async (reason) => {
        // Calculate connection duration for diagnostics
        const connectTime = agentConnectTimes.get(socket.id);
        const connectionDuration = connectTime ? Math.floor((Date.now() - connectTime) / 1000) : 0;
        
        logger.info(`Agent disconnected: ${reason} (duration: ${connectionDuration}s)`);
        metrics.activeConnections.dec({ type: 'agent' });
        
        connectedAgents.delete(socket);
        agentConnectTimes.delete(socket.id);
        
        logger.info(`Agent count after disconnect: ${connectedAgents.size}`);
        
        // Reject all pending requests from this agent
        pendingRequests.forEach((request, requestId) => {
          request.reject(new Error('Agent disconnected'));
          pendingRequests.delete(requestId);
        });
      });
      
      socket.on('error', (err) => {
        logger.error('Socket.IO error:', err);
        // We don't delete the agent here because Socket.IO will try to reconnect
      });
      
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: new Date().toISOString() });
      });
    }
  });

  // Helper function to get client count
  async function getClientCount() {
    try {
      const sockets = await io.fetchSockets();
      const mobileCount = sockets.filter(s => s.handshake.query?.type === 'mobile').length;
      logger.debug(`Client counts - Mobile: ${mobileCount}, Agents: ${connectedAgents.size}`);
      return mobileCount;
    } catch (error) {
      logger.error('Error getting client count:', error);
      return 0;
    }
  }

  // Sadece HTTPS sunucusunu başlat
  httpsServer.listen(CONFIG.HTTPS_PORT, () => {
    if (cluster.worker.id === 1) { // Sadece ilk worker'da göster
      logger.info(`Cloud Bridge Server ready on HTTPS port ${CONFIG.HTTPS_PORT}`);
    }
  });

  // Graceful shutdown
  process.on('message', (msg) => {
    if (msg === 'shutdown') {
      logger.info(`Worker ${process.pid} shutting down gracefully...`);
      
      // Stop accepting new connections
      httpsServer.close(() => {
        logger.info('HTTPS server closed');
        
        // Terminate worker pool
        workerPool.terminate();
        
        // Close Redis connection
        redisService.disconnect();
        
        // Close Socket.IO
        io.close(() => {
          process.exit(0);
        });
      });
      
      // Force exit after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    }
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}