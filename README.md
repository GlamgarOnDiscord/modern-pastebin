<div align="center">

✦

# Scribble

> A premium, dark-mode first Pastebin alternative — powered by Vercel Serverless and Upstash Redis.

<p align="center">
  <img src="https://img.shields.io/github/stars/GlamgarOnDiscord/modern-pastebin?style=social" alt="GitHub Stars" />
  <img src="https://img.shields.io/github/issues/GlamgarOnDiscord/modern-pastebin" alt="Issues" />
  <img src="https://img.shields.io/github/forks/GlamgarOnDiscord/modern-pastebin?style=social" alt="Forks" />
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Stack-Vanilla_JS_·_HTML_·_CSS-F7DF1E" alt="Tech Stack" />
  <img src="https://img.shields.io/badge/Database-Vercel_KV-000000" alt="Vercel KV" />
  <img src="https://img.shields.io/badge/built%20by-GlamgarOnDiscord-10b981" alt="Author" />
</p>

[![Live Preview](https://img.shields.io/badge/🌐_Live_Demo-modern--pastebin.vercel.app-10b981?style=for-the-badge)](https://modern-pastebin.vercel.app/)

<br />

<img src="./public/og-image.png" alt="Scribble App Preview" width="800" style="border-radius: 12px; border: 1px solid #2a2a2a;" />

</div>

---

## 🆕 What's New

- **Quick Access:** A discreet icon in the top right of the homepage allows you to quickly jump to any paste ID or URL.
- **Interactive Comments:** Authors can now enable comments on their pastes. Both viewers and admins can discuss in real-time.
- **Live Viewer Count:** See exactly how many people are currently looking at your code with the real-time active viewers badge.

---

## 🚀 Overview

**Scribble** is an engineering-centric alternative to traditional pastebins. It features a product-first, terminal-inspired dark mode interface that respects your time. Share code snippets, notes, or configuration files instantly without signing up.

The system is built upon a high-performance **Vercel Serverless** backend, utilizing **Upstash Redis (Vercel KV)** for sub-millisecond data retrieval.

---

## 🏗️ Architecture

```
modern-pastebin/
├── public/                 ← Frontend assets
│   ├── index.html          ← Compose / Editor view
│   ├── view.html           ← Read-only Viewer
│   └── style.css           ← Premium Design tokens
├── api/                    ← Serverless Backend
│   ├── create.js           ← POST new pastes
│   ├── content.js          ← GET paste content
│   ├── update.js           ← PUT paste updates
│   └── auth.js             ← PIN validation
└── server.js               ← Local Node.js development server
```

### Data Flow

```
User Browser
     │
     ▼
┌─────────────────────┐
│  Vercel Serverless  │  Node.js API Routes
│  Edge Network       │  JWT-style 48-char tokens
└──────────┬──────────┘
           │  Sub-millisecond latency
           ▼
┌─────────────────────┐
│  Vercel KV (Redis)  │  Ephemeral Storage
│  Upstash            │  Key-Value JSON Payloads
└─────────────────────┘
```

---

## ✨ Key Features

### 🎛️ Product-First Design

- **No Landing Page Bloat** — The editor _is_ the homepage. You create pastes immediately.
- **Terminal Aesthetics** — Monospace fonts, deep blacks (`#0a0a0b`), and subtle glassmorphism.
- **Linear/Raycast Inspired** — A strict design system using an emerald accent (`#10b981`), refined easing curves, and logical spacing.
- **Adaptive UI** — The interface morphs seamlessly between creation, success, and editing states without page reloads.

### 🔒 Security & Privacy

- **PIN Protection** — Optionally lock any paste with an 8-character code. Auth happens strictly server-side.
- **Admin Tokens** — Creation yields a unique, unguessable 48-character token for editing rights.
- **View-Only Separation** — Distinct URLs for readers and the original author.
- **Zero Tracking** — No analytics, no cookies, no data harvesting.

### ⚡ Performance

- **Live Sync Polling** — Viewers auto-update when the author makes changes, dynamically adjusting polling rates based on tab visibility to save resources.
- **Vanilla Stack** — Zero frontend framework overhead. Lightning-fast HTML/CSS/JS parses instantly.

---

## 🛠️ Getting Started

### Local Development

Clone the repository and run the local, in-memory Node server (zero external dependencies required for local testing):

```bash
git clone https://github.com/GlamgarOnDiscord/modern-pastebin.git
cd modern-pastebin

# Start the local server
npm start
```

Visit `http://localhost:3000`.

### Vercel Deployment (Production)

The repository is pre-configured for global edge deployment via Vercel.

1. **Deploy the repository:**

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/GlamgarOnDiscord/modern-pastebin&env=KV_REST_API_URL,KV_REST_API_TOKEN)

2. **Configure Storage:**
   Once deployed, navigate to your Vercel Dashboard → Storage (or Marketplace) and attach an **Upstash Redis** database to the project. Vercel will automatically inject the required `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables.

3. **Enjoy.**

---

## Screenshoot

<img src="./public/dash.jpg" alt="Scribble App Preview" width="800" style="border-radius: 12px;" />

---

## 🤝 Contributing

Pull Requests and ideas are welcome.

1. Fork the repo
2. Create your branch
3. Submit your PR

---

## 📜 License

**MIT License**
Built with ✦ by [GlamgarOnDiscord](https://github.com/GlamgarOnDiscord).
