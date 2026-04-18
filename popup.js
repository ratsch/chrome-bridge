/**
 * Popup UI — shows extracted page data and connection status.
 */

const pageUrl = document.getElementById("page-url");
const pageExtractor = document.getElementById("page-extractor");
const dataSection = document.getElementById("data-section");
const emptySection = document.getElementById("empty-section");
const dataView = document.getElementById("data-view");
const copyBtn = document.getElementById("copy-btn");
const extractBtn = document.getElementById("extract-btn");
const extractBtnEmpty = document.getElementById("extract-btn-empty");
const wsStatus = document.getElementById("ws-status");
const logEl = document.getElementById("log");

let lastExtracted = null;
let pendingExtractId = null;
let pendingExtractTimer = null;

// ── Page info ───────────────────────────────────────────────────────────────

async function updatePageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      pageUrl.textContent = url.hostname + url.pathname.slice(0, 60);
    } else {
      pageUrl.textContent = "—";
    }
  } catch {
    pageUrl.textContent = "—";
  }
}

// ── Extract ─────────────────────────────────────────────────────────────────

async function doExtract() {
  pageExtractor.textContent = "Extracting...";
  dataSection.classList.add("hidden");
  emptySection.classList.add("hidden");

  // Clear any previous pending extract
  if (pendingExtractTimer) clearTimeout(pendingExtractTimer);

  const id = "popup-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  pendingExtractId = id;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showEmpty();
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: "extract_page", id });

    // Timeout if no page_data arrives
    pendingExtractTimer = setTimeout(() => {
      if (pendingExtractId === id) {
        pendingExtractId = null;
        pageExtractor.textContent = "Extract timed out";
        showEmpty();
      }
    }, 10_000);
  } catch (err) {
    pendingExtractId = null;
    pageExtractor.textContent = "No content script on this page";
    showEmpty();
  }
}

// Listen for page_data responses from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "page_data" && msg.id === pendingExtractId) {
    if (pendingExtractTimer) clearTimeout(pendingExtractTimer);
    pendingExtractId = null;
    lastExtracted = msg.data;
    showData(msg.data);
  } else if (msg.type === "error" && msg.id === pendingExtractId) {
    if (pendingExtractTimer) clearTimeout(pendingExtractTimer);
    pendingExtractId = null;
    pageExtractor.textContent = `Error: ${msg.error}`;
    showEmpty();
  }
});

function showData(data) {
  if (!data || (typeof data === "object" && Object.keys(data).length === 0)) {
    showEmpty();
    return;
  }

  const extractor = data.source || data.extractor || "generic";
  const type = data.type || "page";
  pageExtractor.textContent = `${type} · ${extractor}`;

  // Show a clean view of the data (hide raw_text for readability)
  const display = { ...data };
  if (display.raw_text && display.raw_text.length > 200) {
    display.raw_text = display.raw_text.slice(0, 200) + "...";
  }
  dataView.textContent = JSON.stringify(display, null, 2);

  dataSection.classList.remove("hidden");
  emptySection.classList.add("hidden");
}

function showEmpty() {
  dataSection.classList.add("hidden");
  emptySection.classList.remove("hidden");
}

// ── Copy JSON ───────────────────────────────────────────────────────────────

copyBtn.addEventListener("click", async () => {
  if (!lastExtracted) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastExtracted, null, 2));
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy JSON";
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch (err) {
    copyBtn.textContent = "Failed";
    setTimeout(() => { copyBtn.textContent = "Copy JSON"; }, 1500);
  }
});

// ── Extract buttons ─────────────────────────────────────────────────────────

extractBtn.addEventListener("click", doExtract);
extractBtnEmpty.addEventListener("click", doExtract);

// ── Token config ────────────────────────────────────────────────────────────

const tokenInput = document.getElementById("auth-token");
const saveTokenBtn = document.getElementById("save-token-btn");

chrome.storage.local.get(["authToken"], (data) => {
  if (data.authToken) tokenInput.value = data.authToken;
});

saveTokenBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  chrome.storage.local.set({ authToken: token });
  // Reconnect with new token
  chrome.runtime.sendMessage({ type: "disconnect" });
  setTimeout(() => {
    chrome.storage.local.get(["relayUrl"], (data) => {
      chrome.runtime.sendMessage({
        type: "connect",
        url: data.relayUrl || "ws://localhost:9223",
        token,
      });
    });
  }, 300);
  saveTokenBtn.textContent = "Saved!";
  setTimeout(() => { saveTokenBtn.textContent = "Save"; }, 1500);
});

// ── Connection status ───────────────────────────────────────────────────────

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "get_status" }, (resp) => {
    if (!resp) return;

    const dot = wsStatus.querySelector(".dot");
    if (resp.connected) {
      dot.className = "dot connected";
      wsStatus.innerHTML = "";
      wsStatus.appendChild(dot);
      wsStatus.append(" WebSocket: Connected");
    } else {
      dot.className = "dot disconnected";
      wsStatus.innerHTML = "";
      wsStatus.appendChild(dot);
      wsStatus.append(" WebSocket: Disconnected");
    }

    if (resp.log) {
      logEl.textContent = resp.log;
      logEl.classList.remove("hidden");
    }
  });
}

// ── Init ────────────────────────────────────────────────────────────────────

updatePageInfo();
refreshStatus();
doExtract();

setInterval(refreshStatus, 3000);
