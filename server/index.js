const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const fs = require("fs");
const PptxGenJS = require("pptxgenjs");
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
app.use(cors({
  origin: (origin, cb) => {
    const allowed = !origin || origin === "http://localhost:3000" || /^chrome-extension:\/\//.test(origin);
    cb(null, allowed ? true : false);
  },
}));
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
        const cleaned = decodeHtmlEntities(m[1].replace(/\\n/g, " ").replace(/\\\"/g, '"').replace(/<[^>]+>/g, " "));
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
          const body = ld.articleBody || ld.description || (Array.isArray(ld["@graph"]) && ld["@graph"].find((n) => n.articleBody)?.articleBody);
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

function findTargetSession(sessions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const future = sessions
    .filter((s) => new Date(s.date + "T12:00:00") >= today)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (future.length === 0) return null;

  const nearest = [...future].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  const nearestDate = new Date(nearest.date + "T12:00:00");
  if (nearestDate.getTime() === tomorrow.getTime() && future.length === 1) return null;

  return future[0];
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

  const db = readDb();
  const existing = db.articles.find((a) => a.url === url);
  if (existing) return res.status(409).json({ error: "duplicate", article: existing });

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
  const targetSession = findTargetSession(db.sessions);
  const article = {
    id: db.nextId++,
    url,
    headline,
    headline_jp: "",
    notes: notes || "",
    article_date,
    tags: [],
    summary: null,
    session_id: targetSession ? targetSession.id : null,
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

// PUT update article Japanese headline
app.put("/api/articles/:id/headline-jp", (req, res) => {
  const id = parseInt(req.params.id);
  const { headline_jp } = req.body;
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });
  article.headline_jp = headline_jp || "";
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
  try {
  const id = parseInt(req.params.id);
  const db = readDb();
  const article = db.articles.find((a) => a.id === id);
  if (!article) return res.status(404).json({ error: "Not found" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });

  // Article text is fetched browser-side (with your cookies, so paywalls work).
  const bodyText = (req.body?.articleText || "").trim();

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

    // Re-read DB before writing to avoid clobbering concurrent changes (e.g. session assignment)
    const freshDb = readDb();
    const freshArticle = freshDb.articles.find((a) => a.id === id);
    if (!freshArticle) return res.status(404).json({ error: "Not found" });
    freshArticle.summary = JSON.stringify(bullets.length ? bullets : [text]);
    freshArticle.tags = tags;
    writeDb(freshDb);
    res.json(freshArticle);
  } catch (err) {
    console.error("Summary error:", err.message);
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

// POST translate headlines to Japanese
app.post("/api/translate-headlines", async (req, res) => {
  const { headlines } = req.body; // [{ id, headline }]
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return res.status(400).json({ error: "headlines array is required" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });

  const client = new Anthropic({ apiKey });

  const numbered = headlines.map((h, i) => `${i + 1}. ${h.headline}`).join("\n");
  const prompt = `Translate the following English news headlines to Japanese. Return only the translations, numbered in the same order, with no additional text or explanation.\n\n${numbered}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const translations = {};
    lines.forEach((line, i) => {
      const match = line.match(/^\d+[\.\)]\s*(.+)/);
      if (match && i < headlines.length) {
        translations[headlines[i].id] = match[1].trim();
      }
    });

    res.json(translations);
  } catch (err) {
    console.error("Translation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST export long list as PPTX
app.post("/api/sessions/:id/export-pptx", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });

  const db = readDb();
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const sessionArticles = db.articles
      .filter((a) => a.session_id === sessionId)
      .sort((a, b) => {
        const dateCmp = (a.article_date || "").localeCompare(b.article_date || "");
        return dateCmp !== 0 ? dateCmp : (a.headline || "").localeCompare(b.headline || "");
      });

    // Use stored headline_jp; fall back to translating any that are missing
    const needsTranslation = sessionArticles.filter((a) => !a.headline_jp);
    const headlineMap = Object.fromEntries(sessionArticles.map((a) => [a.id, a.headline_jp || ""]));
    if (needsTranslation.length > 0) {
      try {
        const client = new Anthropic({ apiKey });
        const numbered = needsTranslation.map((a, i) => `${i + 1}. ${a.headline}`).join("\n");
        const message = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{ role: "user", content: `Translate the following English news headlines to Japanese. Return only the translations, numbered in the same order, with no additional text or explanation.\n\n${numbered}` }],
        });
        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
          const match = line.match(/^\d+[\.\)]\s*(.+)/);
          if (match && i < needsTranslation.length) headlineMap[needsTranslation[i].id] = match[1].trim();
        });
      } catch (e) {
        console.warn("Could not translate missing headlines:", e.message);
      }
    }

    const ARTICLES_PER_SLIDE = 10;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";

    const HEADER = ["Date", "Headline", "Japanese Headline", "URL"];
    const COL_W  = [1.1, 4.2, 5.5, 0.8];
    const LEFT   = 0.25;
    const TOP    = 0.5;
    const TABLE_H = 3.3;
    const totalPages = Math.max(1, Math.ceil(sessionArticles.length / ARTICLES_PER_SLIDE));

    for (let page = 0; page < totalPages; page++) {
      const slide = pptx.addSlide();
      const pageLabel = totalPages > 1 ? ` (${page + 1}/${totalPages})` : "";
      slide.addText(`Long List — Session #${session.index}${pageLabel}`, {
        x: LEFT, y: 0.1, w: 12.8, h: 0.35,
        fontSize: 14, bold: true, color: "1a1a2e",
      });

      const chunk = sessionArticles.slice(page * ARTICLES_PER_SLIDE, (page + 1) * ARTICLES_PER_SLIDE);
      const rows = [
        HEADER.map((h) => ({
          text: h,
          options: { bold: true, fill: { color: "1a1a2e" }, color: "FFFFFF", fontSize: 18, align: "center", valign: "middle" },
        })),
        ...chunk.map((a, i) => {
          const dateStr = a.article_date
            ? new Date(a.article_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : "";
          const fillColor = i % 2 === 0 ? "F5F5F5" : "FFFFFF";
          return [
            { text: dateStr, options: { fontSize: 16, fill: { color: fillColor }, valign: "middle", wrap: true } },
            { text: a.headline || "", options: { fontSize: 16, fill: { color: fillColor }, valign: "middle", wrap: true } },
            { text: headlineMap[a.id] || "", options: { fontSize: 16, fill: { color: fillColor }, valign: "middle", wrap: true } },
            { text: "Link", options: { fontSize: 16, fill: { color: fillColor }, valign: "middle", align: "center", hyperlink: { url: a.url } } },
          ];
        }),
      ];

      slide.addTable(rows, {
        x: LEFT, y: TOP, w: COL_W.reduce((s, v) => s + v, 0), h: TABLE_H,
        colW: COL_W,
        border: { type: "solid", pt: 0.5, color: "CCCCCC" },
        rowH: [0.25, ...Array(chunk.length).fill((TABLE_H - 0.25) / chunk.length / 2)],
      });
    }

    const dateStr = session.date.replace(/-/g, "");
    const fileName = `long-list-session${session.index}-${dateStr}.pptx`;
    const buffer = await pptx.write("nodebuffer");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    console.error("PPTX export error:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
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
