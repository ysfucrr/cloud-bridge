/**
 * Redis Service Configuration
 * 
 * Provides Redis connection management and utilities
 * for the Cloud Bridge Server
 */

const Redis = require('ioredis');
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

class RedisService {
  constructor(config = {}) {
    this.config = {
      host: config.host || process.env.REDIS_HOST || 'localhost',
      port: config.port || process.env.REDIS_PORT || 6379,
      password: config.password || process.env.REDIS_PASSWORD,
      db: config.db || process.env.REDIS_DB || 0,
      keyPrefix: config.keyPrefix || 'cloud-bridge:',
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis connection retry attempt ${times}, waiting ${delay}ms`);
        return delay;
      },
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      ...config
    };

    this.pubClient = null;
    this.subClient = null;
    this.client = null;
  }

  async connect() {
    try {
      // Main client for general operations
      this.client = new Redis(this.config);
      
      // Pub/Sub clients for Socket.IO adapter
      this.pubClient = new Redis(this.config);
      this.subClient = new Redis(this.config);

      // Error handlers
      this.client.on('error', (err) => {
        logger.error('Redis client error:', err);
      });

      this.pubClient.on('error', (err) => {
        logger.error('Redis pub client error:', err);
      });

      this.subClient.on('error', (err) => {
        logger.error('Redis sub client error:', err);
      });

      // Connection handlers - sadece debug modunda logla
      this.client.on('connect', () => {
        logger.debug('Redis client connected');
      });

      this.pubClient.on('connect', () => {
        logger.debug('Redis pub client connected');
      });

      this.subClient.on('connect', () => {
        logger.debug('Redis sub client connected');
      });

      // Wait for connections
      await Promise.all([
        this.client.ping(),
        this.pubClient.ping(),
        this.subClient.ping()
      ]);

      logger.info('Redis connections established');
      return true;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  // Register watch management
  async addWatch(clientId, registerKey) {
    const pipeline = this.client.pipeline();
    
    // Add to client's watch list
    pipeline.sadd(`client:${clientId}:watches`, registerKey);
    
    // Add client to register's watcher list
    pipeline.sadd(`register:${registerKey}:watchers`, clientId);
    
    // Get watcher count
    pipeline.scard(`register:${registerKey}:watchers`);
    
    const results = await pipeline.exec();
    const watcherCount = results[2][1];
    
    return watcherCount === 1; // Returns true if this is the first watcher
  }

  async removeWatch(clientId, registerKey) {
    const pipeline = this.client.pipeline();
    
    // Remove from client's watch list
    pipeline.srem(`client:${clientId}:watches`, registerKey);
    
    // Remove client from register's watcher list
    pipeline.srem(`register:${registerKey}:watchers`, clientId);
    
    // Get remaining watcher count
    pipeline.scard(`register:${registerKey}:watchers`);
    
    const results = await pipeline.exec();
    const remainingWatchers = results[2][1];
    
    return remainingWatchers === 0; // Returns true if no watchers remain
  }

  async removeClient(clientId) {
    // Get all watches for this client
    const watches = await this.client.smembers(`client:${clientId}:watches`);
    const removedRegisters = [];
    
    if (watches.length > 0) {
      const pipeline = this.client.pipeline();
      
      for (const registerKey of watches) {
        // Remove client from each register's watcher list
        pipeline.srem(`register:${registerKey}:watchers`, clientId);
        
        // Check if any watchers remain
        pipeline.scard(`register:${registerKey}:watchers`);
      }
      
      // Delete client's watch list
      pipeline.del(`client:${clientId}:watches`);
      
      const results = await pipeline.exec();
      
      // Check which registers have no watchers left
      for (let i = 0; i < watches.length; i++) {
        const watcherCount = results[i * 2 + 1][1];
        if (watcherCount === 0) {
          removedRegisters.push(watches[i]);
        }
      }
    }
    
    return removedRegisters;
  }

  async getWatchers(registerKey) {
    return await this.client.smembers(`register:${registerKey}:watchers`);
  }

  // Agent management for cluster-wide visibility
  async addAgent(socketId, agentInfo = {}) {
    const agentData = {
      socketId,
      connectedAt: Date.now(),
      workerId: process.pid,
      lastPing: Date.now(),
      ...agentInfo
    };
    
    // Önce eski kayıtları temizle (eğer varsa)
    await this.removeAgent(socketId);
    
    await this.client.hset('agents', socketId, JSON.stringify(agentData));
    await this.client.sadd('agent:ids', socketId);
    
    logger.info(`Agent registered in Redis: ${socketId}`);
  }

  async removeAgent(socketId) {
    const removed = await this.client.hdel('agents', socketId);
    const removedFromSet = await this.client.srem('agent:ids', socketId);
    
    if (removed || removedFromSet) {
      logger.info(`Agent removed from Redis: ${socketId}`);
    }
    
    return removed || removedFromSet;
  }

  // Agent health check - stale agent'ları temizle
  async cleanStaleAgents(maxAge = 60000) { // 60 saniye
    const now = Date.now();
    const agentIds = await this.client.smembers('agent:ids');
    const staleAgents = [];
    
    if (agentIds.length > 0) {
      const pipeline = this.client.pipeline();
      
      for (const id of agentIds) {
        pipeline.hget('agents', id);
      }
      
      const results = await pipeline.exec();
      
      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (!err && data) {
          try {
            const agent = JSON.parse(data);
            const age = now - (agent.lastPing || agent.connectedAt);
            
            if (age > maxAge) {
              staleAgents.push(agentIds[i]);
              logger.warn(`Stale agent detected: ${agentIds[i]} (age: ${Math.floor(age/1000)}s)`);
            }
          } catch (e) {
            // Parse hatası varsa bu agent'ı da temizle
            staleAgents.push(agentIds[i]);
          }
        } else {
          // Data yoksa bu agent'ı temizle
          staleAgents.push(agentIds[i]);
        }
      }
    }
    
    // Stale agent'ları temizle
    for (const agentId of staleAgents) {
      await this.removeAgent(agentId);
    }
    
    if (staleAgents.length > 0) {
      logger.info(`Cleaned ${staleAgents.length} stale agents from Redis`);
    }
    
    return staleAgents.length;
  }

  // Agent ping update
  async updateAgentPing(socketId) {
    const agentData = await this.client.hget('agents', socketId);
    if (agentData) {
      try {
        const agent = JSON.parse(agentData);
        agent.lastPing = Date.now();
        await this.client.hset('agents', socketId, JSON.stringify(agent));
      } catch (e) {
        logger.error(`Failed to update agent ping for ${socketId}:`, e);
      }
    }
  }

  async getAgentCount() {
    return await this.client.scard('agent:ids');
  }

  async getAgents() {
    const agentIds = await this.client.smembers('agent:ids');
    const agents = [];
    
    if (agentIds.length > 0) {
      const pipeline = this.client.pipeline();
      
      for (const id of agentIds) {
        pipeline.hget('agents', id);
      }
      
      const results = await pipeline.exec();
      
      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (!err && data) {
          try {
            agents.push(JSON.parse(data));
          } catch (e) {
            logger.error(`Failed to parse agent data for ${agentIds[i]}:`, e);
          }
        }
      }
    }
    
    return agents;
  }

  async getFirstAgent() {
    const agentIds = await this.client.smembers('agent:ids');
    if (agentIds.length === 0) return null;
    
    const agentData = await this.client.hget('agents', agentIds[0]);
    if (!agentData) return null;
    
    try {
      return JSON.parse(agentData);
    } catch (e) {
      logger.error('Failed to parse agent data:', e);
      return null;
    }
  }

  // Clear all agent records - used on server startup
  async clearAllAgents() {
    const pipeline = this.client.pipeline();
    
    // Delete agent hash and set
    pipeline.del('agents');
    pipeline.del('agent:ids');
    
    // Clear all watch-related data
    // Get all keys matching watch patterns - prefix dahil
    const keyPrefix = this.config.keyPrefix || 'cloud-bridge:';
    const clientWatchKeys = await this.client.keys(`${keyPrefix}client:*:watches`);
    const registerWatcherKeys = await this.client.keys(`${keyPrefix}register:*:watchers`);
    const mobileKeys = await this.client.keys(`${keyPrefix}mobile:*`);
    
    // Delete all watch-related keys - prefix'i kaldırarak sil
    if (clientWatchKeys.length > 0) {
      for (const key of clientWatchKeys) {
        // Prefix'i kaldır
        const keyWithoutPrefix = key.replace(keyPrefix, '');
        pipeline.del(keyWithoutPrefix);
      }
    }
    
    if (registerWatcherKeys.length > 0) {
      for (const key of registerWatcherKeys) {
        // Prefix'i kaldır
        const keyWithoutPrefix = key.replace(keyPrefix, '');
        pipeline.del(keyWithoutPrefix);
      }
    }
    
    if (mobileKeys.length > 0) {
      for (const key of mobileKeys) {
        // Prefix'i kaldır
        const keyWithoutPrefix = key.replace(keyPrefix, '');
        pipeline.del(keyWithoutPrefix);
      }
    }
    
    await pipeline.exec();
    
    logger.info('All agent records and watch data cleared from Redis');
  }

  // Performance metrics
  async updateMetrics(key, value) {
    await this.client.hset('metrics', key, value);
  }

  async getMetrics() {
    return await this.client.hgetall('metrics');
  }

  // Batch queue management
  async enqueueBatch(batch) {
    const serialized = JSON.stringify(batch);
    await this.client.rpush('batch:queue', serialized);
  }

  async dequeueBatch(count = 50) {
    const items = [];
    const pipeline = this.client.pipeline();
    
    for (let i = 0; i < count; i++) {
      pipeline.lpop('batch:queue');
    }
    
    const results = await pipeline.exec();
    
    for (const [err, item] of results) {
      if (!err && item) {
        try {
          items.push(JSON.parse(item));
        } catch (e) {
          logger.error('Failed to parse batch item:', e);
        }
      }
    }
    
    return items;
  }

  async getQueueSize() {
    return await this.client.llen('batch:queue');
  }

  // Connection status
  isConnected() {
    return this.client && this.client.status === 'ready';
  }

  // Graceful shutdown
  async disconnect() {
    logger.info('Disconnecting Redis clients...');
    
    if (this.client) await this.client.quit();
    if (this.pubClient) await this.pubClient.quit();
    if (this.subClient) await this.subClient.quit();
    
    logger.info('Redis clients disconnected');
  }

  // Get clients for Socket.IO adapter
  getAdapterClients() {
    return {
      pubClient: this.pubClient,
      subClient: this.subClient
    };
  }
}

// Export singleton instance
module.exports = new RedisService();