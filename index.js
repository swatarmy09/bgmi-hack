const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ";
const CHAT_ID = "-1002986007836";

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));

const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
  lastFetch: null,
};

// Fetch helpers
function fetchData(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

function downloadBinary(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

// Download and cache image
async function downloadImage(fileId, fileName) {
  try {
    const imagesDir = path.join(__dirname, "images");
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

    const localPath = path.join(imagesDir, fileName);
    if (fs.existsSync(localPath)) return `/images/${fileName}`; // cache hit ✅

    const fileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
    const fileData = await fetchData(fileUrl);
    if (!fileData.ok) return null;

    const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
    const buffer = await downloadBinary(imageUrl);
    fs.writeFileSync(localPath, buffer);

    return `/images/${fileName}`;
  } catch (err) {
    console.error("❌ Image download failed:", err.message);
    return null;
  }
}

// Telegram fetcher (parallel + cache)
async function fetchTelegramMessages() {
  try {
    console.log("🔄 Updating Telegram data...");

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
    const data = await fetchData(url);

    if (!data.ok || !data.result) {
      console.error("⚠️ Telegram API Error:", data);
      return;
    }

    const messages = [];
    const images = [];

    const updates = data.result.filter((u) => {
      const msg = u.message || u.channel_post;
      return msg && msg.chat.id.toString() === CHAT_ID.toString();
    });

    const imagePromises = [];

    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      // Text messages
      if (msg.text) {
        messages.push({
          id: msg.message_id,
          text: msg.text,
          date: new Date(msg.date * 1000).toISOString(),
          from: msg.from ? msg.from.first_name : "Channel",
        });
      }

      // Photos
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileName = `${msg.message_id}_${photo.file_id}.jpg`;
        imagePromises.push(
          (async () => {
            const localUrl = await downloadImage(photo.file_id, fileName);
            if (localUrl) {
              images.push({
                id: msg.message_id,
                url: localUrl,
                caption: msg.caption || "",
                date: new Date(msg.date * 1000).toISOString(),
                from: msg.from ? msg.from.first_name : "Channel",
              });
            }
          })()
        );
      }
    }

    // Wait for all downloads in parallel
    await Promise.all(imagePromises);

    cachedData.messages = messages.slice(-50);
    cachedData.images = images.slice(-20);
    cachedData.lastFetch = new Date().toISOString();

    console.log(`✅ Cache updated: ${messages.length} messages, ${images.length} images`);
  } catch (err) {
    console.error("❌ Fetch error:", err.message);
  }
}

// Serve cached instantly
app.get("/api/telegram", (req, res) => {
  res.json({
    success: true,
    lastFetch: cachedData.lastFetch,
    messages: cachedData.messages,
    images: cachedData.images,
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ Fast Telegram Server Running",
    endpoints: ["/api/telegram", "/health", "/images/*"],
    cache: {
      messages: cachedData.messages.length,
      images: cachedData.images.length,
      lastFetch: cachedData.lastFetch,
    },
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  fetchTelegramMessages(); // first load
  setInterval(fetchTelegramMessages, 30000); // auto-refresh every 30 sec
});