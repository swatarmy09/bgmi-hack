const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3001;

// Your Telegram credentials
const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ";
const CHAT_ID = "-1002986007836";

// Enhanced configuration
const CONFIG = {
  cacheDuration: 5 * 60 * 1000, // 5 minutes cache
  maxMessages: 100,
  maxImages: 50,
  imageQuality: "high", // high, medium, low
  pollingInterval: 10000, // 10 seconds for new messages
  rateLimit: 1000, // 1 second between Telegram API calls
};

// Enhanced cache with TTL and memory management
const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
  lastFetch: 0,
  _metadata: {
    totalMessages: 0,
    totalImages: 0,
    cacheHits: 0,
    cacheMisses: 0,
  },
};

// WebSocket for real-time updates
const wss = new WebSocket.Server({ noServer: true });

// Rate limiting
const rateLimit = new Map();

// Utility functions
const utils = {
  // Rate limiter
  checkRateLimit(key, windowMs = CONFIG.rateLimit) {
    const now = Date.now();
    const record = rateLimit.get(key);
    
    if (!record) {
      rateLimit.set(key, { count: 1, lastCall: now });
      return true;
    }
    
    if (now - record.lastCall < windowMs) {
      return false;
    }
    
    record.count = 1;
    record.lastCall = now;
    return true;
  },
  
  // Clean old rate limit records
  cleanRateLimit() {
    const now = Date.now();
    for (const [key, record] of rateLimit.entries()) {
      if (now - record.lastCall > 60000) { // 1 minute
        rateLimit.delete(key);
      }
    }
  },
  
  // Generate unique filename
  generateFileName(messageId, fileId, extension = "jpg") {
    return `${messageId}_${fileId}_${Date.now()}.${extension}`;
  },
  
  // Safe JSON parse
  safeJsonParse(data) {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  },
  
  // Validate image buffer
  isValidImage(buffer) {
    if (!buffer || buffer.length < 8) return false;
    
    // Check for common image signatures
    const signatures = {
      jpeg: [0xFF, 0xD8, 0xFF],
      png: [0x89, 0x50, 0x4E, 0x47],
      gif: [0x47, 0x49, 0x46],
      webp: [0x52, 0x49, 0x46, 0x46],
    };
    
    const header = Array.from(buffer.slice(0, 8));
    
    return Object.values(signatures).some(sig => 
      sig.every((byte, i) => header[i] === byte)
    );
  },
  
  // Optimize image based on quality setting
  async optimizeImage(buffer, quality = CONFIG.imageQuality) {
    // In a real implementation, you'd use sharp or similar library
    // This is a placeholder for image optimization logic
    return buffer;
  },
};

// Enhanced HTTP client with retries and timeout
class EnhancedHttpClient {
  constructor() {
    this.timeout = 10000;
    this.retries = 3;
  }

  async request(url, options = {}) {
    const client = url.startsWith("https") ? https : http;
    
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const req = client.get(url, { timeout: this.timeout }, (res) => {
            let data = "";
            
            res.on("data", (chunk) => {
              data += chunk;
            });
            
            res.on("end", () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(utils.safeJsonParse(data));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              }
            });
          });
          
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
          });
          
          req.on("error", reject);
        });
      } catch (error) {
        if (attempt === this.retries) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  async downloadBinary(url) {
    const client = url.startsWith("https") ? https : http;
    
    return new Promise((resolve, reject) => {
      const req = client.get(url, { timeout: this.timeout }, (res) => {
        const chunks = [];
        
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (utils.isValidImage(buffer)) {
            resolve(buffer);
          } else {
            reject(new Error("Invalid image data"));
          }
        });
      });
      
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Download timeout"));
      });
      
      req.on("error", reject);
    });
  }
}

const httpClient = new EnhancedHttpClient();

// Enhanced cache management
class CacheManager {
  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // 1 minute
  }

  isCacheValid() {
    return Date.now() - cachedData.lastFetch < CONFIG.cacheDuration;
  }

  updateCache(newData) {
    cachedData.messages = newData.messages.slice(0, CONFIG.maxMessages);
    cachedData.images = newData.images.slice(0, CONFIG.maxImages);
    cachedData.lastUpdate = newData.lastUpdate;
    cachedData.lastFetch = Date.now();
    cachedData._metadata.totalMessages = newData.messages.length;
    cachedData._metadata.totalImages = newData.images.length;
  }

  cleanup() {
    // Clean old files from images directory
    const imagesDir = path.join(__dirname, "images");
    if (!fs.existsSync(imagesDir)) return;

    const files = fs.readdirSync(imagesDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    files.forEach(file => {
      const filePath = path.join(imagesDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      } catch (error) {
        console.error(`Error cleaning file ${file}:`, error);
      }
    });

    utils.cleanRateLimit();
  }

  getStats() {
    return {
      ...cachedData._metadata,
      cacheAge: Date.now() - cachedData.lastFetch,
      memoryUsage: process.memoryUsage(),
      rateLimitSize: rateLimit.size,
    };
  }
}

const cacheManager = new CacheManager();

// Enhanced image downloader with caching
class ImageDownloader {
  constructor() {
    this.downloadQueue = new Map();
    this.imagesDir = path.join(__dirname, "images");
    this.ensureImagesDir();
  }

  ensureImagesDir() {
    if (!fs.existsSync(this.imagesDir)) {
      fs.mkdirSync(this.imagesDir, { recursive: true });
    }
  }

  async downloadImage(fileId, messageId, caption = "") {
    const cacheKey = `${fileId}_${messageId}`;
    
    // Check if already downloading
    if (this.downloadQueue.has(cacheKey)) {
      return this.downloadQueue.get(cacheKey);
    }

    const downloadPromise = this._downloadImage(fileId, messageId, caption);
    this.downloadQueue.set(cacheKey, downloadPromise);

    try {
      const result = await downloadPromise;
      return result;
    } finally {
      this.downloadQueue.delete(cacheKey);
    }
  }

  async _downloadImage(fileId, messageId, caption) {
    try {
      // Check if image already exists locally
      const existingFile = this.findExistingImage(fileId);
      if (existingFile) {
        console.log(`Using cached image for fileId: ${fileId}`);
        return existingFile;
      }

      console.log(`Downloading image: ${fileId}`);

      // Get file path from Telegram
      const fileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
      const fileData = await httpClient.request(fileUrl);

      if (!fileData.ok) {
        console.error("Failed to get file path:", fileData);
        return null;
      }

      const filePath = fileData.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      // Download and optimize image
      const buffer = await httpClient.downloadBinary(imageUrl);
      const optimizedBuffer = await utils.optimizeImage(buffer);

      // Save to local images folder
      const extension = path.extname(filePath) || ".jpg";
      const fileName = utils.generateFileName(messageId, fileId, extension.replace(".", ""));
      const localPath = path.join(this.imagesDir, fileName);

      fs.writeFileSync(localPath, optimizedBuffer);

      console.log(`Image saved: ${fileName}`);
      return `/images/${fileName}`;

    } catch (error) {
      console.error("Error downloading image:", error);
      return null;
    }
  }

  findExistingImage(fileId) {
    const files = fs.readdirSync(this.imagesDir);
    const pattern = new RegExp(`_${fileId}_`);
    const existingFile = files.find(file => pattern.test(file));
    
    return existingFile ? `/images/${existingFile}` : null;
  }

  cleanup() {
    this.downloadQueue.clear();
  }
}

const imageDownloader = new ImageDownloader();

// Real-time message processor
class MessageProcessor {
  constructor() {
    this.lastUpdateId = 0;
    this.isPolling = false;
  }

  async startPolling() {
    if (this.isPolling) return;
    
    this.isPolling = true;
    this.pollMessages();
    
    setInterval(() => {
      this.pollMessages();
    }, CONFIG.pollingInterval);
  }

  async pollMessages() {
    if (!utils.checkRateLimit("telegram_poll")) {
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`;
      const data = await httpClient.request(url);

      if (!data.ok) {
        console.error("Telegram API error:", data);
        return;
      }

      if (data.result.length > 0) {
        await this.processUpdates(data.result);
        this.broadcastUpdate();
      }
    } catch (error) {
      console.error("Polling error:", error.message);
    }
  }

  async processUpdates(updates) {
    let hasNewData = false;

    for (const update of updates) {
      if (update.update_id > this.lastUpdateId) {
        this.lastUpdateId = update.update_id;
      }

      const message = update.message || update.channel_post;
      if (!message) continue;

      // Check if message is from our channel
      if (message.chat.id.toString() !== CHAT_ID.toString()) {
        continue;
      }

      await this.processMessage(message);
      hasNewData = true;
    }

    if (hasNewData) {
      cacheManager.updateCache(cachedData);
    }
  }

  async processMessage(message) {
    console.log(`Processing message ${message.message_id} from ${message.chat.title || "Unknown"}`);

    // Process text
    if (message.text) {
      this.addTextMessage(message);
    }

    // Process images
    if (message.photo) {
      await this.processPhotoMessage(message);
    }

    // Process documents
    if (message.document && message.document.mime_type?.startsWith("image/")) {
      await this.processDocumentMessage(message);
    }
  }

  addTextMessage(message) {
    const existingIndex = cachedData.messages.findIndex(m => m.id === message.message_id);
    const messageData = {
      id: message.message_id,
      text: message.text,
      date: new Date(message.date * 1000).toISOString(),
      from: message.from ? message.from.first_name : "Channel",
      type: "text",
    };

    if (existingIndex >= 0) {
      cachedData.messages[existingIndex] = messageData;
    } else {
      cachedData.messages.unshift(messageData);
    }
  }

  async processPhotoMessage(message) {
    const photo = message.photo[message.photo.length - 1]; // Highest resolution
    const localUrl = await imageDownloader.downloadImage(
      photo.file_id,
      message.message_id,
      message.caption
    );

    if (localUrl) {
      this.addImageMessage(message, localUrl);
    }
  }

  async processDocumentMessage(message) {
    const localUrl = await imageDownloader.downloadImage(
      message.document.file_id,
      message.message_id,
      message.caption || message.document.file_name
    );

    if (localUrl) {
      this.addImageMessage(message, localUrl);
    }
  }

  addImageMessage(message, localUrl) {
    const existingIndex = cachedData.images.findIndex(img => img.id === message.message_id);
    const imageData = {
      id: message.message_id,
      url: localUrl,
      caption: message.caption || "",
      date: new Date(message.date * 1000).toISOString(),
      from: message.from ? message.from.first_name : "Channel",
      type: "image",
    };

    if (existingIndex >= 0) {
      cachedData.images[existingIndex] = imageData;
    } else {
      cachedData.images.unshift(imageData);
    }
  }

  broadcastUpdate() {
    const updateData = {
      type: "update",
      data: {
        messages: cachedData.messages.length,
        images: cachedData.images.length,
        timestamp: new Date().toISOString(),
      },
    };

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(updateData));
      }
    });
  }
}

const messageProcessor = new MessageProcessor();

// Middleware setup
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://yourdomain.com'] 
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use("/images", express.static(path.join(__dirname, "images"), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

// Security middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Rate limiting middleware
app.use((req, res, next) => {
  const key = req.ip;
  if (!utils.checkRateLimit(key)) {
    return res.status(429).json({
      error: "Too many requests",
      retryAfter: Math.ceil(CONFIG.rateLimit / 1000)
    });
  }
  next();
});

// Routes
app.get("/", (req, res) => {
  res.json({
    status: "🚀 Advanced Telegram Server Running",
    message: "Server is working with real-time updates!",
    endpoints: {
      "/api/telegram": "Get messages and images from Telegram channel",
      "/api/telegram/refresh": "Force refresh data",
      "/api/stats": "Get server statistics",
      "/health": "Health check",
      "/images/*": "Static image files",
      "/ws": "WebSocket for real-time updates",
    },
    config: {
      botToken: BOT_TOKEN.substring(0, 10) + "...",
      chatId: CHAT_ID,
      port: PORT,
      cacheDuration: CONFIG.cacheDuration,
      maxMessages: CONFIG.maxMessages,
      maxImages: CONFIG.maxImages,
    },
    cache: cacheManager.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// Main API endpoint with smart caching
app.get("/api/telegram", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    
    if (forceRefresh || !cacheManager.isCacheValid()) {
      cachedData._metadata.cacheMisses++;
      console.log("Cache miss - fetching fresh data");
      await initializeData();
    } else {
      cachedData._metadata.cacheHits++;
      console.log("Cache hit - serving cached data");
    }

    res.json({
      success: true,
      data: {
        messages: cachedData.messages,
        images: cachedData.images,
      },
      metadata: {
        totalMessages: cachedData.messages.length,
        totalImages: cachedData.images.length,
        lastUpdate: cachedData.lastUpdate,
        cache: cacheManager.getStats(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch data",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Force refresh endpoint
app.post("/api/telegram/refresh", async (req, res) => {
  try {
    console.log("Manual refresh requested");
    await initializeData(true);
    
    res.json({
      success: true,
      message: "Data refreshed successfully",
      data: {
        messages: cachedData.messages.length,
        images: cachedData.images.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Refresh error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to refresh data",
      message: error.message,
    });
  }
});

// Statistics endpoint
app.get("/api/stats", (req, res) => {
  res.json({
    ...cacheManager.getStats(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Health check with detailed info
app.get("/health", (req, res) => {
  const health = {
    status: "OK",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    telegram: {
      bot: BOT_TOKEN ? "Configured" : "Missing",
      chat: CHAT_ID ? "Configured" : "Missing",
    },
    cache: {
      messages: cachedData.messages.length,
      images: cachedData.images.length,
      age: Date.now() - cachedData.lastFetch,
    },
  };

  // Check Telegram API connectivity
  httpClient.request(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
    .then(data => {
      health.telegram.api = data.ok ? "Connected" : "Error";
      res.json(health);
    })
    .catch(error => {
      health.telegram.api = "Error: " + error.message;
      health.status = "Degraded";
      res.status(503).json(health);
    });
});

// WebSocket endpoint
app.get("/ws", (req, res) => {
  res.json({
    message: "WebSocket endpoint available at ws://" + req.get('host') + "/ws",
    protocol: "Use WebSocket client to connect for real-time updates",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === 'production' 
      ? "Something went wrong" 
      : err.message,
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path,
    timestamp: new Date().toISOString(),
  });
});

// Initialize data on startup
async function initializeData(force = false) {
  try {
    console.log("Initializing Telegram data...");
    
    // Verify bot credentials
    const botInfo = await httpClient.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/getMe`
    );
    
    if (!botInfo.ok) {
      throw new Error("Invalid bot token");
    }
    
    console.log(`🤖 Bot authorized as: ${botInfo.result.first_name}`);

    // Verify chat access
    const chatInfo = await httpClient.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${CHAT_ID}`
    );
    
    if (!chatInfo.ok) {
      throw new Error(`Cannot access chat: ${chatInfo.description}`);
    }
    
    console.log(`💬 Connected to: ${chatInfo.result.title} (${chatInfo.result.type})`);

    // Fetch initial messages
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=100`;
    const data = await httpClient.request(url);

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    console.log(`📨 Processing ${data.result.length} initial updates...`);
    
    const tempData = {
      messages: [],
      images: [],
      lastUpdate: 0,
    };

    const downloadPromises = [];

    for (const update of data.result) {
      const message = update.message || update.channel_post;
      if (!message || message.chat.id.toString() !== CHAT_ID.toString()) {
        continue;
      }

      if (update.update_id > tempData.lastUpdate) {
        tempData.lastUpdate = update.update_id;
