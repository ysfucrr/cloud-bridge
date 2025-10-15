/**
 * Real-time Monitoring Dashboard for Cloud Bridge Server
 * 
 * Displays performance metrics, connection status, and system health
 */

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const axios = require('axios');
const https = require('https');

// Configuration
const CONFIG = {
  SERVER_URL: process.env.SERVER_URL || 'https://localhost:443',
  REFRESH_INTERVAL: 1000, // 1 second
  METRICS_HISTORY_SIZE: 60 // Keep last 60 data points
};

// HTTPS agent for localhost connections
const httpsAgent = new https.Agent({
  rejectUnauthorized: false // localhost için sertifika doğrulamasını atla
});

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Cloud Bridge Monitor'
});

// Create grid
const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });

// Metrics history
const metricsHistory = {
  throughput: [],
  queueSize: [],
  connections: { agents: [], clients: [] },
  memory: [],
  cpu: [],
  workerUtilization: []
};

// Create widgets
const throughputChart = grid.set(0, 0, 4, 6, contrib.line, {
  style: { line: "yellow", text: "green", baseline: "black" },
  label: 'Throughput (msg/sec)',
  showLegend: true
});

const queueChart = grid.set(0, 6, 4, 6, contrib.line, {
  style: { line: "cyan", text: "green", baseline: "black" },
  label: 'Queue Size',
  showLegend: true
});

const connectionsChart = grid.set(4, 0, 4, 6, contrib.line, {
  style: { line: "green", text: "green", baseline: "black" },
  label: 'Active Connections',
  showLegend: true
});

const systemChart = grid.set(4, 6, 4, 6, contrib.line, {
  style: { line: "magenta", text: "green", baseline: "black" },
  label: 'System Resources',
  showLegend: true
});

const statusTable = grid.set(8, 0, 4, 6, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'white',
  selectedBg: 'blue',
  interactive: false,
  label: 'System Status',
  width: '30%',
  height: '30%',
  border: { type: "line", fg: "cyan" },
  columnSpacing: 3,
  columnWidth: [20, 20]
});

const logBox = grid.set(8, 6, 4, 6, contrib.log, {
  fg: "green",
  selectedFg: "green",
  label: 'Recent Events',
  border: { type: "line", fg: "cyan" }
});

// Metrics tracking
let lastMetrics = null;
let lastUpdateTime = Date.now();

// Helper functions
function formatBytes(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function calculateThroughput(currentMetrics) {
  if (!lastMetrics) return 0;
  
  const timeDiff = (Date.now() - lastUpdateTime) / 1000; // seconds
  const processed = parseInt(currentMetrics.redis?.metrics?.totalProcessed || 0);
  const lastProcessed = parseInt(lastMetrics.redis?.metrics?.totalProcessed || 0);
  const messagesDiff = processed - lastProcessed;
  
  return messagesDiff / timeDiff;
}

function updateHistory(key, value, maxSize = CONFIG.METRICS_HISTORY_SIZE) {
  if (Array.isArray(metricsHistory[key])) {
    metricsHistory[key].push(value);
    if (metricsHistory[key].length > maxSize) {
      metricsHistory[key].shift();
    }
  } else {
    Object.keys(value).forEach(subKey => {
      if (!metricsHistory[key][subKey]) {
        metricsHistory[key][subKey] = [];
      }
      metricsHistory[key][subKey].push(value[subKey]);
      if (metricsHistory[key][subKey].length > maxSize) {
        metricsHistory[key][subKey].shift();
      }
    });
  }
}

async function fetchMetrics() {
  try {
    // Axios config
    const axiosConfig = {
      timeout: 5000
    };
    
    // localhost için sertifika doğrulamasını atla
    if (CONFIG.SERVER_URL.includes('localhost') || CONFIG.SERVER_URL.includes('127.0.0.1')) {
      axiosConfig.httpsAgent = httpsAgent;
    }
    
    // Fetch health endpoint
    const healthResponse = await axios.get(`${CONFIG.SERVER_URL}/health`, axiosConfig);
    const health = healthResponse.data;
    
    // Calculate metrics
    const throughput = calculateThroughput(health);
    const memoryUsage = health.memory.heapUsed / health.memory.heapTotal * 100;
    const cpuUsage = process.cpuUsage().user / 1000000; // Convert to seconds
    
    // Update history
    updateHistory('throughput', throughput);
    updateHistory('queueSize', health.queue.size);
    updateHistory('connections', health.connections);
    updateHistory('memory', memoryUsage);
    updateHistory('cpu', cpuUsage);
    updateHistory('workerUtilization', health.workerPool?.utilization || 0);
    
    // Update charts
    updateCharts();
    
    // Update status table
    updateStatusTable(health);
    
    // Log important events
    if (health.queue.size > 1000) {
      logBox.log(`⚠️  High queue size: ${health.queue.size}`);
    }
    if (throughput > 100) {
      logBox.log(`🚀 High throughput: ${throughput.toFixed(2)} msg/sec`);
    }
    
    // Store for next calculation
    lastMetrics = health;
    lastUpdateTime = Date.now();
    
  } catch (error) {
    logBox.log(`❌ Error fetching metrics: ${error.message}`);
    updateStatusTable({ status: 'error', error: error.message });
  }
}

function updateCharts() {
  // Throughput chart
  throughputChart.setData([{
    title: 'Messages/sec',
    x: Array.from({ length: metricsHistory.throughput.length }, (_, i) => i.toString()),
    y: metricsHistory.throughput,
    style: { line: 'yellow' }
  }]);
  
  // Queue chart
  queueChart.setData([{
    title: 'Queue Size',
    x: Array.from({ length: metricsHistory.queueSize.length }, (_, i) => i.toString()),
    y: metricsHistory.queueSize,
    style: { line: 'cyan' }
  }]);
  
  // Connections chart
  connectionsChart.setData([
    {
      title: 'Agents',
      x: Array.from({ length: metricsHistory.connections.agents.length }, (_, i) => i.toString()),
      y: metricsHistory.connections.agents,
      style: { line: 'green' }
    },
    {
      title: 'Clients',
      x: Array.from({ length: metricsHistory.connections.clients.length }, (_, i) => i.toString()),
      y: metricsHistory.connections.clients,
      style: { line: 'blue' }
    }
  ]);
  
  // System resources chart
  systemChart.setData([
    {
      title: 'Memory %',
      x: Array.from({ length: metricsHistory.memory.length }, (_, i) => i.toString()),
      y: metricsHistory.memory,
      style: { line: 'magenta' }
    },
    {
      title: 'Worker Pool %',
      x: Array.from({ length: metricsHistory.workerUtilization.length }, (_, i) => i.toString()),
      y: metricsHistory.workerUtilization,
      style: { line: 'red' }
    }
  ]);
  
  screen.render();
}

function updateStatusTable(health) {
  const data = [];
  
  if (health.status === 'error') {
    data.push(['Status', '❌ Error']);
    data.push(['Error', health.error || 'Unknown']);
  } else {
    data.push(['Status', health.status === 'ok' ? '✅ OK' : '⚠️  ' + health.status]);
    data.push(['Worker PID', health.worker || 'N/A']);
    data.push(['Uptime', health.uptime ? `${Math.floor(health.uptime)}s` : 'N/A']);
    data.push(['Queue Size', health.queue?.size || 0]);
    data.push(['Processing', health.queue?.processing ? 'Yes' : 'No']);
    data.push(['Agents', health.connections?.agents || 0]);
    data.push(['Clients', health.connections?.clients || 0]);
    data.push(['Memory', health.memory ? formatBytes(health.memory.heapUsed) : 'N/A']);
    data.push(['Redis', health.redis?.connected ? '✅ Connected' : '❌ Disconnected']);
    data.push(['Worker Pool', `${(health.workerPool?.utilization || 0).toFixed(1)}%`]);
  }
  
  statusTable.setData({
    headers: ['Metric', 'Value'],
    data: data
  });
  
  screen.render();
}

// Fetch Prometheus metrics
async function fetchPrometheusMetrics() {
  try {
    // Axios config
    const axiosConfig = {
      timeout: 5000
    };
    
    // localhost için sertifika doğrulamasını atla
    if (CONFIG.SERVER_URL.includes('localhost') || CONFIG.SERVER_URL.includes('127.0.0.1')) {
      axiosConfig.httpsAgent = httpsAgent;
    }
    
    const response = await axios.get(`${CONFIG.SERVER_URL}/metrics`, axiosConfig);
    
    // Parse and log interesting metrics
    const lines = response.data.split('\n');
    lines.forEach(line => {
      if (line.includes('cloud_bridge_register_updates_total')) {
        const match = line.match(/(\d+)$/);
        if (match) {
          logBox.log(`📊 Total updates: ${match[1]}`);
        }
      }
    });
  } catch (error) {
    // Silently ignore Prometheus metrics errors
  }
}

// Initial setup
logBox.log('🚀 Cloud Bridge Monitor started');
logBox.log(`📡 Connecting to ${CONFIG.SERVER_URL} (HTTPS)`);
if (CONFIG.SERVER_URL.includes('localhost') || CONFIG.SERVER_URL.includes('127.0.0.1')) {
  logBox.log('⚠️  Using localhost - SSL verification disabled');
}

// Start monitoring
setInterval(fetchMetrics, CONFIG.REFRESH_INTERVAL);
setInterval(fetchPrometheusMetrics, 10000); // Every 10 seconds

// Handle exit
screen.key(['escape', 'q', 'C-c'], () => {
  return process.exit(0);
});

// Initial render
screen.render();

// Instructions
const instructions = blessed.box({
  parent: screen,
  top: 'center',
  left: 'center',
  width: '50%',
  height: '30%',
  content: `
  Cloud Bridge Monitor
  
  Monitoring: ${CONFIG.SERVER_URL}
  Protocol: HTTPS (Port 443)
  
  Press any key to start monitoring...
  Press 'q' or 'ESC' to exit
  `,
  border: {
    type: 'line'
  },
  style: {
    fg: 'white',
    bg: 'blue',
    border: {
      fg: '#f0f0f0'
    }
  }
});

screen.render();

// Remove instructions on any key press
screen.once('keypress', () => {
  instructions.destroy();
  screen.render();
});