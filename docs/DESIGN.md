# Chrome Bridge — Design Document

**Repo:** `~/git/services/chrome-bridge`
**Based on:** `~/git/services/chatgpt-bridge` (to be migrated)
**Effort:** 1-2 days

## Overview

A Chrome extension that provides **generic browser automation capabilities** to external consumers. It does two things:

1. **Extract** structured data from the current page (site-specific extractors)
2. **Inject** content into web pages (type text, click buttons, read responses)

The extension doesn't know or care what the data is used for. It's a bridge between the browser DOM and external tools. The consumers decide the purpose:

- A CLI tool uses inject+extract on chatgpt.com → that's a ChatGPT bridge
- A CLI tool uses inject+extract on chatgpt.com with a specific OCR prompt → that's an OCR tool
- A property portal uses extract on homegate.ch → that's a listing importer
- Any future tool can use the same capabilities

```
┌─────────────────────────────────────────────────┐
│  Chrome Extension (chrome-bridge)                │
│                                                   │
│  Core (generic):                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Extract  │  │ Inject   │  │ Site-Specific│   │
│  │ data from│  │ content  │  │ Extractors   │   │
│  │ page DOM │  │ into DOM │  │ (pluggable)  │   │
│  └──────────┘  └──────────┘  └──────────────┘   │
│                                                   │
│  ChatGPT layer (on top of core):                  │
│  ┌────────────────────────────────────────────┐  │
│  │ send_message, fetch_api, scrape_dom        │  │
│  │ Compound ops built from core primitives    │  │
│  │ Handled entirely by extractors/chatgpt.js  │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  Protocol: WebSocket + chrome.runtime messages    │
│  Auth: per-connection token                       │
└──────────────────────┬────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
     CLI tool     Portal UI    Any future
     (chatgpt,   (import      consumer
      ocr.sh)    listing)
```

## Layered Architecture

Chrome-bridge has two layers:

### Layer 1: Core (generic browser automation)

The core knows nothing about ChatGPT, property listings, or any specific site. It provides:

- **Generic message primitives** — `inject_text`, `click`, `read_element`, `watch_element`, `extract_page`, `get_page_info`, `upload_file`
- **Message routing** — background.js forwards messages to the right tab's content script
- **Content script dispatcher** — content.js detects the site and delegates to the matching extractor
- **Extractor plugin system** — each extractor registers what it can handle

### Layer 2: ChatGPT bridge (site-specific, built on core)

The existing chatgpt-bridge functionality lives entirely in `extractors/chatgpt.js`. It:

- Registers handlers for ChatGPT-specific compound commands: `send_message`, `fetch_api`, `scrape_dom`
- Implements DOM interaction (fill input, click send, stream response) internally
- The core doesn't know these commands exist — the chatgpt extractor handles them end-to-end
- The CLI (`cli.js`) is unchanged — it sends `send_message` and the chatgpt extractor decomposes it

This means the CLI, `ocr.sh`, `chatgpt-export.js`, and `export-projects*.js` all work unchanged. They send ChatGPT-specific messages that the chatgpt extractor handles directly.

## Core Protocol

The core extension exposes a **capability-based protocol**, not a use-case-based one:

### Messages TO the extension (from any consumer)

| Message | Description |
|---------|-------------|
| `extract_page` | Extract structured data from the current page using the matching site extractor. Returns the extracted data. |
| `inject_text` | Type text into an input field on the page (identified by selector). |
| `click` | Click an element (identified by selector). |
| `read_element` | Read text content of an element. |
| `watch_element` | Stream text changes from an element. |
| `get_page_info` | Return current URL, title, detected site type. |
| `upload_file` | Inject a file into a file input. |

### Messages FROM the extension (to consumer)

| Message | Description |
|---------|-------------|
| `page_data` | Extracted structured data (response to `extract_page`). |
| `stream_delta` | Incremental text change (response to `watch_element`). |
| `stream_done` | Element stopped changing. |
| `status` | Connection status, current page info. |
| `error` | Something went wrong. |

### ChatGPT-layer messages (handled by chatgpt extractor only)

These are **not** core protocol messages. They are ChatGPT-specific compound commands registered by `extractors/chatgpt.js`:

| Message | Description |
|---------|-------------|
| `send_message` | Compound: fill input → click send → watch for response → stream deltas. Used by `cli.js`. |
| `fetch_api` | Proxy a fetch request through the browser session (uses ChatGPT's auth cookies). Used by `chatgpt-export.js`. |
| `scrape_dom` | Query DOM elements by selector and return results. Used by `export-projects*.js`. |

Responses from these commands (`stream_start`, `stream_delta`, `stream_done`, `fetch_response`, `scrape_response`) are also ChatGPT-layer messages forwarded back through the core's generic message routing.

### What the extension core does NOT know about

- ChatGPT input fields, send buttons, or streaming detection
- OCR prompts or JSON schemas
- Property listing databases or APIs
- `send_message`, `fetch_api`, or `scrape_dom` semantics
- What the consumer does with the extracted data

## Site Extractors

Extractors are pluggable modules that know how to interact with specific websites. They can:

1. **Extract data** — respond to `extract_page` with structured data from the page
2. **Handle custom commands** — register handlers for site-specific message types (e.g., ChatGPT's `send_message`)

```javascript
// An extractor returns whatever structured data it can find on the page
// The consumer decides what the fields mean

{
  type: "property_listing",  // or "chat_message", or "search_results", etc.
  source: "homegate.ch",
  url: "https://www.homegate.ch/kaufen/12345",
  data: {
    // Site-specific fields — the extension just extracts them
    price: "CHF 1'480'000",
    rooms: "3.5",
    area: "91 m²",
    address: "Bildweg 12, 7250 Klosters",
    // ... whatever the extractor finds
  },
  raw_text: "...",  // Full page text as fallback
  json_ld: [...],   // JSON-LD if present
  meta: {...},      // OpenGraph/meta tags
  photos: [...],    // Image URLs found on page
}
```

### Extractor Registry

```
extractors/
├── shared.js           # Swiss text patterns (CHF, PLZ, m², Zimmer)
├── chatgpt.js          # ChatGPT: send_message, fetch_api, scrape_dom, streaming
├── homegate.js         # Homegate listing page structure
├── immoscout.js        # ImmoScout24
├── engelvoelkers.js    # E&V listing pages
├── neho.js             # Neho
├── swiss-broker.js     # Generic Swiss broker sites (fross, hodel, ambühl, etc.)
└── generic.js          # Fallback: JSON-LD → OpenGraph → text patterns
```

Adding a new site = adding one JS file + updating manifest matches. No changes to the extension core.

### Extractor API

Each extractor registers with the dispatcher by setting properties on a global registry:

```javascript
// extractors/chatgpt.js — registers ChatGPT-specific handlers
window.__chromeBridge = window.__chromeBridge || {};
window.__chromeBridge.extractors = window.__chromeBridge.extractors || {};
window.__chromeBridge.extractors["chatgpt.com"] = {
  extract(document) { /* ... */ },
  // Custom command handlers — core dispatcher delegates unknown message types here
  handlers: {
    send_message(msg) { /* fill input, click send, watch response */ },
    fetch_api(msg) { /* proxy fetch through browser session */ },
    scrape_dom(msg) { /* query DOM elements */ },
  }
};
```

## Communication Channels

The extension supports multiple simultaneous consumers via separate connections:

### Channel 1: WebSocket (for CLI tools)

```
CLI starts WebSocket SERVER on port 9223
  → background.js connects as WebSocket CLIENT
  → background.js forwards messages to content script via chrome.runtime.sendMessage
  → content script operates on the DOM
  → responses flow back: content script → background.js → WebSocket → CLI stdout
```

**Note:** The CLI is the WebSocket server, not the extension. The extension's background.js connects to the CLI as a client. This means the CLI must be running before the extension can connect.

### Channel 2: chrome.runtime messaging (for web apps)

```
Web app (property portal at your whitelisted origin)
  → chrome.runtime.sendMessage (externally_connectable) → background.js
  → background.js routes to content script in the active tab
  → content script extracts/injects via DOM
  → response flows back: content script → background.js → web app callback
```

background.js must implement `chrome.runtime.onMessageExternal.addListener` (in addition to `onMessage` for internal messages). This is a new code path — the existing chatgpt-bridge only handles internal messages.

### Channel 3: Popup UI (for manual use)

```
User clicks extension icon
  → popup.js sends message to background.js
  → background.js routes to content script in the active tab
  → content script runs extract_page
  → extracted data displayed in popup
  → "Copy JSON" button copies to clipboard
```

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Chrome Bridge",
  "version": "0.2.0",
  "description": "Generic browser data extraction and injection bridge",

  "permissions": ["storage", "activeTab", "scripting"],

  "host_permissions": [
    "https://chatgpt.com/*",
    "https://*.oaiusercontent.com/*",
    "https://*.openai.com/*",
    "https://www.homegate.ch/*",
    "https://www.immoscout24.ch/*",
    "https://www.comparis.ch/*",
    "https://www.newhome.ch/*",
    "https://www.engelvoelkers.com/*",
    "https://www.neho.ch/*",
    "https://www.betterhomes.ch/*",
    "https://www.remax.ch/*",
    "https://www.sothebysrealty.com/*",
    "https://www.raiffeisen.ch/*",
    "https://www.fross.ch/*",
    "https://www.hodel-immo.ch/*",
    "https://ambuehl-immo.ch/*",
    "https://rki.ch/*",
    "https://www.teresas-homes.ch/*",
    "https://www.ginesta.ch/*"
  ],

  "externally_connectable": {
    "matches": [
      "https://your-app.example.com/*",
      "http://localhost:*/*"
    ]
  },

  "background": {
    "service_worker": "background.js"
  },

  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["content.js", "extractors/chatgpt.js"],
      "run_at": "document_idle"
    },
    {
      "matches": [
        "https://www.homegate.ch/*",
        "https://www.immoscout24.ch/*",
        "https://www.comparis.ch/*",
        "https://www.newhome.ch/*",
        "https://www.engelvoelkers.com/*",
        "https://www.neho.ch/*",
        "https://www.betterhomes.ch/*",
        "https://www.remax.ch/*",
        "https://www.fross.ch/*",
        "https://www.hodel-immo.ch/*",
        "https://ambuehl-immo.ch/*",
        "https://rki.ch/*",
        "https://www.teresas-homes.ch/*",
        "https://www.ginesta.ch/*"
      ],
      "js": ["content.js", "extractors/shared.js", "extractors/swiss-broker.js"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_popup": "popup.html",
    "default_title": "Chrome Bridge"
  }
}
```

**Content script load order:** `content.js` (dispatcher) loads first, then extractor modules register with it. Site-specific extractors beyond the defaults (homegate.js, etc.) are injected dynamically via `chrome.scripting.executeScript` from background.js when needed. The `generic.js` fallback is bundled into `content.js` itself — it's the default when no site-specific extractor matches.

## Popup UI

The popup is a **complete rewrite** of the chatgpt-bridge popup. The old popup was a WebSocket connection config UI (server URL + token + connect/disconnect). The new popup is a generic data viewer:

```
┌─────────────────────────────────────────┐
│  Chrome Bridge                           │
│                                          │
│  Current page: homegate.ch/kaufen/...    │
│  Detected: Property Listing              │
│                                          │
│  Extracted data:                         │
│  ┌─────────────────────────────────────┐ │
│  │ Address: Bildweg 12, 7250 Klosters │ │
│  │ Price:   CHF 1,480,000             │ │
│  │ Rooms:   3.5                       │ │
│  │ Area:    91 m²                     │ │
│  │ Year:    2009                      │ │
│  │ ...                                │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  [  Copy JSON  ]  [  Re-extract  ]      │
│                                          │
│  ─── Connections ──────────────────────  │
│  WebSocket: ● Connected (localhost:9223) │
│  External:  1 listener                   │
└─────────────────────────────────────────┘
```

The bottom section retains the WebSocket connection status (read-only — connection is managed by background.js auto-connect, not by manual config).

## How Consumers Use It

### Consumer 1: CLI (existing ChatGPT bridge — unchanged)

```bash
# The CLI sends send_message (ChatGPT-layer command) — unchanged from today
chatgpt "What is 2+2?"

# OCR is just a specific prompt + file attachment — the extension doesn't know it's OCR
./ocr.sh document.pdf

# Export conversations — sends fetch_api (ChatGPT-layer command)
node chatgpt-export.js

# Future: extract data from current browser tab using core protocol
chrome-bridge extract  # → prints JSON to stdout
```

### Consumer 2: Property Portal Frontend

```javascript
// In the portal's React/Next.js code (your whitelisted origin)
// Uses chrome.runtime.sendMessage with the extension ID

const EXTENSION_ID = "abcdef...";  // Set during extension install

async function importFromBrowser() {
  const response = await chrome.runtime.sendMessage(
    EXTENSION_ID,
    { type: "extract_page" }
  );

  if (response.type === "property_listing") {
    // POST to our own backend
    await fetch("/api/listings/import", {
      method: "POST",
      body: JSON.stringify(response.data),
    });
  }
}
```

### Consumer 3: Manual (popup)

User clicks extension → sees extracted data → clicks "Copy JSON" → pastes wherever.

## Key Component Changes

### background.js — generalized message router

The existing background.js is ChatGPT-specific: it hardcodes `chrome.tabs.query({ url: "https://chatgpt.com/*" })` and only handles known message types. The new background.js must:

1. **Route by tab, not by site** — forward messages to the active tab or the tab specified in the message, instead of always finding a ChatGPT tab
2. **Be message-type agnostic** — forward ANY message type to the content script without interpreting it. The content script (and its extractor) decides what to do with it. Responses from content scripts are forwarded back to the WebSocket/external caller as-is.
3. **Handle external messages** — add `chrome.runtime.onMessageExternal.addListener` for `externally_connectable` consumers
4. **Keep WebSocket client logic** — auto-connect to CLI's WebSocket server on `localhost:9223`, reconnect on disconnect (existing logic, unchanged)
5. **Keep keep-alive logic** — ping to prevent MV3 service worker from dying while WebSocket is connected (existing, unchanged)

### content.js — generic dispatcher

The existing content.js is 700 lines of ChatGPT-specific code. The new content.js is a thin dispatcher:

1. **Listen for messages** from background.js
2. **Check if the site's extractor has a handler** for the message type (e.g., `send_message` → chatgpt extractor)
3. **If yes**, delegate to the extractor's handler
4. **If no**, handle generic core commands (`inject_text`, `click`, `read_element`, `watch_element`, `extract_page`, `get_page_info`, `upload_file`)
5. **Forward responses** back to background.js via `chrome.runtime.sendMessage`

### extractors/chatgpt.js — all ChatGPT logic moves here

Contains everything from the old content.js:
- `SELECTORS` object
- `handleSendMessage` (the compound send → watch → stream flow)
- `handleFetchApi` (proxy fetch through browser session)
- `handleScrapeDom` (DOM querying)
- `fillInput`, `watchForResponse`, `extractText`, `extractTextFinal`
- `uploadFiles`, `dismissModals`, `waitForAttachmentProcessed`
- `window.__chatgptBridge` debug interface

Registers as an extractor with the dispatcher, providing:
- `extract()` for `extract_page` messages
- `handlers.send_message` for CLI prompts
- `handlers.fetch_api` for API proxying
- `handlers.scrape_dom` for DOM querying

## Migration from chatgpt-bridge

### Files to copy as-is (unchanged)

| File | Purpose |
|------|---------|
| `cli.js` | CLI entry point — sends `send_message` over WebSocket |
| `lib.js` | Pure utilities (argument parsing, prompt building) |
| `ocr.sh` | OCR helper script — uses `cli.js` with `--attach` |
| `chatgpt-export.js` | Conversation exporter — uses `fetch_api` messages |
| `export-projects.js` | Project exporter variant 1 — uses `scrape_dom` |
| `export-projects2.js` | Project exporter variant 2 |
| `export-projects3.js` | Project exporter variant 3 |
| `test/lib.test.js` | Unit tests for lib.js |
| `test/integration.test.js` | WebSocket round-trip tests |

### Files to rewrite

| File | What changes |
|------|-------------|
| `manifest.json` | Add host_permissions, content_scripts for property sites, externally_connectable, fix load order |
| `background.js` | Generalize tab routing, add onMessageExternal, make message-type agnostic |
| `content.js` | Replace 700-line ChatGPT code with thin generic dispatcher (~100 lines) |
| `popup.html` + `popup.js` | Full rewrite: data viewer instead of connection config |
| `test/content.test.js` | Update imports (extractText etc. move to chatgpt.js), add dispatcher tests |

### Files to create

| File | Purpose |
|------|---------|
| `extractors/chatgpt.js` | All ChatGPT DOM logic extracted from old content.js |
| `extractors/shared.js` | Swiss text patterns (CHF, PLZ, m²) |
| `extractors/swiss-broker.js` | Generic Swiss property site extractor |
| `extractors/homegate.js` | Homegate-specific selectors (dynamic injection) |
| `popup.css` | Popup styling (extracted from inline styles) |
| `.gitignore` | `node_modules/`, `*.ocr.json`, etc. |
| `test/chatgpt.test.js` | Tests for chatgpt extractor (extractText, SELECTORS) — moved from content.test.js |

### Package changes

- `package.json` name: `chatgpt-bridge` → `chrome-bridge`
- `package.json` bin: keep `chatgpt` → `./cli.js`, add `chrome-bridge` → `./cli.js`
- Token temp file: keep `chatgpt-bridge-token` name for backwards compatibility

## Technical Constraints

- **Manifest V3**: No dynamic `import()` in content scripts. Use `chrome.scripting.executeScript` for site-specific extractors or bundle them.
- **Content script isolation**: ChatGPT and property content scripts run in separate tabs, never conflict. Enforced by manifest `matches`.
- **No persistent background**: MV3 service workers can die. WebSocket reconnection logic (existing) handles this.
- **externally_connectable**: Only whitelisted origins can message the extension. The portal URL must be listed in the manifest.
- **Content script load order**: `content.js` (dispatcher) must load before extractors so they can register with it.

## Files

```
chrome-bridge/
├── manifest.json              # MV3, matches all supported sites
├── background.js              # Service worker: WebSocket client + message routing
├── content.js                 # Generic dispatcher: route messages to extractors
├── extractors/
│   ├── shared.js              # Swiss text patterns (reused across property sites)
│   ├── chatgpt.js             # ChatGPT: send_message, fetch_api, scrape_dom, streaming
│   ├── homegate.js            # Homegate-specific selectors (dynamically injected)
│   ├── immoscout.js           # ImmoScout24-specific (dynamically injected)
│   ├── engelvoelkers.js       # E&V listing pages (dynamically injected)
│   ├── neho.js                # Neho-specific (dynamically injected)
│   └── swiss-broker.js        # Generic Swiss broker (covers fross, hodel, etc.)
├── popup.html                 # Data viewer + connection status
├── popup.js                   # Popup logic
├── popup.css                  # Popup styling
├── lib.js                     # Shared utilities (existing, unchanged)
├── cli.js                     # CLI entry point (existing, unchanged)
├── ocr.sh                     # OCR helper (existing, unchanged)
├── chatgpt-export.js          # Conversation exporter (existing, unchanged)
├── export-projects.js         # Project exporter (existing, unchanged)
├── export-projects2.js        # Project exporter variant (existing, unchanged)
├── export-projects3.js        # Project exporter variant (existing, unchanged)
├── test/
│   ├── lib.test.js            # Existing unit tests (unchanged)
│   ├── chatgpt.test.js        # ChatGPT extractor tests (moved from content.test.js)
│   ├── content.test.js        # Dispatcher tests (new)
│   └── integration.test.js    # Existing WebSocket tests (unchanged)
├── docs/
│   └── DESIGN.md              # This document
├── package.json               # Node dependencies
├── .gitignore                 # node_modules, *.ocr.json
└── icons/                     # Extension icons
```

## Implementation Steps

1. **Copy + restructure** — copy all files from chatgpt-bridge, create extractors/ directory, add .gitignore (15 min)
2. **Extract chatgpt.js** — move all ChatGPT DOM logic from content.js into extractors/chatgpt.js, register with dispatcher (1 hour)
3. **Rewrite content.js** — thin generic dispatcher that routes to extractors or handles core commands (1 hour)
4. **Generalize background.js** — tab routing by active tab (not hardcoded ChatGPT), message-type agnostic forwarding, add onMessageExternal handler (1 hour)
5. **Port shared.js** — Swiss extraction patterns from Python `extractors.py` (1 hour)
6. **Build swiss-broker.js** — generic extractor for property sites (30 min)
7. **Build homegate.js** — Homegate-specific selectors (1 hour, needs page inspection)
8. **Rewrite popup** — generic data viewer with Copy JSON, replace old connection config UI (1 hour)
9. **Update manifest** — host_permissions, content_scripts with correct load order, externally_connectable (15 min)
10. **Fix tests** — move chatgpt tests to chatgpt.test.js, add dispatcher tests, verify integration tests pass (1 hour)
11. **Verify ChatGPT bridge** — run existing tests, test CLI + ocr.sh manually (30 min)
12. **Test property extraction** — open Homegate listing, verify extract (30 min)
