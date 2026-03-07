# NanoClaw Web Chat

A fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) with a built-in web chat channel. Lets anyone talk to your NanoClaw agent from a browser — no Discord, Telegram, or WhatsApp needed.

## What's added

- **Web channel** (`src/channels/web.ts`) — HTTP server that plugs into NanoClaw's channel system
- **Chat UI** (`src/channels/web-frontend.ts`) — Dark-themed browser chat interface
- **Password auth** — Simple password gate so only authorized users can chat
- **Per-visitor isolation** — Each visitor gets their own agent session with separate memory
- **Long-polling** — Real-time responses without WebSockets

## Setup

### Prerequisites

- Node.js 22+
- Docker (for agent containers)
- An Anthropic API key
- [ngrok](https://ngrok.com/) (to expose publicly)

### Install

```bash
git clone https://github.com/zupzap/nanoclaw-web.git
cd nanoclaw-web
npm install
```

### Configure

Create a `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here
WEB_CHAT_PASSWORD=your-secret-password
WEB_CHAT_PORT=3100
```

### Build the agent container (first time)

```bash
./container/build.sh
```

### Run

```bash
npm run build && npm start
# or for development:
npm run dev
```

The chat UI will be at `http://localhost:3100`.

### Expose with ngrok

```bash
ngrok http 3100
```

Share the ngrok URL. Visitors enter the password and start chatting.

## How it works

```
Browser ──POST /api/send──> Web Channel ──> NanoClaw Orchestrator ──> Container (Claude Agent)
Browser <──POST /api/poll── Web Channel <── Agent response
```

Each browser session gets:
- A unique chat JID (`web:{session-id}`)
- Its own group folder (`groups/web-{id}/`)
- Isolated Claude session memory
- No trigger word needed (auto-prepended)

## Original NanoClaw

This is built on top of NanoClaw — a minimal personal Claude assistant system. See the [original repo](https://github.com/qwibitai/nanoclaw) for full documentation on the architecture, skills system, and other channels.
