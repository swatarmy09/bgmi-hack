/**
 * 🚀 ADVANCED FAST TELEGRAM FETCH SERVER
 * Features:
 *  ✅ Instant cache-based API response
 *  ✅ Background Telegram updates every 30s
 *  ✅ Parallel async image downloads
 *  ✅ Cached images reused (no repeated download)
 *  ✅ Detailed logging and stability improvements
 */

const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Replace with your real Telegram Bot Token and Chat ID
const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ";
const CHAT_ID = "-1002986007836";

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));

// 🔁 Cache storage
const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
  lastFetch: null,
};

/* ------------------- HELPER FUNCTIONS ------------------- */

// Fetch JSON data from Telegram API
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

// Download file in binary
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

    // 🧠 Already exists → skip download
    if (fs.existsSync(localPath)) return `/images/${fileName}`;

    const fileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
    const fileData = await fetchData(fileUrl);

    if (!fileData.ok) {
      console.error("❌ Failed to get file path:", fileData);
      return null;
    }

    const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
    const buffer = await downloadBinary(imageUrl);
    fs.writeFileSync(localPath, buffer);
    console.log("✅ Saved image:", fileName);

    return `/images/${fileName}`;
  } catch (err) {
    console.error("❌ Image download failed:", err.message);
    return null;
  }
}

/* ------------------- TELEGRAM FETCHER ------------------- */

async function fetchTelegramMessages() {
  try {
    console.log("\n🔄 Updating Telegram data...");

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
    const data = await fetchData(url);

    if (!data.ok || !data.result) {
      console.error("⚠️ Telegram API Error:", data);
      return;
    }

    const updates = data.result.filter((u) => {
      const msg = u.message || u.channel_post;
      return msg && msg.chat.id.toString() === CHAT_ID.toString();
    });

    const messages = [];
    const images = [];
    const imagePromises = [];

    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      // 📝 Text message
      if (msg.text) {
        messages.push({
          id: msg.message_id,
          text: msg.text,
          date: new Date(msg.date * 1000).toISOString(),
          from: msg.from ? msg.from.first_name : "Channel",
        });
      }

      // 🖼️ Photo
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

      // 📄 Document (image type)
      if (msg.document && msg.document.mime_type?.startsWith("image/")) {
        const ext = msg.document.mime_type.split("/")[1];
        const fileName = `${msg.message_id}_${msg.document.file_id}.${ext}`;

        imagePromises.push(
          (async () => {
            const localUrl = await downloadImage(msg.document.file_id, fileName);
            if (localUrl) {
              images.push({
                id: msg.message_id,
                url: localUrl,
                caption: msg.caption || msg.document.file_name || "",
                date: new Date(msg.date * 1000).toISOString(),
                from: msg.from ? msg.from.first_name : "Channel",
              });
            }
          })()
        );
      }
    }

    // Download all images in parallel
    await Promise.all(imagePromises);

    // 🔁 Update cache
    cachedData.messages = messages.slice(-50);
    cachedData.images = images.slice(-20);
    cachedData.lastFetch = new Date().toISOString();

    console.log(`✅ Cache updated: ${messages.length} text, ${images.length} images`);
  } catch (err) {
    console.error("❌ Fetch Error:", err.message);
  }
}

/* ------------------- EXPRESS ROUTES ------------------- */

// Fast cached API
app.get("/api/telegram", (req, res) => {
  res.json({
    success: true,
    lastFetch: cachedData.lastFetch,
    messages: cachedData.messages,
    images: cachedData.images,
  });
});

// Root Info
app.get("/", (req, res) => {
  res.json({
    status: "✅ Telegram Server Running (Fast Mode)",
    endpoints: ["/api/telegram", "/health", "/images/*"],
    cache: {
      messages: cachedData.messages.length,
      images: cachedData.images.length,
      lastFetch: cachedData.lastFetch,
    },
    timestamp: new Date().toISOString(),
  });
});

// Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

/* ------------------- START SERVER ------------------- */

app.listen(PORT, () => {
  console.log(`\n🚀 Telegram Fast Server Running on Port ${PORT}`);
  console.log(`💬 Chat ID: ${CHAT_ID}`);
  console.log(`🌐 Access: http://localhost:${PORT}\n`);

  // Initial Fetch + Auto Refresh every 30 sec
  fetchTelegramMessages();
  setInterval(fetchTelegramMessages, 30000);
});