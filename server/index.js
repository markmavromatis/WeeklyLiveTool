const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3001;

// ── JSON file "database" ──────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "articles.json");

function readDb() {
  if (!fs.existsSync(DB_PATH)) return { articles: [], nextId: 1 };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Initialise file if missing
if (!fs.existsSync(DB_PATH)) writeDb({ articles: [], nextId: 1 });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

// GET all articles
app.get("/api/articles", (req, res) => {
  const { articles } = readDb();
  res.json([...articles].sort((a, b) => b.id - a.id));
});

// POST create article
app.post("/api/articles", (req, res) => {
  const { url, headline, notes } = req.body;
  if (!url || !headline) {
    return res.status(400).json({ error: "url and headline are required" });
  }
  const db = readDb();
  const article = {
    id: db.nextId++,
    url,
    headline,
    notes: notes || "",
    summary: null,
    created_at: new Date().toISOString(),
  };
  db.articles.push(article);
  writeDb(db);
  res.status(201).json(article);
});

// PUT update article
app.put("/api/articles/:id", (req, res) => {
  const { url, headline, notes } = req.body;
  const id = parseInt(req.params.id);
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });
  article.url = url;
  article.headline = headline;
  article.notes = notes || "";
  writeDb(db);
  res.json(article);
});

// DELETE article
app.delete("/api/articles/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  db.articles = db.articles.filter((a) => a.id !== id);
  writeDb(db);
  res.json({ ok: true });
});

// POST generate AI summary
app.post("/api/articles/:id/summary", async (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });

  // Article text is fetched browser-side and passed in the request body
  const { articleText } = req.body;

  const client = new Anthropic({ apiKey });

  const prompt = `You are a research assistant for a Japanese telecom company's Silicon Valley team that hosts a weekly US Tech & News livestream for a Japanese audience.

Summarise the following article content into exactly 4-5 bullet points. Base your summary solely on the text provided — do not comment on dates, knowledge cutoffs, or whether you recognise the article.

Article headline: "${article.headline}"
${article.notes ? `Reporter's notes: ${article.notes}\n` : ""}
${articleText ? `Article content:\n${articleText}` : "The full article text was not available. Summarise based on the headline alone."}

Each bullet must be a single clear sentence. Cover:
- The core news or development
- Why it matters for US tech
- Relevance to telecom, AI, or enterprise technology (if applicable)
- Key names, companies, or numbers involved

Format: start each bullet with "- " and nothing else. No intro, no outro, no caveats.`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const bullets = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());

    article.summary = JSON.stringify(bullets.length ? bullets : [text]);
    writeDb(db);
    res.json(article);
  } catch (err) {
    console.error("Anthropic error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE summary
app.delete("/api/articles/:id/summary", (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });
  article.summary = null;
  writeDb(db);
  res.json(article);
});

app.listen(PORT, () => {
  console.log(`✓ News Tracker API running at http://localhost:${PORT}`);
});
