const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const app = express();
const PORT = 3001;

// ── JSON file "database" ──────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "../db/articles.json");

function readDb() {
  if (!fs.existsSync(DB_PATH)) return { articles: [], sessions: [], nextId: 1, nextSessionId: 1 };
  const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  // Migrate older files that lack sessions
  if (!data.sessions) data.sessions = [];
  if (!data.nextSessionId) data.nextSessionId = 1;
  return data;
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) writeDb({ articles: [], sessions: [], nextId: 1, nextSessionId: 1 });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json({ limit: "2mb" }));

// ── Server-side URL fetcher ───────────────────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 15000,
    };
    const req = lib.get(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchUrl(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; if (data.length > 800000) req.destroy(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&nbsp;/g, " ");
}

function extractFromHtml(html) {
  // ── Headline ──
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{3,})["']/i)?.[1] ||
                  html.match(/<meta[^>]+content=["']([^"']{3,})["'][^>]+property=["']og:title["']/i)?.[1];
  const twitterTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{3,})["']/i)?.[1] ||
                       html.match(/<meta[^>]+content=["']([^"']{3,})["'][^>]+name=["']twitter:title["']/i)?.[1];
  const titleTag = html.match(/<title[^>]*>([^<]{3,})<\/title>/i)?.[1];
  const headline = decodeHtmlEntities((ogTitle || twitterTitle || titleTag || "").trim());

  // ── Date ──
  const dateMeta =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1] ||
    html.match(/datetime=["']([^"']+)["']/i)?.[1];

  let article_date = new Date().toISOString().slice(0, 10);
  if (dateMeta) {
    const parsed = new Date(dateMeta);
    if (!isNaN(parsed)) article_date = parsed.toISOString().slice(0, 10);
  }

  // ── Body text — try __NEXT_DATA__ JSON first (Next.js sites like The Verge) ──
  let bodyText = "";

  const nextDataMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Walk the props tree looking for article body content
      const json = JSON.stringify(nextData);
      // Extract all longish strings that look like article paragraphs
      const paragraphs = [];
      const matches = json.matchAll(/"(?:body|content|text|description)":\s*"([^"]{80,})"/g);
      for (const m of matches) {
        const cleaned = decodeHtmlEntities(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/<[^>]+>/g, " "));
        if (cleaned.length > 80) paragraphs.push(cleaned);
      }
      if (paragraphs.length > 0) {
        bodyText = paragraphs.join(" ").replace(/\s+/g, " ").trim().slice(0, 12000);
      }
    } catch (e) {
      // fall through to HTML stripping
    }
  }

  // ── Fallback: JSON-LD articleBody ──
  if (!bodyText) {
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const inner = block.replace(/<script[^>]*>|<\/script>/gi, "");
          const ld = JSON.parse(inner);
          const body = ld.articleBody || ld.description || (Array.isArray(ld["@graph"]) && ld["@graph"].find(n => n.articleBody)?.articleBody);
          if (body && body.length > 100) {
            bodyText = decodeHtmlEntities(body).replace(/\s+/g, " ").trim().slice(0, 12000);
            break;
          }
        } catch (e) {}
      }
    }
  }

  // ── Final fallback: strip all HTML tags ──
  if (!bodyText) {
    bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);
    bodyText = decodeHtmlEntities(bodyText);
  }

  return { headline, article_date, bodyText };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET all articles
app.get("/api/articles", (req, res) => {
  const { articles } = readDb();
  res.json([...articles].sort((a, b) => b.id - a.id));
});

// POST create article — fetches headline + date server-side
app.post("/api/articles", async (req, res) => {
  const { url, notes } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  let headline = url;
  let article_date = new Date().toISOString().slice(0, 10);

  try {
    const html = await fetchUrl(url);
    const meta = extractFromHtml(html);
    if (meta.headline) headline = meta.headline;
    article_date = meta.article_date;
  } catch (e) {
    console.warn("Could not fetch URL for meta:", e.message);
  }

  const db = readDb();
  const article = {
    id: db.nextId++,
    url,
    headline,
    notes: notes || "",
    article_date,
    tags: [],
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

// PUT update article tags
app.put("/api/articles/:id/tags", (req, res) => {
  const id = parseInt(req.params.id);
  const { tags } = req.body;
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });
  article.tags = Array.isArray(tags) ? tags : [];
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

// POST generate AI summary — fetches article server-side, sends to Claude
app.post("/api/articles/:id/summary", async (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });

  // Article text is fetched browser-side (with your cookies, so paywalls work).
  const bodyText = (req.body.articleText || "").trim();

  const client = new Anthropic({ apiKey });

  const PRESET_TAGS = ["AdTech","AI","Enterprise","Mobility","Robotics","Semiconductors","Streaming","Social Media","Sustainability"];

  const prompt = `You are a research assistant for a Japanese telecom company's Silicon Valley team producing a weekly US Tech & News livestream.

Your job is to write a summary AND assign tags to the article below. You must always produce output — never refuse, never ask for clarification, never comment on dates or your training data.

Headline: "${article.headline}"
${article.notes ? `Reporter notes: ${article.notes}\n` : ""}
Article text:
${bodyText || "(Article text unavailable — work from the headline only, making reasonable inferences about likely content.)"}

Produce your response in exactly this format and nothing else:

BULLETS:
- <bullet 1>
- <bullet 2>
- <bullet 3>
- <bullet 4>
- <bullet 5 (optional)>

TAGS: <comma-separated tags>

Rules for BULLETS (4-5 total, each one clear sentence):
- The core news or development
- Why it matters for the US tech industry
- Any relevance to telecom, AI, or enterprise technology
- Key names, companies, or figures involved
- Start every bullet with "- "

Rules for TAGS:
- Choose 1-3 tags that best describe the article content
- Prefer from this preset list where relevant: ${PRESET_TAGS.join(", ")}
- You may add a custom tag if none of the presets fit, but keep it short (1-2 words, title case)
- Output only the tag names separated by commas, no extra text`;

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

    // Parse BULLETS section
    const bulletsMatch = text.match(/BULLETS:\s*([\s\S]*?)(?=\nTAGS:|$)/i);
    const bulletsBlock = bulletsMatch ? bulletsMatch[1] : text;
    const bullets = bulletsBlock
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());

    // Parse TAGS section
    const tagsMatch = text.match(/TAGS:\s*(.+)/i);
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    article.summary = JSON.stringify(bullets.length ? bullets : [text]);
    article.tags = tags;
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

// ── Session routes ───────────────────────────────────────────────────────────

// GET all sessions
app.get("/api/sessions", (req, res) => {
  const db = readDb();
  res.json([...db.sessions].sort((a, b) => b.index - a.index));
});

// POST create session
app.post("/api/sessions", (req, res) => {
  const { date, index, participants } = req.body;
  if (!date || index === undefined) return res.status(400).json({ error: "date and index are required" });
  const db = readDb();
  const session = {
    id: db.nextSessionId++,
    date,
    index: parseInt(index),
    participants: participants || [],
    created_at: new Date().toISOString(),
  };
  db.sessions.push(session);
  writeDb(db);
  res.status(201).json(session);
});

// PUT update session
app.put("/api/sessions/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { date, index, participants } = req.body;
  const db = readDb();
  const session = db.sessions.find((s) => s.id === id);
  if (!session) return res.status(404).json({ error: "Not found" });
  session.date = date;
  session.index = parseInt(index);
  session.participants = participants || [];
  writeDb(db);
  res.json(session);
});

// DELETE session (unlinks articles but does not delete them)
app.delete("/api/sessions/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  db.sessions = db.sessions.filter((s) => s.id !== id);
  db.articles.forEach((a) => { if (a.session_id === id) a.session_id = null; });
  writeDb(db);
  res.json({ ok: true });
});

// PUT assign article to session
app.put("/api/sessions/:sessionId/articles/:articleId", (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  const articleId = parseInt(req.params.articleId);
  const db = readDb();
  const article = db.articles.find((a) => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Article not found" });
  article.session_id = sessionId;
  writeDb(db);
  res.json(article);
});

// DELETE unassign article from session
app.delete("/api/sessions/:sessionId/articles/:articleId", (req, res) => {
  const articleId = parseInt(req.params.articleId);
  const db = readDb();
  const article = db.articles.find((a) => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Article not found" });
  article.session_id = null;
  writeDb(db);
  res.json(article);
});

app.listen(PORT, () => {
  console.log(`✓ News Tracker API running at http://localhost:${PORT}`);
});
