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
│  Capabilities:                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Extract  │  │ Inject   │  │ Site-Specific│   │
│  │ data from│  │ content  │  │ Extractors   │   │
│  │ page DOM │  │ into DOM │  │ (pluggable)  │   │
│  └──────────┘  └──────────┘  └──────────────┘   │
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

## Core Abstraction

The extension exposes a **capability-based protocol**, not a use-case-based one:

### Messages TO the extension (from any consumer)

| Message | Description |
|---------|-------------|
| `extract_page` | Extract structured data from the current page using the matching site extractor. Returns the extracted data. |
| `inject_text` | Type text into an input field on the page (identified by selector). |
| `click` | Click an element (identified by selector). |
| `read_element` | Read text content of an element. |
| `watch_element` | Stream text changes from an element (for ChatGPT streaming). |
| `get_page_info` | Return current URL, title, detected site type. |
| `upload_file` | Inject a file into a file input (for ChatGPT attachments). |

### Messages FROM the extension (to consumer)

| Message | Description |
|---------|-------------|
| `page_data` | Extracted structured data (response to `extract_page`). |
| `stream_delta` | Incremental text change (response to `watch_element`). |
| `stream_done` | Element stopped changing. |
| `status` | Connection status, current page info. |
| `error` | Something went wrong. |

### What the extension does NOT know about

- OCR prompts or JSON schemas
- Property listing databases or APIs
- Houzy, Homegate, or any backend service
- What the consumer does with the extracted data
- How to score, store, or display anything

## Site Extractors

Extractors are pluggable modules that know how to read structured data from specific websites. They return a generic key-value data object — the extension doesn't interpret the contents.

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
├── chatgpt.js          # ChatGPT: input field, response elements, streaming
├── homegate.js         # Homegate listing page structure
├── immoscout.js        # ImmoScout24
├── engelvoelkers.js    # E&V listing pages
├── neho.js             # Neho
├── swiss-broker.js     # Generic Swiss broker sites (fross, hodel, ambühl, etc.)
└── generic.js          # Fallback: JSON-LD → OpenGraph → text patterns
```

Adding a new site = adding one JS file. No changes to the extension core.

## Communication Channels

The extension supports multiple simultaneous consumers via separate connections:

### Channel 1: WebSocket (existing, for CLI tools)

```
CLI (chatgpt, ocr.sh, future tools)
  ← WebSocket → background.js service worker
  ← chrome.runtime.sendMessage → content script
  ← DOM → web page
```

The CLI sends `inject_text` + `watch_element` to drive ChatGPT.
The CLI sends `extract_page` to read data from any page.
The extension doesn't know the CLI is doing "OCR" — it just follows instructions.

### Channel 2: chrome.runtime messaging (for web apps)

```
Web app (property portal at your-app.example.com)
  ← chrome.runtime.sendMessage (externally_connectable) → background.js
  ← chrome.runtime.sendMessage → content script
  ← DOM → web page
```

The portal sends `extract_page` when user clicks "Import from browser".
The extension returns the page data. The portal decides what to do with it.

### Channel 3: Popup UI (for manual use)

```
User clicks extension icon
  → popup.js asks content script for extract_page
  → Shows extracted data
  → "Copy JSON" button copies to clipboard
```

No backend connection needed. User can paste the JSON wherever they want.

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
      "js": ["extractors/chatgpt.js", "content.js"],
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
      "js": ["extractors/shared.js", "extractors/swiss-broker.js", "content.js"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_popup": "popup.html",
    "default_title": "Chrome Bridge"
  }
}
```

**Note:** Site-specific extractors (homegate.js, etc.) are loaded via `chrome.scripting.executeScript` from the background worker when needed, not via static content_scripts. The static entry loads only `shared.js` (patterns) + `swiss-broker.js` (generic) + `content.js` (dispatcher). The dispatcher checks the hostname and asks the background to inject the site-specific extractor if available.

## Popup UI

The popup is a simple data viewer — it shows what the extension extracted from the current tab and lets you copy it:

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

No "Import to Portal" button — the extension doesn't know about portals. The portal's frontend requests data via `externally_connectable`.

## How Consumers Use It

### Consumer 1: CLI (existing ChatGPT bridge)

```bash
# The CLI sends inject_text + watch_element — unchanged from today
chatgpt "What is 2+2?"

# OCR is just a specific prompt + file attachment — the extension doesn't know it's OCR
./ocr.sh document.pdf

# Future: extract data from current browser tab
chrome-bridge extract  # → prints JSON to stdout
```

### Consumer 2: Property Portal Frontend

```javascript
// In the portal's React/Next.js code (your-app.example.com)
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

## Migration from chatgpt-bridge

1. **Copy repo**: `chatgpt-bridge/` → `chrome-bridge/`
2. **Restructure files**: Move ChatGPT-specific code into `extractors/chatgpt.js`
3. **Generalize content.js**: Site detection dispatcher instead of ChatGPT-only
4. **Generalize background.js**: Route messages by type, not by assumption
5. **Add property extractors**: `shared.js`, `homegate.js`, `swiss-broker.js`, etc.
6. **Update popup**: Generic data viewer instead of ChatGPT-specific config
7. **Keep CLI unchanged**: `cli.js` sends the same WebSocket messages — works as before
8. **Keep tests**: Update to reflect new file structure, same test coverage

### What changes for existing chatgpt-bridge users

**Nothing.** The CLI, WebSocket protocol, auth token, and ChatGPT interaction are all preserved. The extension just gains additional capabilities on other sites. The chatgpt.com content script is identical to the current one.

## Technical Constraints

- **Manifest V3**: No dynamic `import()` in content scripts. Use `chrome.scripting.executeScript` for site-specific extractors or bundle them.
- **Content script isolation**: ChatGPT and property content scripts run in separate tabs, never conflict. Enforced by manifest `matches`.
- **No persistent background**: MV3 service workers can die. WebSocket reconnection logic (existing) handles this.
- **externally_connectable**: Only whitelisted origins can message the extension. The portal URL must be listed in the manifest.

## Files

```
chrome-bridge/
├── manifest.json              # MV3, matches all supported sites
├── background.js              # Service worker: WebSocket + message routing
├── content.js                 # Generic dispatcher: detect site → extract
├── extractors/
│   ├── shared.js              # Swiss text patterns (reused across property sites)
│   ├── chatgpt.js             # ChatGPT DOM interaction (existing content.js logic)
│   ├── homegate.js            # Homegate-specific selectors
│   ├── immoscout.js           # ImmoScout24-specific
│   ├── engelvoelkers.js       # E&V listing pages
│   ├── neho.js                # Neho-specific
│   ├── swiss-broker.js        # Generic Swiss broker (covers fross, hodel, etc.)
│   └── generic.js             # Fallback: JSON-LD → OG → text
├── popup.html                 # Data viewer + connection status
├── popup.js                   # Popup logic
├── popup.css                  # Popup styling
├── lib.js                     # Shared utilities (existing)
├── cli.js                     # CLI entry point (existing, unchanged)
├── ocr.sh                     # OCR helper (existing, unchanged)
├── test/
│   ├── lib.test.js            # Existing unit tests
│   ├── content.test.js        # Existing DOM tests (update imports)
│   └── integration.test.js    # Existing WebSocket tests
├── docs/
│   └── DESIGN.md              # This document
├── package.json               # Node dependencies (existing)
└── icons/                     # Extension icons
```

## Implementation Steps

1. **Copy + restructure** — migrate from chatgpt-bridge, move files (30 min)
2. **Generalize content.js** — site detection dispatcher (30 min)
3. **Extract chatgpt.js** — move ChatGPT DOM logic into extractor module (30 min)
4. **Port shared.js** — Swiss extraction patterns from Python `extractors.py` (1 hour)
5. **Build swiss-broker.js** — generic extractor for property sites (30 min)
6. **Build homegate.js** — Homegate-specific selectors (1 hour, needs page inspection)
7. **Update popup** — generic data viewer with "Copy JSON" (30 min)
8. **Add externally_connectable** — allow portal to request data (15 min)
9. **Verify ChatGPT bridge** — run existing tests, test CLI manually (30 min)
10. **Test property extraction** — open Homegate listing, verify extract (30 min)
