/**
 * ChatGPT extractor — all ChatGPT DOM interaction logic.
 *
 * Handles ChatGPT-specific compound commands:
 *   - send_message: fill input → click send → watch response → stream deltas
 *   - fetch_api: proxy fetch through the browser session (ChatGPT auth cookies)
 *   - scrape_dom: query DOM elements by selector
 *
 * Registers with the chrome-bridge dispatcher (content.js) as the chatgpt.com extractor.
 */

// ── Configurable selectors ──────────────────────────────────────────────────

const SELECTORS = {
  input: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  turnWrapper: 'article, [data-testid^="conversation-turn"]',
  streamingIndicator: '.result-streaming',
  stopButton: 'button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  errorMessage: '[data-testid="error-message"], .text-red-500, [class*="error-text"]',
};

// ── State ───────────────────────────────────────────────────────────────────

let currentRequestId = null;
let lastSentText = "";
let lastStreamedText = "";
let streamCheckInterval = null;
let idle = true;

// ── Communication helper ────────────────────────────────────────────────────
// safeSend is provided by the dispatcher (content.js) via the registry.

function safeSend(msg) {
  const bridge = window.__chromeBridge;
  if (bridge && bridge.safeSend) {
    return bridge.safeSend(msg);
  }
  // Fallback: direct chrome.runtime.sendMessage
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
    return true;
  } catch (err) {
    console.warn("[chrome-bridge:chatgpt] Send failed:", err.message);
    stopWatching();
    idle = true; // reset so future send_message calls aren't blocked
    return false;
  }
}

// ── Core: send a message and watch for response ────────────────────────────

async function handleSendMessage(msg) {
  const { id, text, files } = msg;

  if (!idle) {
    safeSend({
      type: "error", id,
      error: "ChatGPT is still generating a response. Wait or stop it first."
    });
    return;
  }

  currentRequestId = id;
  lastSentText = text;
  lastStreamedText = "";
  idle = false;

  // Record IDs of all existing assistant messages so we can detect the new one
  const knownIds = new Set();
  document.querySelectorAll(SELECTORS.assistantMessage).forEach((el) => {
    const mid = el.getAttribute("data-message-id");
    if (mid) knownIds.add(mid);
  });

  try {
    const inputEl = await waitForElement(SELECTORS.input, 3000);
    if (!inputEl) throw new Error(`Input not found: ${SELECTORS.input}`);

    // Upload file attachments if present
    if (files && files.length > 0) {
      await uploadFiles(files, inputEl);
    }

    await fillInput(inputEl, text);
    console.log(`[chrome-bridge:chatgpt] Input filled (${text.length} chars), waiting for send button...`);

    // Wait for send button to appear (large file uploads can take minutes)
    let sendBtn = null;
    for (let attempt = 0; attempt < 360; attempt++) {
      await sleep(1000);
      // Dismiss any modals that might block interaction
      if (attempt % 10 === 5) await dismissModals();
      sendBtn = document.querySelector(SELECTORS.sendButton);
      if (sendBtn && !sendBtn.disabled) break;
      sendBtn = null;
      if (attempt % 30 === 0 && attempt > 0) {
        console.log(`[chrome-bridge:chatgpt] Still waiting for send button... (${attempt}s)`);
      }
    }
    if (!sendBtn) throw new Error(`Send button not found or disabled after 6min: ${SELECTORS.sendButton}`);
    sendBtn.click();

    console.log("[chrome-bridge:chatgpt] Message sent, watching for response...");
    safeSend({ type: "stream_start", id });

    watchForResponse(id, knownIds);

  } catch (err) {
    console.error("[chrome-bridge:chatgpt] Send failed:", err);
    safeSend({ type: "error", id, error: err.message });
    idle = true;
  }
}

// ── File upload ────────────────────────────────────────────────────────────

async function uploadFiles(files, inputEl) {
  console.log(`[chrome-bridge:chatgpt] Uploading ${files.length} file(s)...`);

  // Convert base64 to File objects
  const fileObjects = files.map((f) => {
    const binary = atob(f.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], f.name, { type: f.type });
    console.log(`[chrome-bridge:chatgpt] Created File: ${f.name} (${bytes.length} bytes, ${f.type})`);
    return file;
  });

  // Find all file inputs and log them
  const allFileInputs = document.querySelectorAll('input[type="file"]');
  console.log(`[chrome-bridge:chatgpt] Found ${allFileInputs.length} file input(s) on page`);
  allFileInputs.forEach((inp, i) => {
    console.log(`[chrome-bridge:chatgpt]   input[${i}]: accept="${inp.accept}" multiple=${inp.multiple} id="${inp.id}" class="${inp.className}"`);
  });

  // Strategy 1: Find hidden file input and set its files via DataTransfer
  for (const fileInput of allFileInputs) {
    console.log(`[chrome-bridge:chatgpt] Trying file input: accept="${fileInput.accept}"`);
    const dt = new DataTransfer();
    for (const f of fileObjects) dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(500);
  }

  if (allFileInputs.length > 0) {
    const attached = await waitForAttachmentProcessed();
    if (attached) return;
    console.log("[chrome-bridge:chatgpt] File input approach did not show attachment, trying drop...");
  }

  // Strategy 2: Simulate drop event on multiple targets
  const dropTargets = [
    inputEl,
    inputEl.closest("form"),
    inputEl.parentElement,
    document.querySelector("main"),
    document.body,
  ].filter(Boolean);

  for (const target of dropTargets) {
    console.log(`[chrome-bridge:chatgpt] Trying drop on: ${target.tagName}.${target.className?.split?.(' ')?.[0] || ''}`);
    const dt = new DataTransfer();
    for (const f of fileObjects) dt.items.add(f);

    target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
    await sleep(100);
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    await sleep(500);
  }

  // Strategy 3: Simulate paste event with file
  console.log("[chrome-bridge:chatgpt] Trying clipboard paste...");
  const pasteData = new DataTransfer();
  for (const f of fileObjects) pasteData.items.add(f);
  inputEl.dispatchEvent(new ClipboardEvent("paste", {
    clipboardData: pasteData,
    bubbles: true,
  }));

  await waitForAttachmentProcessed();
}

async function dismissModals() {
  const MODAL_DISMISS_SELECTORS = [
    'button[data-testid="modal-close"]',
    'button[aria-label="Close"]',
    'button[aria-label="Schließen"]',
    '[role="dialog"] button:last-of-type',
    '[role="dialog"] button:first-of-type',
    '[data-state="open"] button',
    '.modal button',
    'dialog button',
  ];

  for (let attempt = 0; attempt < 5; attempt++) {
    let dismissed = false;
    for (const sel of MODAL_DISMISS_SELECTORS) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          const text = (btn.textContent || "").trim().toLowerCase();
          if (text.match(/^(ok|close|dismiss|upload|got it|schließen|abbrechen|weiter)$/i) ||
              btn.getAttribute("aria-label")?.match(/close|schließen/i)) {
            console.log(`[chrome-bridge:chatgpt] Dismissing modal: "${text}" via ${sel}`);
            btn.click();
            dismissed = true;
            await sleep(500);
            break;
          }
        }
      } catch {}
      if (dismissed) break;
    }
    if (!dismissed) break;
    await sleep(300);
  }
}

async function waitForAttachmentProcessed(timeoutMs = 120000) {
  await sleep(2000);
  await dismissModals();

  const startedAt = Date.now();
  const ATTACHMENT_SELECTORS = [
    '[data-testid*="attachment"]',
    '[data-testid*="file"]',
    '[data-testid*="upload"]',
    '.file-thumbnail',
    '[class*="attachment"]',
    '[class*="file-item"]',
    '[class*="upload"]',
    'button[aria-label*="Remove"]',
    'img[alt*="Uploaded"]',
    '[class*="FilePreview"]',
    '[class*="file_preview"]',
    '[class*="filePreview"]',
  ];

  while (Date.now() - startedAt < timeoutMs) {
    for (const sel of ATTACHMENT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          console.log(`[chrome-bridge:chatgpt] Attachment detected via: ${sel}`);
          await sleep(1500);
          return true;
        }
      } catch {}
    }
    await sleep(500);
  }

  console.warn("[chrome-bridge:chatgpt] No attachment indicator found after timeout");
  return false;
}

// ── Input filling ───────────────────────────────────────────────────────────

async function fillInput(el, text) {
  el.focus();
  await sleep(100);

  if (el.tagName === "TEXTAREA") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value"
    ).set;
    nativeSetter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));

  } else if (el.isContentEditable) {
    el.textContent = "";
    el.focus();
    await sleep(50);

    const USE_CLIPBOARD_THRESHOLD = 2000;

    if (text.length > USE_CLIPBOARD_THRESHOLD && navigator.clipboard) {
      console.log(`[chrome-bridge:chatgpt] Using clipboard paste for long text (${text.length} chars)`);
      try {
        await navigator.clipboard.writeText(text);
        document.execCommand("paste");
        await sleep(200);
        if (!el.textContent.includes(text.slice(0, 50))) {
          console.log("[chrome-bridge:chatgpt] Clipboard paste didn't take, trying execCommand...");
          el.textContent = "";
          el.focus();
          await sleep(50);
          document.execCommand("insertText", false, text);
        }
      } catch (clipErr) {
        console.log(`[chrome-bridge:chatgpt] Clipboard failed: ${clipErr.message}, falling back to execCommand`);
        document.execCommand("insertText", false, text);
      }
    } else {
      document.execCommand("insertText", false, text);
    }

    // Final fallback
    if (!el.textContent.includes(text.slice(0, 20))) {
      console.log("[chrome-bridge:chatgpt] Direct text insertion as final fallback");
      el.innerHTML = `<p>${text.replace(/\n/g, '</p><p>')}</p>`;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

  } else {
    throw new Error(`Unknown input type: ${el.tagName}, contentEditable=${el.isContentEditable}`);
  }
}

// ── Response watching ───────────────────────────────────────────────────────

function watchForResponse(requestId, knownIds) {
  stopWatching();

  const startedAt = Date.now();
  const TIMEOUT = 60 * 60 * 1000;
  const SETTLE_TIME = 3000;
  let lastChangeAt = Date.now();
  let observingEl = null;
  let done = false;

  function finish(text) {
    if (done) return;
    done = true;
    stopWatching();
    idle = true;
    console.log("[chrome-bridge:chatgpt] Stream complete, length:", text.length);
    safeSend({ type: "stream_done", id: requestId, text });
  }

  function fail(error) {
    if (done) return;
    done = true;
    stopWatching();
    idle = true;
    safeSend({ type: "error", id: requestId, error });
  }

  streamCheckInterval = setInterval(() => {
    const now = Date.now();

    // Phase 1: Find the new assistant message
    if (!observingEl) {
      const assistantMsgs = document.querySelectorAll(SELECTORS.assistantMessage);
      for (let i = assistantMsgs.length - 1; i >= 0; i--) {
        const el = assistantMsgs[i];
        const mid = el.getAttribute("data-message-id") || "";
        if (mid.includes("placeholder")) continue;
        if (knownIds.has(mid)) continue;
        observingEl = el;
        console.log("[chrome-bridge:chatgpt] Found new assistant message:", mid);
        lastChangeAt = now;
        break;
      }

      if (!observingEl) {
        const errorEl = document.querySelector(SELECTORS.errorMessage);
        if (errorEl) {
          fail(`ChatGPT error: ${errorEl.innerText?.trim() || "Unknown error"}`);
          return;
        }
        if (now - startedAt > 50 * 60 * 1000) {
          fail("Timed out waiting for assistant response to appear (50min)");
        }
        return;
      }
    }

    // Phase 2: Stream text from the found element
    emitDelta(observingEl, requestId);
    if (lastStreamedText !== emitDelta._prevText) {
      lastChangeAt = now;
      emitDelta._prevText = lastStreamedText;
    }

    const errorEl = document.querySelector(SELECTORS.errorMessage);
    if (errorEl) {
      fail(`ChatGPT error: ${errorEl.innerText?.trim() || "Unknown error"}`);
      return;
    }

    const isStreaming = document.querySelector(SELECTORS.streamingIndicator);
    const stopBtn = document.querySelector(SELECTORS.stopButton);
    const textSettled = (now - lastChangeAt) > SETTLE_TIME;

    if (!isStreaming && !stopBtn && textSettled) {
      if (lastStreamedText.length === 0) {
        const finalText = extractTextFinal(observingEl);
        if (finalText) lastStreamedText = finalText;
      }
      if (lastStreamedText.length > 0) {
        finish(lastStreamedText);
      }
    }

    if (now - startedAt > TIMEOUT) {
      if (lastStreamedText.length === 0) {
        lastStreamedText = extractTextFinal(observingEl) || "";
      }
      if (lastStreamedText.length > 0) {
        finish(lastStreamedText);
      } else {
        fail("Response timeout — no text received");
      }
    }
  }, 1000);
}

function emitDelta(el, requestId) {
  const currentText = extractText(el);
  if (currentText !== lastStreamedText) {
    const delta = currentText.slice(lastStreamedText.length);
    if (delta) {
      const sent = safeSend({ type: "stream_delta", id: requestId, text: delta });
      console.log(`[chrome-bridge:chatgpt] delta sent=${sent}: "${delta.slice(0,60)}"`);
    }
    lastStreamedText = currentText;
  }
}

function stopWatching() {
  if (streamCheckInterval) {
    clearInterval(streamCheckInterval);
    streamCheckInterval = null;
  }
}

// ── Text extraction helpers ─────────────────────────────────────────────────

function extractText(el) {
  const prose = el.querySelector(".markdown, .prose");
  if (prose) {
    const text = (prose.innerText || prose.textContent || "").trim();
    if (text) return text;
  }
  const direct = (el.innerText || el.textContent || "").trim();
  if (direct) return direct;
  return "";
}

function extractTextFinal(el) {
  const text = extractText(el);
  if (text) return text;

  try {
    const sel = window.getSelection();
    sel.selectAllChildren(el);
    const result = sel.toString().trim();
    sel.removeAllRanges();
    return result;
  } catch {}
  return "";
}

// ── DOM scraping ────────────────────────────────────────────────────────────

function handleScrapeDom(msg) {
  const { id, selector, attribute } = msg;
  try {
    let result;
    if (selector === "__project_links__") {
      const links = document.querySelectorAll('a[href*="/g/g-p-"]');
      result = [...links].map(a => ({
        href: a.getAttribute("href"),
        text: a.textContent.trim(),
      }));
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const href = el.getAttribute && el.getAttribute("href");
        const dataId = el.getAttribute && (el.getAttribute("data-id") || el.getAttribute("data-gizmo-id") || el.getAttribute("data-testid") || "");
        if ((href && href.includes("g-p-")) || dataId.includes("g-p-")) {
          result.push({ href: href || dataId, text: el.textContent.trim().split("\n")[0] });
        }
      }
    } else if (selector === "__page_html_gp__") {
      const entries = performance.getEntriesByType("resource");
      const gpEntries = entries.filter(e => e.name.includes("g-p-") || e.name.includes("gizmo") || e.name.includes("project"));
      result = gpEntries.map(e => ({ url: e.name }));
      const html = document.documentElement.outerHTML;
      const matches = html.match(/g-p-[a-f0-9]{32}[a-z0-9-]*/g) || [];
      for (const m of [...new Set(matches)]) {
        result.push({ id: m });
      }
    } else {
      const els = document.querySelectorAll(selector);
      result = [...els].map(el => ({
        text: el.textContent.trim(),
        href: el.getAttribute("href"),
        [attribute || "value"]: attribute ? el.getAttribute(attribute) : null,
      }));
    }
    safeSend({ type: "scrape_response", id, data: result });
  } catch (err) {
    safeSend({ type: "scrape_response", id, error: err.message });
  }
}

// ── Fetch API (call ChatGPT internal endpoints via browser session) ─────────

let _cachedAuth = null;
let _cachedAuthAt = 0;
const AUTH_CACHE_TTL = 30 * 1000;

async function getAuthHeaders() {
  if (_cachedAuth && (Date.now() - _cachedAuthAt) < AUTH_CACHE_TTL) return _cachedAuth;
  try {
    const resp = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
    const session = await resp.json();
    const headers = {};
    if (session.accessToken) headers["Authorization"] = `Bearer ${session.accessToken}`;
    const structure = session.account?.structure;
    if (structure === "workspace") {
      const accountId = session.account?.id || session.account?.account_id;
      if (accountId) headers["openai-account-id"] = accountId;
    }
    _cachedAuth = headers;
    _cachedAuthAt = Date.now();
    return headers;
  } catch (err) {
    console.warn("[chrome-bridge:chatgpt] Failed to get auth headers:", err.message);
    return {};
  }
}

async function handleFetchApi(msg) {
  const { id, url, method, body, binary, noAuth } = msg;
  try {
    const opts = { method: method || "GET", credentials: "include" };
    const authHeaders = await getAuthHeaders();
    opts.headers = { ...authHeaders };
    if (url.includes("/gizmos/")) {
      delete opts.headers["openai-account-id"];
    }
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const contentType = resp.headers.get("content-type") || "";

    let data;
    if (binary) {
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const CHUNK = 8192;
      const chunks = [];
      for (let i = 0; i < bytes.length; i += CHUNK) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
      }
      data = btoa(chunks.join(""));
      safeSend({
        type: "fetch_response", id,
        status: resp.status,
        data,
        contentType,
        binary: true,
      });
    } else if (contentType.includes("application/json")) {
      data = await resp.json();
      safeSend({ type: "fetch_response", id, status: resp.status, data });
    } else {
      data = await resp.text();
      safeSend({ type: "fetch_response", id, status: resp.status, data });
    }
  } catch (err) {
    safeSend({
      type: "fetch_response", id,
      status: 0,
      error: err.message,
    });
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Register with dispatcher ────────────────────────────────────────────────

(function register() {
  const bridge = window.__chromeBridge = window.__chromeBridge || {};
  bridge.extractors = bridge.extractors || {};

  bridge.extractors["chatgpt.com"] = {
    name: "chatgpt",
    extract() {
      // Extract last assistant message as page data
      const msgs = document.querySelectorAll(SELECTORS.assistantMessage);
      if (msgs.length === 0) return { type: "chat", source: "chatgpt.com", data: null };
      const last = msgs[msgs.length - 1];
      return {
        type: "chat",
        source: "chatgpt.com",
        url: window.location.href,
        data: { text: extractText(last) },
      };
    },
    handlers: {
      send_message: handleSendMessage,
      fetch_api: handleFetchApi,
      scrape_dom: handleScrapeDom,
    },
  };

  console.log("[chrome-bridge:chatgpt] Extractor registered");
})();

// ── Debug ───────────────────────────────────────────────────────────────────

window.__chatgptBridge = {
  get state() {
    return { idle, currentRequestId, lastStreamedText: lastStreamedText.slice(0, 200) };
  },
  test(text) {
    handleSendMessage({ id: "test-" + Date.now(), text });
  },
  selectors() {
    for (const [name, sel] of Object.entries(SELECTORS)) {
      const el = document.querySelector(sel);
      console.log(`${name}: ${sel} → ${el ? "FOUND" : "NOT FOUND"}`, el);
    }
  },
};

// ── Exports for testing ─────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractText, extractTextFinal, SELECTORS };
}
