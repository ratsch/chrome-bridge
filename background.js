/**
 * Background service worker — generic message router for chrome-bridge.
 *
 * Responsibilities:
 *   1. Connect as WebSocket client to CLI's server on localhost:9223
 *   2. Route messages between WebSocket/external callers and content scripts
 *   3. Handle externally_connectable messages from web apps
 *
 * Message-type agnostic: forwards any message to the content script without
 * interpreting it. The content script (and its extractor) decides what to do.
 */

let ws = null;
let connected = false;
let logLines = [];
const MAX_LOG = 40;
const DEFAULT_URL = "ws://localhost:9223";
const RECONNECT_DELAY = 1000;

// Track which message IDs originated from WebSocket, so we only
// forward their responses back to WebSocket (not popup/external responses).
const wsRequestIds = new Set();
const WS_ID_MAX = 500;

// Precompile host_permissions → regex once (not per message).
const HOST_PATTERNS = (() => {
  try {
    const manifest = chrome.runtime.getManifest();
    return (manifest.host_permissions || []).map(p =>
      new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, ".*") + "$")
    );
  } catch {
    return [];
  }
})();

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logLines.push(line);
  if (logLines.length > MAX_LOG) logLines.shift();
  console.log("[chrome-bridge]", msg);
}

// ── WebSocket to CLI ────────────────────────────────────────────────────────

function connect(url, token) {
  disconnect();

  const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    log(`Connection error: ${err.message}`);
    return;
  }

  ws.onopen = () => {
    connected = true;
    log("Connected to CLI");
    startKeepAlive();
    wsSend({ type: "hello", client: "chatgpt-bridge" });
  };

  ws.onclose = (ev) => {
    connected = false;
    stopKeepAlive();
    ws = null;
    wsRequestIds.clear(); // prevent stale IDs from leaking to new connections
    if (ev.code !== 4000) {
      setTimeout(() => {
        chrome.storage.local.get(["relayUrl", "authToken"], (data) => {
          const url = data.relayUrl || DEFAULT_URL;
          connect(url, data.authToken || "");
        });
      }, RECONNECT_DELAY);
    }
  };

  ws.onerror = () => {};

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    // Track this request ID so we route the response back to WebSocket
    if (msg.id) {
      wsRequestIds.add(msg.id);
      if (wsRequestIds.size > WS_ID_MAX) {
        const first = wsRequestIds.values().next().value;
        wsRequestIds.delete(first);
      }
    }

    log(`CLI → ${msg.type}: ${(msg.text || msg.selector || msg.url || "").slice(0, 60)}`);

    // Handle navigate in background (tab API, not content script)
    if (msg.type === "navigate") {
      handleNavigate(msg);
      return;
    }

    forwardToContentScript(msg);
  };
}

function disconnect() {
  if (ws) {
    ws.close(4000, "user disconnect");
    ws = null;
  }
  connected = false;
  wsRequestIds.clear(); // prevent stale IDs from leaking to new connections
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Forward to content script ───────────────────────────────────────────────

// ── Navigate ────────────────────────────────────────────────────────────────

async function handleNavigate(msg) {
  const { url } = msg;
  try {
    let targetTabId;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await chrome.tabs.update(activeTab.id, { url });
      targetTabId = activeTab.id;
    } else {
      const newTab = await chrome.tabs.create({ url });
      targetTabId = newTab.id;
    }
    log(`Navigated to ${url}`);

    // Wait for page load, then notify CLI (once only)
    let sent = false;
    const notify = () => {
      if (sent) return;
      sent = true;
      chrome.tabs.onUpdated.removeListener(listener);
      wsSend({ type: "navigated", url });
    };

    const listener = (tabId, info) => {
      if (tabId === targetTabId && info.status === "complete") {
        notify();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // If the tab already reached "complete" before the listener was attached
    // (possible on fast-loading / cached pages), notify immediately.
    try {
      const currentTab = await chrome.tabs.get(targetTabId);
      if (currentTab.status === "complete" && currentTab.url === url) {
        notify();
      }
    } catch {}

    // Timeout: send navigated even if onUpdated doesn't fire
    setTimeout(notify, 15000);
  } catch (err) {
    log(`Navigate failed: ${err.message}`);
    wsSend({ type: "error", error: `Navigation failed: ${err.message}` });
  }
}

// ── Forward to content script ───────────────────────────────────────────────

async function forwardToContentScript(msg, tabId) {
  // If a specific tab was provided, use it
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      return;
    } catch (err) {
      log(`Failed to send to tab ${tabId}: ${err.message}`);
      return;
    }
  }

  // For WebSocket messages: prefer ChatGPT tab, then active tab, then any matching tab.
  // This ensures CLI send_message always reaches ChatGPT, even if a property site is active.
  //
  // For non-WebSocket messages (popup, external): use active tab.
  const isFromWs = msg.id && wsRequestIds.has(msg.id);

  if (isFromWs) {
    await forwardWsMessage(msg);
  } else {
    await forwardToActiveTab(msg);
  }
}

async function forwardWsMessage(msg) {
  const tabs = await chrome.tabs.query({ currentWindow: true });

  // First choice: ChatGPT tab (most CLI messages target ChatGPT)
  const chatgptTab = tabs.find(t => t.url && t.url.includes("chatgpt.com"));
  if (chatgptTab) {
    try {
      await chrome.tabs.sendMessage(chatgptTab.id, msg);
      log("Message forwarded to ChatGPT tab");
      return;
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: chatgptTab.id },
          files: ["content.js"],
        });
        await new Promise((r) => setTimeout(r, 1500));
        await chrome.tabs.sendMessage(chatgptTab.id, msg);
        log("Message forwarded to ChatGPT tab after injection");
        return;
      } catch {}
    }
  }

  // Second choice: active tab if it matches a host_permission
  await forwardToActiveTab(msg);
}

async function forwardToActiveTab(msg) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && HOST_PATTERNS.some(p => p.test(activeTab.url))) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, msg);
      log("Message forwarded to active tab");
      return;
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ["content.js"],
        });
        await new Promise((r) => setTimeout(r, 1500));
        await chrome.tabs.sendMessage(activeTab.id, msg);
        log("Message forwarded to active tab after injection");
        return;
      } catch {}
    }
  }

  // Last resort: any matching tab
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const matchingTab = tabs.find(t =>
    t.url && HOST_PATTERNS.some(p => p.test(t.url))
  );

  if (!matchingTab) {
    log("No matching tab found!");
    wsSend({ type: "error", id: msg.id, error: "No matching tab open" });
    if (msg.id) wsRequestIds.delete(msg.id);
    return;
  }

  try {
    await chrome.tabs.sendMessage(matchingTab.id, msg);
    log("Message forwarded to content script");
  } catch (err) {
    log(`Content script not ready, injecting...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: matchingTab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 1500));
      await chrome.tabs.sendMessage(matchingTab.id, msg);
      log("Message forwarded after injection");
    } catch (err2) {
      log(`Failed: ${err2.message}`);
      wsSend({ type: "error", id: msg.id, error: err2.message });
      if (msg.id) wsRequestIds.delete(msg.id);
    }
  }
}

// ── Internal message handler (content script + popup) ───────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Popup messages
  if (msg.type === "connect") {
    connect(msg.url, msg.token);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "disconnect") {
    disconnect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "get_status") {
    sendResponse({ connected, log: logLines.join("\n") });
    return;
  }

  // Content script responses → forward to CLI via WebSocket ONLY if this
  // response originated from a WebSocket request (not popup or external).
  if (sender.tab) {
    if (msg.id && wsRequestIds.has(msg.id)) {
      wsRequestIds.delete(msg.id);
      wsSend(msg);
    }
    // For streaming responses (stream_start, stream_delta, stream_done),
    // the id stays the same across multiple messages — keep it in the set
    // until stream_done or error.
    if (msg.id && (msg.type === "stream_start" || msg.type === "stream_delta")) {
      wsRequestIds.add(msg.id);
    }
    sendResponse({ ok: true });
    return;
  }
});

// ── External message handler (web apps via externally_connectable) ───────────

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  log(`External → ${msg.type} from ${sender.origin || sender.url || "unknown"}`);

  // Forward to the active tab's content script and return the response
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendResponse({ type: "error", error: "No active tab" });
        return;
      }

      // For extract_page, collect the async response
      if (msg.type === "extract_page") {
        const id = "ext-" + Date.now();
        msg.id = id;

        const responsePromise = new Promise((resolve) => {
          const handler = (response) => {
            if (response.id === id && (response.type === "page_data" || response.type === "error")) {
              chrome.runtime.onMessage.removeListener(handler);
              resolve(response);
            }
          };
          chrome.runtime.onMessage.addListener(handler);
          setTimeout(() => {
            chrome.runtime.onMessage.removeListener(handler);
            resolve({ type: "error", error: "Extraction timeout" });
          }, 10000);
        });

        await chrome.tabs.sendMessage(tab.id, msg);
        const result = await responsePromise;
        sendResponse(result.data || result);
      } else {
        await chrome.tabs.sendMessage(tab.id, msg);
        sendResponse({ ok: true });
      }
    } catch (err) {
      sendResponse({ type: "error", error: err.message });
    }
  })();

  return true; // async sendResponse
});

// ── Keep service worker alive while WS is connected ─────────────────────────

let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    if (connected) chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
}
function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ── Auto-connect on startup ─────────────────────────────────────────────────

chrome.storage.local.get(["relayUrl", "authToken"], (data) => {
  const url = data.relayUrl || DEFAULT_URL;
  connect(url, data.authToken || "");
});
