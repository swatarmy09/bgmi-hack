# Telegram Image Server

This server fetches images and messages from your Telegram channel and serves them via API.

## Setup

1. Upload this server folder to your hosting service (Render, Heroku, etc.)
2. Install dependencies: `npm install`
3. Start the server: `npm start`

## Environment Variables

The server uses these hardcoded values:
- BOT_TOKEN: 6013210017:AAH9TkOQwYk4IiYMRAHIIaytfsoa6ck7VPQ
- CHAT_ID: -4891957310

## API Endpoints

- `GET /api/telegram` - Returns messages and images from the channel
- `GET /health` - Health check endpoint
- `GET /images/{filename}` - Serves downloaded images

## Deployment

### Render.com
1. Connect your GitHub repo
2. Set build command: `npm install`
3. Set start command: `npm start`
4. Deploy

### Heroku
1. Create new app
2. Connect GitHub repo
3. Deploy

The server will automatically:
- Fetch new messages every 30 seconds
- Download and store images locally
- Serve images via HTTP
- Cache the last 50 messages and 20 images
\`\`\`

```tsx file="" isHidden
