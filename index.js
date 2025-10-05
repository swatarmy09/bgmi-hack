const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3001;

// Telegram credentials
const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ";
const CHAT_ID = "-1002986007836";

// Configuration
const CONFIG = {
  cacheDuration: 5 * 60 * 1000,
  maxMessages: 100,
  maxImages: 50,
  pollingInterval: 10000,
  rateLimit: 1000,
};

// Cached data
const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
  lastFetch: 0,
  _metadata: { totalMessages: 0, totalImages: 0, cacheHits: 0, cacheMisses: 0 },
};

// Rate limiter
const rateLimit = new Map();

// WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Utility helpers
const utils = {
  checkRateLimit(key, windowMs = CONFIG.rateLimit) {
    const now = Date.now();
    const record = rateLimit.get(key);
    if (!record) {
      rateLimit.set(key, { lastCall: now });
      return true;
    }
    if (now - record.lastCall < windowMs) return false;
    record.lastCall = now;
    return true;
  },
  cleanRateLimit() {
    const now = Date.now();
    for (const [key, record] of rateLimit.entries()) {
      if (now - record.lastCall > 60000) rateLimit.delete(key);
    }
  },
  safeJsonParse(data) {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  },
  generateFileName(messageId, fileId, ext = "jpg") {
    return `${messageId}_${fileId}_${Date.now()}.${ext}`;
  },
  isValidImage(buffer) {
    const sigs = {
      jpeg: [0xff, 0xd8, 0xff],
      png: [0x89, 0x50, 0x4e, 0x47],
      gif: [0x47, 0x49, 0x46],
    };
    const header = Array.from(buffer.slice(0, 4));
    return Object.values(sigs).some(sig => sig.every((b, i) => header[i] === b));
  },
};

// HTTP Client
class EnhancedHttpClient {
  async request(url) {
    const client = url.startsWith("https") ? https : http;
    return new Promise((resolve, reject) => {
      client.get(url, (res) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          resolve(utils.safeJsonParse(data));
        });
      }).on("error", reject);
    });
  }
  async downloadBinary(url) {
    const client = url.startsWith("https") ? https : http;
    return new Promise((resolve, reject) => {
      const chunks = [];
      client.get(url, (res) => {
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (utils.isValidImage(buffer)) resolve(buffer);
          else reject("Invalid image");
        });
      }).on("error", reject);
    });
  }
}

const httpClient = new EnhancedHttpClient();

// Cache Manager
class CacheManager {
  isCacheValid() {
    return Date.now() - cachedData.lastFetch < CONFIG.cacheDuration;
  }
  updateCache(newData) {
    cachedData.messages = newData.messages.slice(0, CONFIG.maxMessages);
    cachedData.images = newData.images.slice(0, CONFIG.maxImages);
    cachedData.lastUpdate = newData.lastUpdate;
    cachedData.lastFetch = Date.now();
    cachedData._metadata.totalMessages = cachedData.messages.length;
    cachedData._metadata.totalImages = cachedData.images.length;
  }
  getStats() {
    return {
      ...cachedData._metadata,
      cacheAge: Date.now() - cachedData.lastFetch,
      memory: process.memoryUsage(),
    };
  }
}

const cacheManager = new CacheManager();

// Image Downloader
class ImageDownloader {
  constructor() {
    this.dir = path.join(__dirname, "images");
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir);
  }
  async downloadImage(fileId, messageId) {
    try {
      const fileInfo = await httpClient.request(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
      );
      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
      const buffer = await httpClient.downloadBinary(fileUrl);
      const ext = path.extname(filePath) || ".jpg";
      const name = utils.generateFileName(messageId, fileId, ext.replace(".", ""));
      const localPath = path.join(this.dir, name);
      fs.writeFileSync(localPath, buffer);
      return `/images/${name}`;
    } catch (err) {
      console.error("Image download failed:", err);
      return null;
    }
  }
}
const imageDownloader = new ImageDownloader();

// Message Processor
class MessageProcessor {
  constructor() {
    this.lastUpdateId = 0;
  }
  async startPolling() {
    setInterval(() => this.pollMessages(), CONFIG.pollingInterval);
  }
  async pollMessages() {
    try {
      const data = await httpClient.request(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${this.lastUpdateId + 1}`
      );
      if (data.result?.length) await this.processUpdates(data.result);
    } catch (err) {
      console.error("Polling error:", err);
    }
  }
  async processUpdates(updates) {
    const tempData = cacheManager.isCacheValid()
      ? cachedData
      : { messages: [], images: [], lastUpdate: 0 };

    for (const update of updates) {
      if (update.update_id > this.lastUpdateId)
        this.lastUpdateId = update.update_id;

      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== CHAT_ID) continue;

      if (msg.text) {
        tempData.messages.unshift({
          id: msg.message_id,
          text: msg.text,
          date: new Date(msg.date * 1000).toISOString(),
        });
      }

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        const local = await imageDownloader.downloadImage(photo.file_id, msg.message_id);
        if (local) {
          tempData.images.unshift({
            id: msg.message_id,
            url: local,
            caption: msg.caption || "",
            date: new Date(msg.date * 1000).toISOString(),
          });
        }
      }
    }

    cacheManager.updateCache(tempData);
  }
}

const messageProcessor = new MessageProcessor();

// Middleware
app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));

// Routes
app.get("/", (req, res) => {
  res.send("🚀 Telegram Image Fetcher Running!");
});

app.get("/api/telegram", (req, res) => {
  res.json({
    success: true,
    data: { messages: cachedData.messages, images: cachedData.images },
    stats: cacheManager.getStats(),
  });
});

app.get("/api/stats", (req, res) => {
  res.json(cacheManager.getStats());
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "OK", uptime: process.uptime(), cache: cacheManager.getStats() });
});

// WebSocket setup
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
});

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "connected", msg: "WebSocket ready" }));
});

// Initialize on startup
async function initializeData() {
  try {
    console.log("Initializing data...");
    const botInfo = await httpClient.request(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    console.log("Bot:", botInfo.result?.first_name);

    const updates = await httpClient.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=100`
    );

    const tempData = { messages: [], images: [], lastUpdate: 0 };

    for (const update of updates.result || []) {
      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== CHAT_ID) continue;

      if (update.update_id > tempData.lastUpdate)
        tempData.lastUpdate = update.update_id;

      if (msg.text) {
        tempData.messages.unshift({
          id: msg.message_id,
          text: msg.text,
          date: new Date(msg.date * 1000).toISOString(),
        });
      }

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        const local = await imageDownloader.downloadImage(photo.file_id, msg.message_id);
        if (local) {
          tempData.images.unshift({
            id: msg.message_id,
            url: local,
            caption: msg.caption || "",
            date: new Date(msg.date * 1000).toISOString(),
          });
        }
      }
    }

    cacheManager.updateCache(tempData);
    console.log("✅ Initialization complete.");
  } catch (err) {
    console.error("Init error:", err);
  }
}

// Start Server
(async () => {
  await initializeData();
  messageProcessor.startPolling();
  server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
})();