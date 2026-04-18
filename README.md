# Chrome Bridge

A Chrome extension and CLI toolkit for **generic browser automation** —
extract structured data from any page, inject content into web pages, and drive
ChatGPT without API keys.

Chrome Bridge is a generalization of [chatgpt-bridge](../chatgpt-bridge). The
ChatGPT functionality runs as a layer on top of a generic core, so the same
extension can extract property listings, run ChatGPT prompts, or drive any
other site — with no changes to the core.

```
Terminal / Web app         Chrome Extension              Target page
       │                         │                           │
       │  chrome-bridge --url    │                           │
       │        --extract        │                           │
       ├──────── WS ────────────►│                           │
       │                         │── navigate + extract ────►│
       │                         │                           │
       │                         │◄─── DOM: read data ───────│
       │◄───── page_data ────────│                           │
       │                         │                           │
       ▼ stdout: JSON            │                           │
```

## What it does

**Core (generic, any site):**
- `extract_page` — structured data extraction (JSON-LD, OpenGraph, raw text, photos)
- `inject_text` — type text into inputs
- `click` — click buttons
- `read_element` / `watch_element` — read/stream text from elements
- `upload_file` — inject files into file inputs
- `navigate` — drive the browser to a URL

**ChatGPT layer (on top of core, site-specific):**
- `send_message` — fill prompt, click send, stream response
- `fetch_api` — proxy fetch through the ChatGPT browser session
- `scrape_dom` — query DOM elements on chatgpt.com

**Built-in site extractors:**
- `chatgpt.com` — full ChatGPT interaction
- `homegate.ch` — Swiss property listings (site-specific)
- Swiss property fallback — 14 additional broker sites

## Installation

```bash
# Clone and install
git clone git@github.com:ratsch/chrome-bridge.git
cd chrome-bridge
npm install

# Load the Chrome extension
# 1. Open chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select this directory
```

## Quick Start

### Extracting data from any page

```bash
# Navigate to a URL and extract structured JSON
chrome-bridge --url https://www.homegate.ch/buy/4002078347

# Extract data from whatever page is currently active in Chrome
chrome-bridge --extract

# Pipe into jq or a backend
chrome-bridge --url https://www.homegate.ch/buy/4002078347 | jq .data
```

### ChatGPT prompts

```bash
# One-time setup: set a token and enter it in the extension popup too
chatgpt --token mytoken "What is the capital of Switzerland?"

# Subsequent runs reuse the token automatically
chatgpt "What is the capital of Switzerland?"

# Include a text file in the prompt
chatgpt -f code.py "Review this code"

# Upload a PDF for visual analysis
chatgpt -a invoice.pdf "Extract all line items as JSON"

# Pipe stdin
cat error.log | chatgpt "What went wrong?"

# Batch: process each file separately
chatgpt -b -o '{name}.documented.{ext}' -f *.py "Add docstrings"
```

### OCR helper

```bash
# Scanned PDFs → structured JSON via ChatGPT vision
./ocr.sh invoice.pdf                  # 1-page document
./ocr.sh -n 5 contract.pdf            # 5 pages, with retries
```

## CLI Reference

```
Usage: chatgpt [options] "prompt"
       chrome-bridge --extract [--url <url>]

Options:
  -e, --extract           Extract data from the active browser tab (JSON to stdout)
  -u, --url <url>         Navigate to URL before extracting (implies --extract)
  -f, --file <file>       Include file contents in the prompt (repeatable)
  -a, --attach <file>     Upload file to ChatGPT (PDF, images; repeatable)
  -b, --batch             Process each -f file as a separate request
  -o, --output <pattern>  Write batch results to files ({name}, {ext}, {base})
  -t, --timeout <secs>    Response timeout in seconds (default: 3600)
  --token <value>         Auth token (default: random, or CHATGPT_BRIDGE_TOKEN env)
  -h, --help              Show this help
```

**Environment variables:**
- `CHATGPT_BRIDGE_TOKEN` — auth token (alternative to `--token`)

## Authentication

The CLI and extension share an auth token. Resolution order:
`--token` flag → `CHATGPT_BRIDGE_TOKEN` env var → persisted token file → random.

The token persists in `/tmp/chatgpt-bridge-token` between runs. Set it once in
the extension popup's **Auth token** field and it stays connected.

## Architecture

Two-layer design:

```
Layer 1 — Core (generic):
  background.js  — WebSocket client, message router
  content.js     — dispatcher, registers extractors
  extractors/    — pluggable per-site modules

Layer 2 — ChatGPT (compound commands on top of core):
  extractors/chatgpt.js — handles send_message, fetch_api, scrape_dom
```

See [docs/DESIGN.md](docs/DESIGN.md) for full architecture and protocol.

### Adding a new site extractor

1. Create `extractors/yoursite.js` that registers with `window.__chromeBridge.extractors`
2. Add the URL pattern to `manifest.json` (`host_permissions` + `content_scripts`)
3. Reload the extension

The extractor gets the rendered DOM via standard DOM APIs and returns a
structured data object. The protocol and routing are unchanged.

## Consumers

### Python / Bash

```bash
# Any language that can exec + parse JSON works
chrome-bridge --url https://www.homegate.ch/buy/4002078347 > listing.json
```

### Web app (via `externally_connectable`)

```javascript
const EXTENSION_ID = "<your-extension-id>";
const response = await chrome.runtime.sendMessage(
  EXTENSION_ID,
  { type: "extract_page" }
);
// response contains { type, source, url, data, json_ld, meta, photos, raw_text }
```

Whitelist the web app's origin in `manifest.json` → `externally_connectable.matches`.

### Popup

Click the extension icon → see extracted JSON → **Copy JSON** → paste anywhere.

## Development

### Running Tests

```bash
npm test
```

- `test/lib.test.js` — CLI argument parsing, prompt building, output expansion
- `test/content.test.js` — generic dispatcher, genericExtract
- `test/chatgpt.test.js` — ChatGPT extractor, selectors, text extraction
- `test/shared.test.js` — Swiss property pattern parsing
- `test/integration.test.js` — full WebSocket round-trip

### Project Structure

```
chrome-bridge/
├── cli.js                  # CLI entry: WebSocket server + prompt/extract modes
├── lib.js                  # Pure utility functions
├── background.js           # Service worker: WS client, message routing
├── content.js              # Content script: generic dispatcher
├── manifest.json           # MV3 manifest
├── popup.{html,js,css}     # Extension popup UI
├── extractors/
│   ├── shared.js           # Swiss text patterns (CHF, PLZ, m²)
│   ├── chatgpt.js          # ChatGPT DOM interaction
│   ├── homegate.js         # Homegate site-specific extractor
│   └── swiss-broker.js     # Generic Swiss property broker extractor
├── ocr.sh                  # Visual OCR helper
├── chatgpt-export.js       # Conversation exporter
├── nav-extract.js          # Standalone navigate + extract helper
├── docs/DESIGN.md          # Architecture and protocol reference
├── test/                   # Jest unit + integration tests
├── README.md
├── LICENSE
└── package.json
```

## Limitations

- **DOM fragility** — UI changes on target sites may break selectors
- **Single conversation on ChatGPT** — interacts with whatever chat is open
- **Rate limiting** — subject to target site rate limits
- **File size** — large attachments sent as base64 over WebSocket (~50MB practical limit)
- **One operation at a time** — the CLI is one-shot; the extension processes sequentially

## License

See [LICENSE](LICENSE).
