# ニュース追跡 · News Tracker

A task management app for your weekly US Tech & News livestream. Track articles, add notes, and generate AI summaries with Claude.

## Stack

- **Frontend**: React (Create React App)
- **Backend**: Express + SQLite (via `better-sqlite3`)
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`)

---

## Setup

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Get an Anthropic API key

Get one at https://console.anthropic.com/

### 3. Run the app

```bash
npm run dev
```

This starts both:
- **Backend API** → http://localhost:3001
- **React frontend** → http://localhost:3000

Open http://localhost:3000 in your browser.

### 4. Set your API key in the app

Click **"⚠ SET API KEY"** in the top-right corner and paste your Anthropic API key.  
It is saved in your browser's localStorage and never written to disk.

---

## Usage

- **Add Article** — Enter URL, headline, and optional personal notes
- **Expand a card** — Click any article row to reveal notes and AI summary
- **✦ AI GET SUMMARY** — Calls Claude to generate 4–5 bullet points about the article
- **Edit / Remove** — Manage articles inline
- **Search** — Filters across headline, URL, and notes
- ⌘K / Ctrl+K — Quick-add shortcut

---

## Project Structure

```
news-tracker/
├── server/
│   └── index.js        # Express API + SQLite
├── client/
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── App.js      # Main React component
│       ├── App.css     # Styles
│       └── index.js    # Entry point
└── package.json        # Root scripts
```

The SQLite database (`server/articles.db`) is created automatically on first run.
