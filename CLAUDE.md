# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Bridge is a Chrome extension (Manifest V3) that provides generic browser automation: extracting structured data from pages and injecting content into web pages. It is a generalization of `~/git/services/chatgpt-bridge`, with the ChatGPT bridge functionality built as a layer on top of the generic core.

Consumers connect via WebSocket (CLI tools) or `chrome.runtime` messaging (web apps). The extension is capability-based — it doesn't know what consumers do with the data.

## Layered Architecture

**Layer 1 — Core (generic):** `inject_text`, `click`, `read_element`, `watch_element`, `extract_page`, `get_page_info`, `upload_file`. Implemented in `content.js` (dispatcher) and `background.js` (router). Knows nothing about any specific site.

**Layer 2 — ChatGPT (on top of core):** `send_message`, `fetch_api`, `scrape_dom`. These are compound commands handled entirely by `extractors/chatgpt.js`. The core forwards unknown message types to the extractor, which handles them end-to-end. The CLI, `ocr.sh`, and export tools are unchanged — they send ChatGPT-layer messages.

## Build & Test Commands

```bash
npm install          # install dependencies
npm test             # run all tests (jest --forceExit)
npx jest test/lib.test.js           # run a single test file
npx jest -t "test name pattern"     # run tests matching a name
```

No build step — plain JS, loaded directly as an unpacked Chrome extension.

To load in Chrome: `chrome://extensions/` → Developer Mode → Load unpacked → select this directory.

## Architecture

```
CLI / Web app
  ↕ WebSocket (port 9223) or chrome.runtime messaging
background.js (service worker) — message routing, WebSocket client
  ↕ chrome.runtime.sendMessage / onMessageExternal
content.js (injected per-tab) — generic dispatcher
  ↕ delegates to site-specific extractor
extractors/*.js — pluggable, one per site
  ↕ DOM
web page
```

### Key Components

- **`background.js`** — MV3 service worker. Connects as WebSocket **client** to the CLI's server on `localhost:9223`. Routes messages to/from content scripts by active tab (not hardcoded to ChatGPT). Handles `chrome.runtime.onMessageExternal` for web app consumers. Message-type agnostic — forwards any message without interpreting it. Can die and restart (MV3 constraint); reconnection logic handles this.
- **`content.js`** — Generic dispatcher (~100 lines). Routes incoming messages: checks if the site's extractor has a handler for the message type, delegates if yes, otherwise handles core generic commands. Manages the extractor registry via `window.__chromeBridge`.
- **`extractors/chatgpt.js`** — All ChatGPT DOM logic from the original `chatgpt-bridge/content.js`. Handles `send_message` (fill input → click send → stream response), `fetch_api` (proxy fetch through browser session), `scrape_dom` (DOM querying). Registers with the dispatcher as the `chatgpt.com` extractor.
- **`extractors/shared.js`** — Reusable Swiss text patterns (CHF, PLZ, m²).
- **`extractors/swiss-broker.js`** — Generic fallback for Swiss property sites.
- **`cli.js`** — Node CLI entry point (unchanged from chatgpt-bridge). Starts a local WebSocket server, sends prompts via `send_message`, streams responses. Installed as `chatgpt` binary via npm.
- **`chatgpt-export.js`** — Conversation exporter using `fetch_api` messages (unchanged).
- **`lib.js`** — Pure utility functions (argument parsing, prompt building, output patterns).
- **`popup.html/js`** — Extension popup UI showing extracted data and connection status.

### Content Script Loading

`content.js` (dispatcher) loads first via manifest `content_scripts`, then extractor modules load after it and register with the dispatcher. Site-specific extractors beyond the defaults can be injected dynamically via `chrome.scripting.executeScript` from the background worker.

### Core Protocol

Consumer → extension: `extract_page`, `inject_text`, `click`, `read_element`, `watch_element`, `get_page_info`, `upload_file`

Extension → consumer: `page_data`, `stream_delta`, `stream_done`, `status`, `error`

ChatGPT-layer (handled by chatgpt extractor only): `send_message`, `fetch_api`, `scrape_dom` → `stream_start`, `stream_delta`, `stream_done`, `fetch_response`, `scrape_response`

### Auth

CLI and extension share an auth token. Resolution order: `--token` flag → `CHATGPT_BRIDGE_TOKEN` env var → persisted temp file → random. Token file kept as `chatgpt-bridge-token` for backwards compatibility.

## Migration Context

This repo is built by migrating from `~/git/services/chatgpt-bridge`. The key changes are:
1. ChatGPT-specific content.js (700 lines) → `extractors/chatgpt.js` + thin generic `content.js` dispatcher
2. background.js routes by active tab instead of hardcoded ChatGPT, adds `onMessageExternal`
3. New property site extractors (`shared.js`, `swiss-broker.js`, `homegate.js`)
4. Popup rewritten from connection config UI to generic data viewer
5. `externally_connectable` support for web app consumers
6. CLI, lib.js, ocr.sh, chatgpt-export.js, export-projects*.js copied unchanged

## Testing

- **`test/lib.test.js`** — Unit tests for argument parsing, prompt building, output expansion
- **`test/chatgpt.test.js`** — Tests for ChatGPT extractor (extractText, SELECTORS) — moved from old content.test.js
- **`test/content.test.js`** — Tests for the generic dispatcher
- **`test/integration.test.js`** — Full WebSocket round-trip tests

Test environment: Jest with `jest-environment-jsdom` for DOM tests.

## ChatGPT DOM Selectors

These selectors are fragile and may need updating when ChatGPT changes its UI:
- `#prompt-textarea` — Chat input (contenteditable div)
- `button[data-testid="send-button"]` — Send button
- `[data-message-author-role="assistant"]` — Assistant messages
- `.result-streaming` — Streaming indicator
- Stream-done detection requires all three signals (no streaming class, no stop button, text settled for 2s) to hold for 500ms.
