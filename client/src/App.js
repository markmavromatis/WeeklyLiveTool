import { useState, useEffect, useCallback } from "react";
import "./App.css";

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  getArticles: () => fetch("/api/articles").then((r) => r.json()),
  createArticle: (data) =>
    fetch("/api/articles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json()),
  updateArticle: (id, data) =>
    fetch(`/api/articles/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json()),
  deleteArticle: (id) => fetch(`/api/articles/${id}`, { method: "DELETE" }).then((r) => r.json()),
  getSummary: (id, apiKey, articleText) =>
    fetch(`/api/articles/${id}/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ articleText }),
    }).then((r) => r.json()),
  clearSummary: (id) => fetch(`/api/articles/${id}/summary`, { method: "DELETE" }).then((r) => r.json()),
};

// ── Browser-side article fetcher ──────────────────────────────────────────────
async function fetchArticleText(url) {
  const res = await fetch(url);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Remove noise elements
  ["script", "style", "nav", "header", "footer", "aside", "iframe", "noscript"].forEach(
    (tag) => doc.querySelectorAll(tag).forEach((el) => el.remove())
  );

  // Prefer article/main content if available
  const content =
    doc.querySelector("article") ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector("main") ||
    doc.body;

  return (content?.innerText || content?.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), isError ? 7000 : 3000);
  }, []);
  return { toast, show };
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function ArticleModal({ article, onClose, onSave }) {
  const [url, setUrl] = useState(article?.url || "");
  const [headline, setHeadline] = useState(article?.headline || "");
  const [notes, setNotes] = useState(article?.notes || "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim() || !headline.trim()) return;
    setSaving(true);
    await onSave({ url: url.trim(), headline: headline.trim(), notes: notes.trim() });
    setSaving(false);
  };

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{article ? "Edit Article" : "Add Article"}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="field">
              <label>URL *</label>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." autoFocus required />
            </div>
            <div className="field">
              <label>Headline *</label>
              <input type="text" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Article headline..." required />
            </div>
            <div className="field">
              <label>Personal Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Your thoughts, why this matters for the broadcast..." />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "SAVE"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── API Key Modal ─────────────────────────────────────────────────────────────
function ApiKeyModal({ onClose, onSave }) {
  const [key, setKey] = useState("");
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Anthropic API Key</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="api-key-hint">Your API key is stored only in your browser's localStorage and sent directly to the backend for Claude calls. It is never logged or persisted on disk.</p>
          <div className="field" style={{ marginTop: 16 }}>
            <label>API Key</label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-..."
              autoFocus
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (key.trim()) onSave(key.trim()); }}>SAVE KEY</button>
        </div>
      </div>
    </div>
  );
}

// ── Article Card ──────────────────────────────────────────────────────────────
function ArticleCard({ article, index, onEdit, onDelete, onGetSummary, onClearSummary, loadingId }) {
  const isLoading = loadingId === article.id;
  const [open, setOpen] = useState(isLoading);

  // Auto-expand when this card starts loading
  useEffect(() => { if (isLoading) setOpen(true); }, [isLoading]);
  const summary = article.summary ? JSON.parse(article.summary) : null;

  return (
    <div className={`article-card ${open ? "is-open" : ""}`}>
      <div className="card-header" onClick={() => setOpen((o) => !o)}>
        <span className="card-number">{String(index).padStart(2, "0")}</span>
        <div className="card-main">
          <div className="card-headline">{article.headline}</div>
          <a
            className="card-url"
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {article.url}
          </a>
        </div>
        <div className="card-actions">
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onEdit(article); }}>EDIT</button>
          <button className="btn btn-danger btn-sm" onClick={(e) => { e.stopPropagation(); onDelete(article.id); }}>REMOVE</button>
          <span className={`chevron ${open ? "open" : ""}`}>▾</span>
        </div>
      </div>

      {open && (
        <div className="card-body">
          <div className="card-section">
            <div className="section-label">Personal Notes</div>
            <div className={`notes-text ${!article.notes ? "notes-empty" : ""}`}>
              {article.notes || "No notes added."}
            </div>
          </div>

          <div className="card-section">
            <div className="section-label">AI Summary</div>
            {isLoading ? (
              <div className="summary-loading">
                <div className="spinner" /> Fetching article &amp; generating summary…
              </div>
            ) : summary ? (
              <>
                <div className="summary-content">
                  {summary.map((b, i) => (
                    <div className="summary-bullet" key={i}>{b}</div>
                  ))}
                </div>
                <div className="summary-actions">
                  <button className="btn btn-ai btn-sm" onClick={() => onGetSummary(article.id, article.url)}>↺ REGENERATE</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => onClearSummary(article.id)}>CLEAR</button>
                </div>
              </>
            ) : (
              <>
                <div className="summary-empty">No summary yet.</div>
                <div className="summary-actions">
                  <button className="btn btn-ai btn-sm" onClick={() => onGetSummary(article.id, article.url)}>
                    ✦ AI GET SUMMARY
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [articles, setArticles] = useState([]);
  const [search, setSearch] = useState("");
  const [modalArticle, setModalArticle] = useState(undefined);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("nt_api_key") || "");
  const [loadingId, setLoadingId] = useState(null);
  const { toast, show: showToast } = useToast();

  useEffect(() => {
    api.getArticles()
      .then(setArticles)
      .catch(() => showToast("Could not connect to server. Is it running?", true));
  }, []); // eslint-disable-line

  useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setModalArticle(null); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const saveApiKey = (key) => {
    localStorage.setItem("nt_api_key", key);
    setApiKey(key);
    setShowApiKeyModal(false);
    showToast("API key saved.");
  };

  const handleSave = async (data) => {
    if (modalArticle?.id) {
      const updated = await api.updateArticle(modalArticle.id, data);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      showToast("Article updated.");
    } else {
      const created = await api.createArticle(data);
      setArticles((prev) => [created, ...prev]);
      showToast("Article added — generating summary…");
      handleGetSummary(created.id, data.url);
    }
    setModalArticle(undefined);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this article?")) return;
    await api.deleteArticle(id);
    setArticles((prev) => prev.filter((a) => a.id !== id));
    showToast("Article removed.");
  };

  const handleGetSummary = async (id, url) => {
    if (!apiKey) { setShowApiKeyModal(true); return; }
    setLoadingId(id);
    try {
      // Step 1: fetch article content in the browser
      let articleText = "";
      try {
        articleText = await fetchArticleText(url);
      } catch (fetchErr) {
        showToast("Could not fetch article page — summarising from headline only.", false);
      }

      // Step 2: send text to backend for Claude summarisation
      const updated = await api.getSummary(id, apiKey, articleText);
      if (updated.error) throw new Error(updated.error);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      showToast("AI summary generated.");
    } catch (err) {
      showToast("Summary failed: " + err.message, true);
    } finally {
      setLoadingId(null);
    }
  };

  const handleClearSummary = async (id) => {
    const updated = await api.clearSummary(id);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const filtered = articles.filter((a) =>
    !search || [a.headline, a.url, a.notes].some((s) => s?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <span className="header-jp">ニュース追跡</span>
          <span className="header-title">NEWS TRACKER</span>
        </div>
        <div className="header-right">
          <button
            className={`btn btn-ghost btn-sm api-key-btn ${apiKey ? "has-key" : "no-key"}`}
            onClick={() => setShowApiKeyModal(true)}
            title={apiKey ? "API key set — click to change" : "Set Anthropic API key"}
          >
            {apiKey ? "✓ API KEY SET" : "⚠ SET API KEY"}
          </button>
          <span className="header-meta">US TECH · WEEKLY LIVESTREAM</span>
        </div>
      </header>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-wrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles…" />
          </div>
          <span className="count-badge">{filtered.length} article{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <button className="btn btn-primary" onClick={() => setModalArticle(null)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
          ADD ARTICLE
        </button>
      </div>

      <main className="articles-container">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-jp">記事なし</span>
            <p>{search ? "No articles match your search." : "Add your first article to get started."}</p>
          </div>
        ) : (
          <>
            <div className="week-label">THIS WEEK — {filtered.length} ARTICLE{filtered.length !== 1 ? "S" : ""}</div>
            {filtered.map((a, i) => (
              <ArticleCard
                key={a.id}
                article={a}
                index={i + 1}
                onEdit={(article) => setModalArticle(article)}
                onDelete={handleDelete}
                onGetSummary={handleGetSummary}
                onClearSummary={handleClearSummary}
                loadingId={loadingId}
              />
            ))}
          </>
        )}
      </main>

      {modalArticle !== undefined && (
        <ArticleModal
          article={modalArticle}
          onClose={() => setModalArticle(undefined)}
          onSave={handleSave}
        />
      )}
      {showApiKeyModal && (
        <ApiKeyModal onClose={() => setShowApiKeyModal(false)} onSave={saveApiKey} />
      )}

      {toast && <div className={`toast ${toast.isError ? "error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
