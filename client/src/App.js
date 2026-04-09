import { useState, useEffect, useCallback } from "react";
import "./App.css";

// ── API ───────────────────────────────────────────────────────────────────────
const api = {
  // Articles
  getArticles: () => fetch("/api/articles").then((r) => r.json()),
  createArticle: (data) =>
    fetch("/api/articles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json()),
  setHeadlineJp: (id, headline_jp) =>
    fetch(`/api/articles/${id}/headline-jp`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ headline_jp }) }).then((r) => r.json()),
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

  // Sessions
  getSessions: () => fetch("/api/sessions").then((r) => r.json()),
  createSession: (data) =>
    fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json()),
  updateSession: (id, data) =>
    fetch(`/api/sessions/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json()),
  deleteSession: (id) => fetch(`/api/sessions/${id}`, { method: "DELETE" }).then((r) => r.json()),
  assignArticle: (sessionId, articleId) =>
    fetch(`/api/sessions/${sessionId}/articles/${articleId}`, { method: "PUT" }).then((r) => r.json()),
  unassignArticle: (sessionId, articleId) =>
    fetch(`/api/sessions/${sessionId}/articles/${articleId}`, { method: "DELETE" }).then((r) => r.json()),
  updateTags: (id, tags) =>
    fetch(`/api/articles/${id}/tags`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags }) }).then((r) => r.json()),
  translateHeadlines: (headlines, apiKey) =>
    fetch("/api/translate-headlines", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ headlines }),
    }).then((r) => r.json()),
};

const PRESET_TAGS = ["AdTech","AI","Enterprise","Mobility","Robotics","Semiconductors","Streaming","Social Media","Sustainability"];

// ── Browser-side article body fetcher (uses your logged-in cookies) ──────────
async function fetchArticleText(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  ["script", "style", "nav", "header", "footer", "aside", "iframe", "noscript"].forEach(
    (tag) => doc.querySelectorAll(tag).forEach((el) => el.remove())
  );
  const content =
    doc.querySelector("article") ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector("main") ||
    doc.body;
  return (content?.innerText || content?.textContent || "")
    .replace(/\s+/g, " ").trim().slice(0, 12000);
}

// ── Session auto-assign helpers ──────────────────────────────────────────────
function nextFriday(fromDateStr) {
  const d = fromDateStr ? new Date(fromDateStr + "T12:00:00") : new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun … 5=Fri … 6=Sat
  const add = day === 5 ? 7 : (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

// Returns the best session to auto-assign to, or null if none qualifies.
// Picks the LATEST future session (furthest out) — the one actively being prepared.
// If the only future session is tomorrow, treat as "no good session" and prompt.
function findTargetSession(sessions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const future = sessions
    .filter((s) => new Date(s.date + "T12:00:00") >= today)
    .sort((a, b) => new Date(b.date) - new Date(a.date)); // latest first

  if (future.length === 0) return null;

  // If the only/nearest future session is tomorrow, prompt for a new one
  const nearest = [...future].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  const nearestDate = new Date(nearest.date + "T12:00:00");
  if (nearestDate.getTime() === tomorrow.getTime() && future.length === 1) return null;

  return future[0]; // latest future session
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

// ── Session Prompt Modal ─────────────────────────────────────────────────────
function SessionPromptModal({ fridayDate, onYes, onNo }) {
  const fmt = new Date(fridayDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric"
  });
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">No Upcoming Session</span>
        </div>
        <div className="modal-body">
          <p className="api-key-hint">
            There is no upcoming weekly live session to assign this article to.
            Would you like to create one for <strong>{fmt}</strong>?
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onNo}>No, skip</button>
          <button className="btn btn-primary" onClick={onYes}>Yes, create session</button>
        </div>
      </div>
    </div>
  );
}

// ── Article Modal ─────────────────────────────────────────────────────────────
function ArticleModal({ article, onClose, onSave }) {
  const [url, setUrl] = useState(article?.url || "");
  const [notes, setNotes] = useState(article?.notes || "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSaving(true);
    await onSave({ url: url.trim(), notes: notes.trim() });
    setSaving(false);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
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
              <label>Personal Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Your thoughts, why this matters for the broadcast..." />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Fetching & saving…" : "SAVE"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Session Modal ─────────────────────────────────────────────────────────────
function SessionModal({ session, onClose, onSave, defaultIndex, defaultDate }) {
  const [date, setDate] = useState(session?.date || defaultDate || nextFriday());
  const [index, setIndex] = useState(session?.index ?? defaultIndex ?? "");
  const [participantInput, setParticipantInput] = useState("");
  const [participants, setParticipants] = useState(session?.participants || []);
  const [saving, setSaving] = useState(false);

  const addParticipant = () => {
    const name = participantInput.trim();
    if (name && !participants.includes(name)) {
      setParticipants((p) => [...p, name]);
      setParticipantInput("");
    }
  };

  const removeParticipant = (name) => setParticipants((p) => p.filter((x) => x !== name));

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); addParticipant(); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!date || index === "") return;
    setSaving(true);
    await onSave({ date, index: parseInt(index), participants });
    setSaving(false);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{session ? "Edit Session" : "New Session"}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="field-row">
              <div className="field">
                <label>Session # *</label>
                <input type="number" value={index} onChange={(e) => setIndex(e.target.value)} placeholder="42" min="1" required autoFocus />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label>Date *</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <div className="field">
              <label>Participants</label>
              <div className="participant-input-row">
                <input
                  type="text"
                  value={participantInput}
                  onChange={(e) => setParticipantInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a name and press Enter…"
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={addParticipant}>ADD</button>
              </div>
              {participants.length > 0 && (
                <div className="participant-tags">
                  {participants.map((p) => (
                    <span key={p} className="participant-tag">
                      {p}
                      <button type="button" onClick={() => removeParticipant(p)}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "SAVE"}</button>
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
          <p className="api-key-hint">Stored in localStorage only. Never logged or persisted on disk.</p>
          <div className="field" style={{ marginTop: 16 }}>
            <label>API Key</label>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." autoFocus />
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

// ── Tag Editor ───────────────────────────────────────────────────────────────
function TagEditor({ tags = [], onChange }) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);

  const add = (tag) => {
    const t = tag.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput("");
    setOpen(false);
  };

  const remove = (tag) => onChange(tags.filter((t) => t !== tag));

  const suggestions = PRESET_TAGS.filter(
    (t) => !tags.includes(t) && t.toLowerCase().includes(input.toLowerCase())
  );

  return (
    <div className="tag-editor">
      <div className="tag-list">
        {tags.map((t) => (
          <span key={t} className="tag-pill">
            {t}
            <button onClick={() => remove(t)}>×</button>
          </span>
        ))}
        <div className="tag-input-wrap">
          <input
            className="tag-input"
            value={input}
            placeholder="+ tag"
            onChange={(e) => { setInput(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) { e.preventDefault(); add(input); }
              if (e.key === "Escape") { setInput(""); setOpen(false); }
            }}
          />
          {open && (suggestions.length > 0 || input.trim()) && (
            <div className="tag-dropdown">
              {suggestions.map((t) => (
                <div key={t} className="tag-option" onMouseDown={() => add(t)}>{t}</div>
              ))}
              {input.trim() && !PRESET_TAGS.includes(input.trim()) && (
                <div className="tag-option tag-option-custom" onMouseDown={() => add(input)}>
                  Add "{input.trim()}"
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Article Card ──────────────────────────────────────────────────────────────
function ArticleCard({ article, index, onEdit, onDelete, onGetSummary, onClearSummary, loadingId, sessionBadge, sessions, onAssign, onUnassign, onTagsChange }) {
  const isLoading = loadingId === article.id;
  const [open, setOpen] = useState(isLoading);
  useEffect(() => { if (isLoading) setOpen(true); }, [isLoading]);
  const summary = article.summary ? JSON.parse(article.summary) : null;
  const tags = article.tags || [];

  const handleSessionChange = (e) => {
    const val = e.target.value;
    if (val === "") onUnassign(article.id);
    else onAssign(parseInt(val), article.id);
  };

  return (
    <div className="article-card">
      <div className="card-header" onClick={() => setOpen((o) => !o)}>
        <span className="card-number">{String(index).padStart(2, "0")}</span>
        <div className="card-main">
          <div className="card-headline">{article.headline}</div>
          <div className="card-meta">
            {article.article_date && (
              <span className="card-date">{new Date(article.article_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
            )}
            {sessionBadge && <span className="session-badge">#{sessionBadge}</span>}
            {tags.map((t) => <span key={t} className="tag-pill tag-pill-sm">{t}</span>)}
            <a className="card-url" href={article.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{article.url}</a>
          </div>
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
            <div className="section-label">Tags</div>
            <TagEditor tags={tags} onChange={(newTags) => onTagsChange(article.id, newTags)} />
          </div>
          <div className="card-section">
            <div className="section-label">Live Session</div>
            <select className="session-select" value={article.session_id || ""} onChange={handleSessionChange}>
              <option value="">— Unassigned —</option>
              {[...sessions].sort((a, b) => b.index - a.index).map((s) => (
                <option key={s.id} value={s.id}>
                  #{s.index} · {new Date(s.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {s.participants.length > 0 ? " · " + s.participants.join(", ") : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="card-section">
            <div className="section-label">Personal Notes</div>
            <div className={`notes-text ${!article.notes ? "notes-empty" : ""}`}>{article.notes || "No notes added."}</div>
          </div>
          <div className="card-section">
            <div className="section-label">AI Summary</div>
            {isLoading ? (
              <div className="summary-loading"><div className="spinner" /> Fetching article & generating summary…</div>
            ) : summary ? (
              <>
                <div className="summary-content">
                  {summary.map((b, i) => <div className="summary-bullet" key={i}>{b}</div>)}
                </div>
                <div className="summary-actions">
                  <button className="btn btn-ai btn-sm" onClick={() => onGetSummary(article.id)}>↺ REGENERATE</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => onClearSummary(article.id)}>CLEAR</button>
                </div>
              </>
            ) : (
              <>
                <div className="summary-empty">No summary yet.</div>
                <div className="summary-actions">
                  <button className="btn btn-ai btn-sm" onClick={() => onGetSummary(article.id)}>✦ AI GET SUMMARY</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Export Long List ──────────────────────────────────────────────────────────
async function exportLongList(session, apiKey = "") {
  const dateStr = session.date.replace(/-/g, "");
  const fileName = `long-list-session${session.index}-${dateStr}.pptx`;
  const res = await fetch(`/api/sessions/${session.id}/export-pptx`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Session Card ──────────────────────────────────────────────────────────────
function SessionCard({ session, articles, allArticles, onEdit, onDelete, onAssign, onUnassign, apiKey, setShowApiKeyModal, showToast }) {
  const [open, setOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!apiKey) { setShowApiKeyModal(true); return; }
    setExporting(true);
    try {
      await exportLongList(session, apiKey);
    } catch (e) {
      showToast("Export failed: " + e.message, true);
    } finally {
      setExporting(false);
    }
  };
  const sessionArticles = articles.filter((a) => a.session_id === session.id);
  const unassigned = allArticles.filter((a) => !a.session_id);

  const fmt = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="session-card">
      <div className="session-card-header" onClick={() => setOpen((o) => !o)}>
        <div className="session-index">#{session.index}</div>
        <div className="session-main">
          <div className="session-date">{fmt(session.date)}</div>
          <div className="session-meta">
            {session.participants.length > 0
              ? session.participants.map((p) => <span key={p} className="participant-chip">{p}</span>)
              : <span className="session-no-participants">No participants</span>}
            <span className="session-article-count">{sessionArticles.length} article{sessionArticles.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
        <div className="card-actions">
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onEdit(session); }}>EDIT</button>
          <button className="btn btn-danger btn-sm" onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}>REMOVE</button>
          <span className={`chevron ${open ? "open" : ""}`}>▾</span>
        </div>
      </div>

      {open && (
        <div className="session-body">
          <div className="section-label">Articles</div>

          {sessionArticles.length === 0 && <div className="summary-empty">No articles assigned yet.</div>}

          {sessionArticles.map((a, i) => (
            <div key={a.id} className="session-article-row">
              <span className="session-article-num">{String(i + 1).padStart(2, "0")}</span>
              <div className="session-article-info">
                <div className="session-article-headline">{a.headline}</div>
                {a.article_date && (
                  <span className="session-article-date">{new Date(a.article_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                )}
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => onUnassign(session.id, a.id)}>UNLINK</button>
            </div>
          ))}

          <div className="session-footer-actions">
            <button
              className="btn btn-ghost btn-sm export-btn"
              disabled={exporting}
              onClick={handleExport}
              title="Download all session articles as Excel (with Japanese translations)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {exporting ? "TRANSLATING…" : "EXPORT LONG LIST"}
            </button>
          </div>

          <div className="session-add-article">
            {showPicker ? (
              <div className="article-picker">
                <div className="article-picker-header">
                  <span>Select an unassigned article</span>
                  <button className="modal-close" onClick={() => setShowPicker(false)}>×</button>
                </div>
                {unassigned.length === 0
                  ? <div className="summary-empty" style={{ padding: "12px 0" }}>All articles are already assigned.</div>
                  : unassigned.map((a) => (
                    <div key={a.id} className="picker-article-row" onClick={() => { onAssign(session.id, a.id); setShowPicker(false); }}>
                      <div className="session-article-headline">{a.headline}</div>
                      {a.article_date && <span className="session-article-date">{new Date(a.article_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                    </div>
                  ))
                }
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowPicker(true)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
                LINK ARTICLE
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Articles Screen ───────────────────────────────────────────────────────────
function ArticlesScreen({ articles, sessions, setSessions, setArticles, apiKey, setShowApiKeyModal, showToast }) {
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState(null);
  const [modalArticle, setModalArticle] = useState(undefined);
  const [loadingId, setLoadingId] = useState(null);
  const [sessionPrompt, setSessionPrompt] = useState(null); // { articleId, fridayDate }

  const sessionMap = Object.fromEntries(sessions.map((s) => [s.id, s.index]));

  // All tags across all articles, deduplicated and sorted
  const allTags = [...new Set(articles.flatMap((a) => a.tags || []))].sort();

  useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setModalArticle(null); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const handleSave = async (data) => {
    if (modalArticle?.id) {
      const updated = await api.updateArticle(modalArticle.id, data);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      showToast("Article updated.");
      setModalArticle(undefined);
      return;
    }

    const created = await api.createArticle(data);
    setArticles((prev) => [created, ...prev]);
    setModalArticle(undefined);
    showToast("Article added — generating summary…");
    handleGetSummary(created.id);
    handleTranslateHeadline(created.id, created.headline);

    // Auto-assign to an upcoming session, or prompt to create one
    const target = findTargetSession(sessions);
    if (target) {
      const updated = await api.assignArticle(target.id, created.id);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } else {
      setSessionPrompt({ articleId: created.id, fridayDate: nextFriday() });
    }
  };

  const handleSessionPromptYes = async () => {
    if (!sessionPrompt) return;
    const { articleId, fridayDate } = sessionPrompt;
    setSessionPrompt(null);

    // Work out the next session index
    const maxIndex = sessions.reduce((m, s) => Math.max(m, s.index), 0);
    const newSession = await api.createSession({ date: fridayDate, index: maxIndex + 1, participants: [] });
    setSessions((prev) => [newSession, ...prev]);

    const updated = await api.assignArticle(newSession.id, articleId);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    showToast(`Session #${newSession.index} created and article linked.`);
  };

  const handleSessionPromptNo = () => setSessionPrompt(null);

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this article?")) return;
    await api.deleteArticle(id);
    setArticles((prev) => prev.filter((a) => a.id !== id));
    showToast("Article removed.");
  };

  const handleTranslateHeadline = async (id, headline) => {
    if (!apiKey || !headline) return;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [{ role: "user", content: `Translate this English news headline to Japanese. Return only the translation, no explanation:\n\n${headline}` }],
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const headline_jp = data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const updated = await api.setHeadlineJp(id, headline_jp);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? { ...a, headline_jp: updated.headline_jp } : a)));
    } catch (err) {
      console.warn("Headline translation failed:", err.message);
    }
  };

  const handleGetSummary = async (id) => {
    if (!apiKey) { setShowApiKeyModal(true); return; }
    const article = articles.find((a) => a.id === id);
    setLoadingId(id);
    try {
      let articleText = "";
      try { articleText = await fetchArticleText(article.url); } catch {}
      const updated = await api.getSummary(id, apiKey, articleText);
      if (updated.error) throw new Error(updated.error);
      // Merge only summary/tags — don't overwrite session_id or other fields
      // that may have been updated concurrently (e.g. auto-assign on save).
      setArticles((prev) => prev.map((a) =>
        a.id === updated.id ? { ...a, summary: updated.summary, tags: updated.tags } : a
      ));
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

  const handleAssign = async (sessionId, articleId) => {
    const updated = await api.assignArticle(sessionId, articleId);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleUnassign = async (articleId) => {
    // Find current session to unassign from
    const article = articles.find((a) => a.id === articleId);
    if (!article?.session_id) return;
    const updated = await api.unassignArticle(article.session_id, articleId);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleTagsChange = async (articleId, tags) => {
    const updated = await api.updateTags(articleId, tags);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const filtered = articles.filter((a) => {
    const matchSearch = !search || [a.headline, a.url, a.notes].some((s) => s?.toLowerCase().includes(search.toLowerCase()));
    const matchTag = !tagFilter || (a.tags || []).includes(tagFilter);
    return matchSearch && matchTag;
  });

  return (
    <>
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
      {allTags.length > 0 && (
        <div className="tag-filter-bar">
          <span className="tag-filter-label">FILTER</span>
          <button className={`tag-filter-btn ${!tagFilter ? "active" : ""}`} onClick={() => setTagFilter(null)}>All</button>
          {allTags.map((t) => (
            <button key={t} className={`tag-filter-btn ${tagFilter === t ? "active" : ""}`} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</button>
          ))}
        </div>
      )}

      <main className="articles-container">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-jp">記事なし</span>
            <p>{search ? "No articles match your search." : "Add your first article to get started."}</p>
          </div>
        ) : (
          <>
            <div className="week-label">ALL ARTICLES — {filtered.length}</div>
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
                sessionBadge={a.session_id ? sessionMap[a.session_id] : null}
                sessions={sessions}
                onAssign={handleAssign}
                onUnassign={handleUnassign}
                onTagsChange={handleTagsChange}
              />
            ))}
          </>
        )}
      </main>

      {modalArticle !== undefined && (
        <ArticleModal article={modalArticle} onClose={() => setModalArticle(undefined)} onSave={handleSave} />
      )}
      {sessionPrompt && (
        <SessionPromptModal
          fridayDate={sessionPrompt.fridayDate}
          onYes={handleSessionPromptYes}
          onNo={handleSessionPromptNo}
        />
      )}
    </>
  );
}

// ── Sessions Screen ───────────────────────────────────────────────────────────
function SessionsScreen({ sessions, setSessions, articles, setArticles, showToast, apiKey, setShowApiKeyModal }) {
  const [modalSession, setModalSession] = useState(undefined);

  const handleSave = async (data) => {
    if (modalSession?.id) {
      const updated = await api.updateSession(modalSession.id, data);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      showToast("Session updated.");
    } else {
      const created = await api.createSession(data);
      setSessions((prev) => [created, ...prev]);
      showToast("Session created.");
    }
    setModalSession(undefined);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this session? Articles will be unlinked but not deleted.")) return;
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setArticles((prev) => prev.map((a) => a.session_id === id ? { ...a, session_id: null } : a));
    showToast("Session removed.");
  };

  const handleAssign = async (sessionId, articleId) => {
    const updated = await api.assignArticle(sessionId, articleId);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleUnassign = async (sessionId, articleId) => {
    const updated = await api.unassignArticle(sessionId, articleId);
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const sorted = [...sessions].sort((a, b) => b.index - a.index);

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <span className="count-badge">{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        </div>
        <button className="btn btn-primary" onClick={() => setModalSession(null)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
          NEW SESSION
        </button>
      </div>

      <main className="articles-container">
        {sorted.length === 0 ? (
          <div className="empty-state">
            <span className="empty-jp">配信なし</span>
            <p>Create your first weekly session to get started.</p>
          </div>
        ) : (
          <>
            <div className="week-label">LIVE SESSIONS — {sorted.length}</div>
            {sorted.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                articles={articles}
                allArticles={articles}
                onEdit={(session) => setModalSession(session)}
                onDelete={handleDelete}
                onAssign={handleAssign}
                onUnassign={handleUnassign}
                apiKey={apiKey}
                setShowApiKeyModal={setShowApiKeyModal}
                showToast={showToast}
              />
            ))}
          </>
        )}
      </main>

      {modalSession !== undefined && (
        <SessionModal
          session={modalSession}
          onClose={() => setModalSession(undefined)}
          onSave={handleSave}
          defaultIndex={modalSession ? undefined : Math.max(0, ...sessions.map((s) => s.index)) + 1}
          defaultDate={modalSession ? undefined : nextFriday(sessions.reduce((latest, s) => s.date > latest ? s.date : latest, ""))}
        />
      )}
    </>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("articles");
  const [articles, setArticles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("nt_api_key") || "");
  const { toast, show: showToast } = useToast();

  useEffect(() => {
    api.getArticles().then(setArticles).catch(() => showToast("Could not connect to server.", true));
    api.getSessions().then(setSessions).catch(() => {});
  }, []); // eslint-disable-line

  const saveApiKey = (key) => {
    localStorage.setItem("nt_api_key", key);
    setApiKey(key);
    setShowApiKeyModal(false);
    showToast("API key saved.");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <span className="header-jp">ニュース追跡</span>
          <span className="header-title">NEWS TRACKER</span>
        </div>
        <nav className="header-nav">
          <button className={`nav-btn ${screen === "articles" ? "active" : ""}`} onClick={() => setScreen("articles")}>ARTICLES</button>
          <button className={`nav-btn ${screen === "sessions" ? "active" : ""}`} onClick={() => setScreen("sessions")}>LIVE SESSIONS</button>
        </nav>
        <div className="header-right">
          <button
            className={`btn btn-ghost btn-sm api-key-btn ${apiKey ? "has-key" : "no-key"}`}
            onClick={() => setShowApiKeyModal(true)}
          >
            {apiKey ? "✓ API KEY SET" : "⚠ SET API KEY"}
          </button>
        </div>
      </header>

      {screen === "articles" && (
        <ArticlesScreen
          articles={articles}
          sessions={sessions}
          setSessions={setSessions}
          setArticles={setArticles}
          apiKey={apiKey}
          setShowApiKeyModal={setShowApiKeyModal}
          showToast={showToast}
        />
      )}
      {screen === "sessions" && (
        <SessionsScreen
          sessions={sessions}
          setSessions={setSessions}
          articles={articles}
          setArticles={setArticles}
          showToast={showToast}
          apiKey={apiKey}
          setShowApiKeyModal={setShowApiKeyModal}
        />
      )}

      {showApiKeyModal && <ApiKeyModal onClose={() => setShowApiKeyModal(false)} onSave={saveApiKey} />}
      {toast && <div className={`toast ${toast.isError ? "error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
