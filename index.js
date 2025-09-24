const express = require("express")
const cors = require("cors")
const fetch = require("node-fetch")
const fs = require("fs")
const path = require("path")

const app = express()
const PORT = process.env.PORT || 3001

// Your Telegram credentials
const BOT_TOKEN = "6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ"
const CHAT_ID = "-4891957310"

app.use(cors())
app.use(express.json())
app.use("/images", express.static("images"))

// Store for cached images and messages
const cachedData = {
  messages: [],
  images: [],
  lastUpdate: 0,
}

// Function to download and save image
async function downloadImage(fileId, fileName) {
  try {
    // Get file path from Telegram
    const fileResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`)
    const fileData = await fileResponse.json()

    if (!fileData.ok) {
      console.log("Failed to get file path:", fileData)
      return null
    }

    const filePath = fileData.result.file_path
    const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`

    // Download image
    const imageResponse = await fetch(imageUrl)
    const buffer = await imageResponse.buffer()

    // Save to local images folder
    const imagesDir = path.join(__dirname, "images")
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true })
    }

    const localPath = path.join(imagesDir, fileName)
    fs.writeFileSync(localPath, buffer)

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

    // Get channel updates
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${cachedData.lastUpdate + 1}&limit=100`,
    )
    const data = await response.json()

    if (!data.ok) {
      console.error("Telegram API error:", data)
      return cachedData
    }

    console.log(`Received ${data.result.length} updates`)

    const messages = []
    const images = []

    for (const update of data.result) {
      if (update.update_id > cachedData.lastUpdate) {
        cachedData.lastUpdate = update.update_id
      }

      const message = update.message || update.channel_post
      if (!message) continue

      // Check if message is from our channel
      if (message.chat.id.toString() !== CHAT_ID) continue

      console.log("Processing message:", message.message_id)

      // Process text messages
      if (message.text) {
        messages.push({
          id: message.message_id,
          text: message.text,
          date: new Date(message.date * 1000).toISOString(),
          from: message.from ? message.from.first_name : "Channel",
        })
      }

      // Process images
      if (message.photo && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1] // Get highest resolution
        const fileName = `${message.message_id}_${photo.file_id}.jpg`

        console.log("Downloading image:", fileName)
        const localUrl = await downloadImage(photo.file_id, fileName)

        if (localUrl) {
          images.push({
            id: message.message_id,
            url: localUrl,
            caption: message.caption || "",
            date: new Date(message.date * 1000).toISOString(),
            from: message.from ? message.from.first_name : "Channel",
          })
        }
      }

      // Process documents (if they are images)
      if (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/")) {
        const fileName = `${message.message_id}_${message.document.file_id}.${message.document.mime_type.split("/")[1]}`

        console.log("Downloading document image:", fileName)
        const localUrl = await downloadImage(message.document.file_id, fileName)

        if (localUrl) {
          images.push({
            id: message.message_id,
            url: localUrl,
            caption: message.caption || message.document.file_name || "",
            date: new Date(message.date * 1000).toISOString(),
            from: message.from ? message.from.first_name : "Channel",
          })
        }
      }
    }

    // Update cached data
    cachedData.messages = [...messages, ...cachedData.messages].slice(0, 50) // Keep last 50 messages
    cachedData.images = [...images, ...cachedData.images].slice(0, 20) // Keep last 20 images

    console.log(`Processed ${messages.length} messages and ${images.length} images`)

    return cachedData
  } catch (error) {
    console.error("Error fetching Telegram messages:", error)
    return cachedData
  }
}

// API endpoint to get messages and images
app.get("/api/telegram", async (req, res) => {
  try {
    const data = await fetchTelegramMessages()
    res.json(data)
  } catch (error) {
    console.error("API error:", error)
    res.status(500).json({ error: "Failed to fetch data" })
  }
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

// Start server
app.listen(PORT, () => {
  console.log(`Telegram server running on port ${PORT}`)
  console.log(`Bot Token: ${BOT_TOKEN}`)
  console.log(`Chat ID: ${CHAT_ID}`)

  // Initial fetch
  fetchTelegramMessages()

  // Fetch new messages every 30 seconds
  setInterval(fetchTelegramMessages, 30000)
})
