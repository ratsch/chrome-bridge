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

    log(`CLI → ${msg.type}: ${(msg.text || msg.selector || msg.url || "").slice(0, 60)}`);
    forwardToContentScript(msg);
  };
}

function disconnect() {
  if (ws) {
    ws.close(4000, "user disconnect");
    ws = null;
  }
  connected = false;
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
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

  // Find the right tab based on current host_permissions matches
  // Try to find a tab matching any of our content script patterns
  const tabs = await chrome.tabs.query({ currentWindow: true });

  // Get host permissions to match against
  const manifest = chrome.runtime.getManifest();
  const patterns = (manifest.host_permissions || []).map(p => {
    // Convert "https://chatgpt.com/*" to regex
    return new RegExp(p.replace(/\*/g, ".*").replace(/\//g, "\\/"));
  });

  // First, try the active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && patterns.some(p => p.test(activeTab.url))) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, msg);
      log("Message forwarded to active tab");
      return;
    } catch {
      // Content script not ready in active tab, try injection
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

  // Fallback: find any matching tab (prefer ChatGPT for send_message compatibility)
  const chatgptTab = tabs.find(t => t.url && t.url.includes("chatgpt.com"));
  const matchingTab = chatgptTab || tabs.find(t =>
    t.url && patterns.some(p => p.test(t.url))
  );

  if (!matchingTab) {
    log("No matching tab found!");
    wsSend({ type: "error", id: msg.id, error: "No matching tab open" });
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

  // Popup requesting extract from active tab
  if (msg.type === "popup_extract") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          sendResponse({ error: "No active tab" });
          return;
        }
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "extract_page",
          id: "popup-" + Date.now(),
        });
        sendResponse(response);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true; // async sendResponse
  }

  // Content script responses → forward to CLI via WebSocket
  // Forward ALL message types from content scripts (message-type agnostic)
  if (sender.tab) {
    wsSend(msg);
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

      // For extract_page, we can get a synchronous response
      if (msg.type === "extract_page") {
        // Set up a one-time listener for the response
        const responsePromise = new Promise((resolve) => {
          const id = "ext-" + Date.now();
          msg.id = id;

          const handler = (response, respSender) => {
            if (response.id === id && (response.type === "page_data" || response.type === "error")) {
              chrome.runtime.onMessage.removeListener(handler);
              resolve(response);
            }
          };
          chrome.runtime.onMessage.addListener(handler);

          // Timeout after 10 seconds
          setTimeout(() => {
            chrome.runtime.onMessage.removeListener(handler);
            resolve({ type: "error", error: "Extraction timeout" });
          }, 10000);
        });

        await chrome.tabs.sendMessage(tab.id, msg);
        const result = await responsePromise;
        sendResponse(result.data || result);
      } else {
        // For other message types, just forward
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
