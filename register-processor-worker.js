/**
 * Worker Thread for Heavy Register Processing
 * 
 * Handles CPU-intensive operations in separate threads
 * to prevent blocking the main event loop
 */

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

// Message types
const MessageTypes = {
  PROCESS_BATCH: 'PROCESS_BATCH',
  VALIDATE_DATA: 'VALIDATE_DATA',
  TRANSFORM_DATA: 'TRANSFORM_DATA',
  COMPRESS_DATA: 'COMPRESS_DATA',
  ENCRYPT_DATA: 'ENCRYPT_DATA'
};

// Data validation schemas
const ValidationSchemas = {
  register: {
    analyzerId: { type: 'string|number', required: true },
    address: { type: 'number', required: true },
    value: { required: true },
    timestamp: { type: 'number' },
    dataType: { type: 'string' },
    bit: { type: 'number' }
  }
};

// Helper functions
function validateData(data, schema) {
  const errors = [];
  
  for (const [key, rules] of Object.entries(schema)) {
    if (rules.required && !(key in data)) {
      errors.push(`Missing required field: ${key}`);
      continue;
    }
    
    if (key in data && rules.type) {
      const types = rules.type.split('|');
      const actualType = typeof data[key];
      
      if (!types.includes(actualType)) {
        errors.push(`Invalid type for ${key}: expected ${rules.type}, got ${actualType}`);
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}

function transformRegisterData(data) {
  // Apply data transformations
  const transformed = { ...data };
  
  // Ensure timestamp
  if (!transformed.timestamp) {
    transformed.timestamp = Date.now();
  }
  
  // Normalize analyzer ID
  if (typeof transformed.analyzerId === 'string') {
    transformed.analyzerId = transformed.analyzerId.toLowerCase();
  }
  
  // Apply scaling if needed
  if (transformed.scale && typeof transformed.value === 'number') {
    transformed.value = transformed.value * transformed.scale;
  }
  
  // Handle bit operations for boolean values
  if (transformed.dataType === 'boolean' && typeof transformed.bit === 'number') {
    transformed.value = Boolean(transformed.value);
  }
  
  return transformed;
}

function compressData(data) {
  // Simple compression for repeated values
  const compressed = {
    type: 'compressed',
    data: []
  };
  
  let lastValue = null;
  let count = 0;
  
  for (const item of data) {
    if (JSON.stringify(item) === JSON.stringify(lastValue)) {
      count++;
    } else {
      if (lastValue !== null) {
        compressed.data.push({ value: lastValue, count });
      }
      lastValue = item;
      count = 1;
    }
  }
  
  if (lastValue !== null) {
    compressed.data.push({ value: lastValue, count });
  }
  
  return compressed;
}

function encryptSensitiveData(data, key) {
  // Encrypt sensitive register values
  const cipher = crypto.createCipher('aes-256-cbc', key);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    type: 'encrypted',
    data: encrypted,
    algorithm: 'aes-256-cbc'
  };
}

// Message handlers
const messageHandlers = {
  [MessageTypes.PROCESS_BATCH]: (data) => {
    const { batch, options = {} } = data;
    const results = [];
    const errors = [];
    
    for (const item of batch) {
      try {
        // Validate
        const validation = validateData(item, ValidationSchemas.register);
        if (!validation.valid) {
          errors.push({ item, errors: validation.errors });
          continue;
        }
        
        // Transform
        let processed = transformRegisterData(item);
        
        // Additional processing based on options
        if (options.encrypt && options.encryptionKey) {
          processed = encryptSensitiveData(processed, options.encryptionKey);
        }
        
        results.push(processed);
      } catch (error) {
        errors.push({ item, error: error.message });
      }
    }
    
    return { results, errors, processed: batch.length };
  },
  
  [MessageTypes.VALIDATE_DATA]: (data) => {
    const { items, schema = 'register' } = data;
    const results = [];
    
    for (const item of items) {
      const validation = validateData(item, ValidationSchemas[schema]);
      results.push({
        item,
        valid: validation.valid,
        errors: validation.errors
      });
    }
    
    return { results };
  },
  
  [MessageTypes.TRANSFORM_DATA]: (data) => {
    const { items } = data;
    const results = items.map(transformRegisterData);
    return { results };
  },
  
  [MessageTypes.COMPRESS_DATA]: (data) => {
    const { items } = data;
    const compressed = compressData(items);
    
    // Calculate compression ratio
    const originalSize = JSON.stringify(items).length;
    const compressedSize = JSON.stringify(compressed).length;
    const ratio = ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
    
    return {
      compressed,
      stats: {
        originalSize,
        compressedSize,
        compressionRatio: `${ratio}%`
      }
    };
  },
  
  [MessageTypes.ENCRYPT_DATA]: (data) => {
    const { items, key } = data;
    
    if (!key) {
      throw new Error('Encryption key is required');
    }
    
    const encrypted = items.map(item => encryptSensitiveData(item, key));
    return { encrypted };
  }
};

// Main message handler
parentPort.on('message', async (message) => {
  const { id, type, data } = message;
  
  try {
    const handler = messageHandlers[type];
    
    if (!handler) {
      throw new Error(`Unknown message type: ${type}`);
    }
    
    const result = await handler(data);
    
    parentPort.postMessage({
      id,
      type: 'success',
      result
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      type: 'error',
      error: {
        message: error.message,
        stack: error.stack
      }
    });
  }
});

// Send ready signal
parentPort.postMessage({ type: 'ready' });