/**
 * Content script — generic dispatcher for chrome-bridge.
 *
 * Injected into matched pages. Routes incoming messages:
 *   1. If the site's extractor has a handler for the message type → delegate
 *   2. Otherwise → handle core generic commands (inject_text, click, etc.)
 *
 * Extractors register via window.__chromeBridge.extractors[hostname].
 */

// ── Bridge registry ─────────────────────────────────────────────────────────

window.__chromeBridge = window.__chromeBridge || {};
window.__chromeBridge.extractors = window.__chromeBridge.extractors || {};

// ── Communication with background ───────────────────────────────────────────

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* service worker not available */ }
    });
    return true;
  } catch (err) {
    console.warn("[chrome-bridge] Send failed:", err.message);
    return false;
  }
}

// Expose safeSend so extractors can use it
window.__chromeBridge.safeSend = safeSend;

// ── Extractor lookup ────────────────────────────────────────────────────────

function getExtractor() {
  const hostname = window.location.hostname.replace(/^www\./, "");
  const extractors = window.__chromeBridge.extractors;

  // Direct hostname match
  if (extractors[hostname]) return extractors[hostname];

  // Try with www prefix
  if (extractors["www." + hostname]) return extractors["www." + hostname];

  // Subdomain match (e.g., "homegate.ch" matches "www.homegate.ch")
  for (const key of Object.keys(extractors)) {
    if (hostname.endsWith(key) || key.endsWith(hostname)) {
      return extractors[key];
    }
  }

  return null;
}

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const extractor = getExtractor();

  // Check if extractor has a handler for this message type
  if (extractor && extractor.handlers && extractor.handlers[msg.type]) {
    extractor.handlers[msg.type](msg);
    sendResponse({ ok: true });
    return;
  }

  // Core generic commands
  switch (msg.type) {
    case "extract_page":
      handleExtractPage(msg, extractor);
      sendResponse({ ok: true });
      break;

    case "inject_text":
      handleInjectText(msg);
      sendResponse({ ok: true });
      break;

    case "click":
      handleClick(msg);
      sendResponse({ ok: true });
      break;

    case "read_element":
      handleReadElement(msg);
      sendResponse({ ok: true });
      break;

    case "watch_element":
      handleWatchElement(msg);
      sendResponse({ ok: true });
      break;

    case "get_page_info":
      handleGetPageInfo(msg, extractor);
      sendResponse({ ok: true });
      break;

    case "upload_file":
      handleUploadFile(msg);
      sendResponse({ ok: true });
      break;

    default:
      safeSend({ type: "error", id: msg.id, error: `Unknown message type: ${msg.type}` });
      sendResponse({ ok: false, error: "unknown type" });
  }
});

// ── Core command handlers ───────────────────────────────────────────────────

function handleExtractPage(msg, extractor) {
  const { id } = msg;
  try {
    let data;
    if (extractor && extractor.extract) {
      data = extractor.extract(document);
    } else {
      // Generic fallback: JSON-LD → OpenGraph → page text
      data = genericExtract();
    }
    safeSend({ type: "page_data", id, data });
  } catch (err) {
    safeSend({ type: "error", id, error: err.message });
  }
}

function handleInjectText(msg) {
  const { id, selector, text } = msg;
  try {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value"
      ).set;
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } else {
      throw new Error(`Element is not editable: ${selector}`);
    }
    safeSend({ type: "status", id, ok: true });
  } catch (err) {
    safeSend({ type: "error", id, error: err.message });
  }
}

function handleClick(msg) {
  const { id, selector } = msg;
  try {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.click();
    safeSend({ type: "status", id, ok: true });
  } catch (err) {
    safeSend({ type: "error", id, error: err.message });
  }
}

function handleReadElement(msg) {
  const { id, selector } = msg;
  try {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    const text = (el.innerText || el.textContent || "").trim();
    safeSend({ type: "page_data", id, data: { text } });
  } catch (err) {
    safeSend({ type: "error", id, error: err.message });
  }
}

let watchInterval = null;

function handleWatchElement(msg) {
  const { id, selector, interval } = msg;
  if (watchInterval) clearInterval(watchInterval);

  let lastText = "";
  const pollMs = interval || 1000;

  watchInterval = setInterval(() => {
    const el = document.querySelector(selector);
    if (!el) return;

    const currentText = (el.innerText || el.textContent || "").trim();
    if (currentText !== lastText) {
      const delta = currentText.slice(lastText.length);
      if (delta) {
        safeSend({ type: "stream_delta", id, text: delta });
      }
      lastText = currentText;
    }
  }, pollMs);
}

function handleGetPageInfo(msg, extractor) {
  const { id } = msg;
  safeSend({
    type: "page_data",
    id,
    data: {
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      extractor: extractor ? extractor.name : null,
    },
  });
}

function handleUploadFile(msg) {
  const { id, selector, name, type, data } = msg;
  try {
    const fileInput = selector
      ? document.querySelector(selector)
      : document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("No file input found");

    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], name, { type: type || "application/octet-stream" });

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    safeSend({ type: "status", id, ok: true });
  } catch (err) {
    safeSend({ type: "error", id, error: err.message });
  }
}

// ── Generic fallback extractor ──────────────────────────────────────────────

function genericExtract() {
  const result = {
    type: "page",
    source: window.location.hostname,
    url: window.location.href,
    title: document.title,
    data: {},
    meta: {},
    json_ld: [],
    raw_text: "",
  };

  // JSON-LD
  try {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        result.json_ld.push(JSON.parse(script.textContent));
      } catch {}
    }
  } catch {}

  // OpenGraph / meta tags
  try {
    const metaTags = document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]');
    for (const tag of metaTags) {
      const prop = (tag.getAttribute("property") || tag.getAttribute("name") || "").replace("og:", "");
      result.meta[prop] = tag.getAttribute("content");
    }
    // Also grab description
    const desc = document.querySelector('meta[name="description"]');
    if (desc) result.meta.description = desc.getAttribute("content");
  } catch {}

  // Page text (truncated)
  try {
    const body = document.body.innerText || document.body.textContent || "";
    result.raw_text = body.trim().slice(0, 10000);
  } catch {}

  // Photos
  try {
    const images = document.querySelectorAll('img[src]');
    result.photos = [...images]
      .map(img => img.src)
      .filter(src => src.startsWith("http") && !src.includes("data:"))
      .slice(0, 50);
  } catch {}

  return result;
}

// ── Report ready ────────────────────────────────────────────────────────────

setTimeout(() => {
  safeSend({ type: "status", ready: true });
  const extractor = getExtractor();
  console.log(`[chrome-bridge] Content script ready (extractor: ${extractor ? extractor.name : "generic"})`);
}, 500);

// ── Exports for testing ─────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = { genericExtract, getExtractor: () => getExtractor };
}
