const express = require("express")
const cors = require("cors")
const https = require("https")
const http = require("http")
const fs = require("fs")
const path = require("path")

const app = express()
const PORT = process.env.PORT || 3001

// Your Telegram credentials
const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ"
const CHAT_ID = "-4891957310"

app.use(cors())
app.use(express.json())
app.use("/images", express.static(path.join(__dirname, "images")))

// Store for cached images and messages
const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
}

function fetchData(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http

    client
      .get(url, (res) => {
        let data = ""

        res.on("data", (chunk) => {
          data += chunk
        })

        res.on("end", () => {
          try {
            resolve(JSON.parse(data))
          } catch (error) {
            resolve(data)
          }
        })
      })
      .on("error", (error) => {
        reject(error)
      })
  })
}

function downloadBinary(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http

    client
      .get(url, (res) => {
        const chunks = []

        res.on("data", (chunk) => {
          chunks.push(chunk)
        })

        res.on("end", () => {
          resolve(Buffer.concat(chunks))
        })
      })
      .on("error", (error) => {
        reject(error)
      })
  })
}

// Function to download and save image
async function downloadImage(fileId, fileName) {
  try {
    console.log(`Downloading image: ${fileName}`)

    // Get file path from Telegram
    const fileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
    const fileData = await fetchData(fileUrl)

    if (!fileData.ok) {
      console.log("Failed to get file path:", fileData)
      return null
    }

    const filePath = fileData.result.file_path
    const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`

    // Download image
    const buffer = await downloadBinary(imageUrl)

    // Save to local images folder
    const imagesDir = path.join(__dirname, "images")
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true })
    }

    const localPath = path.join(imagesDir, fileName)
    fs.writeFileSync(localPath, buffer)

    console.log(`Image saved: ${fileName}`)
    return `/images/${fileName}`
  } catch (error) {
    console.error("Error downloading image:", error)
    return null
  }
}

// Function to fetch messages from Telegram channel
async function fetchTelegramMessages() {
  try {
    console.log("Fetching messages from Telegram channel...")

    // First, try to get chat info to verify bot has access
    const chatInfoUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${CHAT_ID}`
    const chatInfo = await fetchData(chatInfoUrl)

    if (!chatInfo.ok) {
      console.error("Cannot access chat. Bot might not be added to the group or lacks permissions:", chatInfo)
      return cachedData
    }

    console.log("Chat info:", chatInfo.result.title, chatInfo.result.type)

    // Get recent messages from the channel
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-100&limit=100`
    const data = await fetchData(url)

    if (!data.ok) {
      console.error("Telegram API error:", data)
      return cachedData
    }

    console.log(`Received ${data.result.length} updates`)

    const messages = []
    const images = []
    let processedCount = 0

    for (const update of data.result) {
      if (update.update_id > cachedData.lastUpdate) {
        cachedData.lastUpdate = update.update_id
      }

      const message = update.message || update.channel_post
      if (!message) {
        console.log("No message in update:", update.update_id)
        continue
      }

      console.log(`Processing message from chat ${message.chat.id} (looking for ${CHAT_ID})`)

      // Check if message is from our channel (convert both to strings for comparison)
      if (message.chat.id.toString() !== CHAT_ID.toString()) {
        console.log(`Skipping message from different chat: ${message.chat.id}`)
        continue
      }

      processedCount++
      console.log(
        "Processing message:",
        message.message_id,
        "Type:",
        message.photo ? "photo" : message.text ? "text" : "other",
      )

      // Process text messages
      if (message.text) {
        messages.push({
          id: message.message_id,
          text: message.text,
          date: new Date(message.date * 1000).toISOString(),
          from: message.from ? message.from.first_name : "Channel",
        })
        console.log("Added text message:", message.text.substring(0, 50))
      }

      // Process images
      if (message.photo && message.photo.length > 0) {
        console.log("Found photo in message:", message.message_id)
        const photo = message.photo[message.photo.length - 1] // Get highest resolution
        const fileName = `${message.message_id}_${photo.file_id}.jpg`

        const localUrl = await downloadImage(photo.file_id, fileName)

        if (localUrl) {
          images.push({
            id: message.message_id,
            url: localUrl,
            caption: message.caption || "",
            date: new Date(message.date * 1000).toISOString(),
            from: message.from ? message.from.first_name : "Channel",
          })
          console.log("Added image:", fileName)
        }
      }

      // Process documents (if they are images)
      if (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/")) {
        console.log("Found image document in message:", message.message_id)
        const extension = message.document.mime_type.split("/")[1]
        const fileName = `${message.message_id}_${message.document.file_id}.${extension}`

        const localUrl = await downloadImage(message.document.file_id, fileName)

        if (localUrl) {
          images.push({
            id: message.message_id,
            url: localUrl,
            caption: message.caption || message.document.file_name || "",
            date: new Date(message.date * 1000).toISOString(),
            from: message.from ? message.from.first_name : "Channel",
          })
          console.log("Added document image:", fileName)
        }
      }
    }

    // Update cached data
    cachedData.messages = [...messages, ...cachedData.messages].slice(0, 50)
    cachedData.images = [...images, ...cachedData.images].slice(0, 20)

    console.log(
      `Processed ${processedCount} messages from correct chat, found ${messages.length} text messages and ${images.length} images`,
    )

    return cachedData
  } catch (error) {
    console.error("Error fetching Telegram messages:", error)
    return cachedData
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "✅ Telegram Bot Server Running",
    message: "Server is working correctly!",
    endpoints: {
      "/api/telegram": "Get messages and images from Telegram channel",
      "/health": "Health check",
      "/images/*": "Static image files",
    },
    config: {
      botToken: BOT_TOKEN.substring(0, 10) + "...",
      chatId: CHAT_ID,
      port: PORT,
    },
    cache: {
      messages: cachedData.messages.length,
      images: cachedData.images.length,
      lastUpdate: cachedData.lastUpdate,
    },
    timestamp: new Date().toISOString(),
  })
})

// API endpoint to get messages and images
app.get("/api/telegram", async (req, res) => {
  try {
    console.log("API request received for /api/telegram")
    const data = await fetchTelegramMessages()
    res.json(data)
  } catch (error) {
    console.error("API error:", error)
    res.status(500).json({
      success: false,
      error: "Failed to fetch data",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  })
})

app.use((err, req, res, next) => {
  console.error("Server error:", err)
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
    timestamp: new Date().toISOString(),
  })
})

// Start server with better error handling
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Telegram server running on port ${PORT}`)
  console.log(`📱 Bot Token: ${BOT_TOKEN}`)
  console.log(`💬 Chat ID: ${CHAT_ID}`)
  console.log(`🌐 Server URL: http://localhost:${PORT}`)

  // Initial fetch
  fetchTelegramMessages().catch(console.error)

  // Fetch new messages every 30 seconds
  setInterval(() => {
    fetchTelegramMessages().catch(console.error)
  }, 30000)
})

server.on("error", (error) => {
  console.error("Server failed to start:", error)
})

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})
