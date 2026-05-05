const DEFAULT_SERVER = 'http://localhost:3001';

let settings = { serverUrl: DEFAULT_SERVER, apiKey: '' };
let extractedData = null;
let existingArticle = null;

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  wireUI();
  await init();
});

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  settings.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  settings.apiKey = stored.apiKey || '';
  syncSettingsDisplay();
}

function syncSettingsDisplay() {
  const isSet = !!settings.apiKey;
  document.getElementById('settings-compact').style.display = isSet ? 'block' : 'none';
  document.getElementById('settings-form').style.display = isSet ? 'none' : 'block';
  if (isSet) {
    document.getElementById('server-url-text').textContent = settings.serverUrl;
    document.getElementById('inp-api-key').value = '';
  } else {
    document.getElementById('inp-server-url').value = settings.serverUrl;
  }
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function wireUI() {
  document.getElementById('btn-settings').addEventListener('click', () => {
    const panel = document.getElementById('settings-panel');
    panel.hidden = !panel.hidden;
  });

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    settings.serverUrl = document.getElementById('inp-server-url').value.trim() || DEFAULT_SERVER;
    const newKey = document.getElementById('inp-api-key').value.trim();
    if (newKey) settings.apiKey = newKey;
    await chrome.storage.local.set({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    document.getElementById('settings-panel').hidden = true;
    syncSettingsDisplay();
    toast('Settings saved');
  });

  document.getElementById('btn-change-settings').addEventListener('click', () => {
    document.getElementById('settings-compact').style.display = 'none';
    document.getElementById('settings-form').style.display = 'block';
    document.getElementById('inp-server-url').value = settings.serverUrl;
    document.getElementById('inp-api-key').focus();
  });

  document.getElementById('btn-add').addEventListener('click', () => addArticle());
  document.getElementById('btn-override').addEventListener('click', () => overrideArticle());
  document.getElementById('btn-summary').addEventListener('click', () => generateSummary());
}

// ── Init: extract + check DB ──────────────────────────────────────────────────

async function init() {
  setView('loading');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !/^https?:\/\//.test(tab.url)) {
      return showError('This extension only works on http/https pages.');
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageData,
    });
    extractedData = result;

    document.getElementById('url-display').textContent = extractedData.url;
    document.getElementById('inp-headline').value = extractedData.headline;

    const res = await fetch(`${settings.serverUrl}/api/articles`);
    if (!res.ok) throw new Error(`Cannot reach server at ${settings.serverUrl}`);
    const articles = await res.json();
    existingArticle = articles.find(a => a.url === extractedData.url) || null;

    if (existingArticle) {
      document.getElementById('existing-headline').textContent = existingArticle.headline || '(no headline)';
      setView('main', 'exists');
    } else {
      setView('main', 'new');
    }
    syncSummaryButton();
  } catch (err) {
    const msg = err.message.includes('fetch')
      ? `Could not reach server at ${settings.serverUrl}. Make sure it's running — you may need to restart it.`
      : err.message;
    showError(msg);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function addArticle() {
  setBusy(true);
  let added = false;
  try {
    const res = await fetch(`${settings.serverUrl}/api/articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: extractedData.url }),
    });

    if (res.status === 409) {
      existingArticle = await res.json();
      document.getElementById('existing-headline').textContent = existingArticle.headline || '(no headline)';
      setView('main', 'exists');
      toast('Article was already in the database', 'error');
      return;
    }

    if (!res.ok) throw new Error(`Server error ${res.status}`);
    existingArticle = await res.json();

    // Update headline if the user edited it or server extracted something different
    const editedHeadline = document.getElementById('inp-headline').value.trim();
    if (editedHeadline && editedHeadline !== existingArticle.headline) {
      await fetch(`${settings.serverUrl}/api/articles/${existingArticle.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline: editedHeadline, url: existingArticle.url, notes: existingArticle.notes || '' }),
      });
      existingArticle.headline = editedHeadline;
    }

    document.getElementById('done-msg').textContent = 'Article added!';
    setView('main', 'done');
    syncSummaryButton();
    added = true;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }

  if (added) {
    if (settings.apiKey) {
      await generateSummary();
    } else {
      toast('Set your API key in settings to auto-generate summaries');
    }
  }
}

async function overrideArticle() {
  setBusy(true);
  let refreshed = false;
  try {
    const headline = document.getElementById('inp-headline').value.trim() || extractedData.headline;
    const res = await fetch(`${settings.serverUrl}/api/articles/${existingArticle.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline, url: existingArticle.url, notes: existingArticle.notes || '' }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    existingArticle = await res.json();
    existingArticle.summary = null;

    document.getElementById('done-msg').textContent = 'Article refreshed!';
    setView('main', 'done');
    syncSummaryButton();
    refreshed = true;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }

  if (refreshed) {
    if (settings.apiKey) {
      await generateSummary();
    } else {
      toast('Set your API key in settings to auto-generate summaries');
    }
  }
}

async function generateSummary() {
  if (!settings.apiKey) {
    toast('Add your Anthropic API key in settings first', 'error');
    document.getElementById('settings-panel').hidden = false;
    return;
  }
  if (!existingArticle) return;

  setBusy(true);
  try {
    const res = await fetch(`${settings.serverUrl}/api/articles/${existingArticle.id}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey },
      body: JSON.stringify({ articleText: extractedData.text }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    existingArticle.summary = true;
    toast('Summary generated!');
    syncSummaryButton();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function syncSummaryButton() {
  document.getElementById('btn-summary').hidden = !existingArticle || !!existingArticle.summary;
}

// ── View helpers ──────────────────────────────────────────────────────────────

function setView(view, state) {
  document.getElementById('view-loading').hidden = view !== 'loading';
  document.getElementById('view-error').hidden = view !== 'error';
  document.getElementById('view-main').hidden = view !== 'main';

  if (view === 'main') {
    document.getElementById('state-new').hidden = state !== 'new';
    document.getElementById('state-exists').hidden = state !== 'exists';
    document.getElementById('state-done').hidden = state !== 'done';
  }
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  setView('error');
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach(b => { b.disabled = busy; });
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type === 'error' ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3000);
}

// ── Page data extraction (runs in page context) ───────────────────────────────

function extractPageData() {
  function getMeta(...selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = el.getAttribute('content') || el.getAttribute('datetime') || el.textContent;
        if (val && val.trim()) return val.trim();
      }
    }
    return '';
  }

  const headline = getMeta(
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
  ) || document.title || '';

  const publishedDate = getMeta(
    'meta[property="article:published_time"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
    'time[itemprop="datePublished"]',
    'time[datetime]',
  );

  const clone = document.body.cloneNode(true);
  ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe'].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });
  const container = clone.querySelector('article')
    || clone.querySelector('[role="main"]')
    || clone.querySelector('main')
    || clone;

  const text = (container.innerText || container.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 12000);

  return { url: window.location.href, headline: headline.trim(), publishedDate, text };
}
