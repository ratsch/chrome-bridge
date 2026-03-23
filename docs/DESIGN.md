# Plan F: Chrome Bridge Extension

**Repo:** `~/git/services/chatgpt-bridge` → rename to `chrome-bridge`
**Dependency:** Plan B (backend API with `POST /listings` endpoint)
**Effort:** 1-2 days

## Overview

Extend the existing `chatgpt-bridge` Chrome extension into a multi-site bridge that:
1. Continues to work as a ChatGPT web UI bridge (existing functionality)
2. Adds property listing extraction from Swiss real estate portals
3. Sends extracted listing data to the property portal backend API
4. Provides one-click import from any property page you're browsing

This solves the bot detection problem — Homegate, ImmoScout, and others block Playwright automation but cannot detect a Chrome extension running in your normal browser session.

## Requirements

### R1: ChatGPT bridge must continue working
- The existing ChatGPT bridge functionality (content.js, background.js WebSocket relay) must remain intact
- No regressions in ChatGPT message sending/receiving
- Same CLI interface (`cli.js`) unchanged

### R2: Detect property portal sites automatically
- When you navigate to a supported property portal, the extension activates
- No manual action needed — it just detects you're on a listing page
- Shows a small badge/icon indicating "property data available"

### R3: Extract listing data from page DOM
- Parse the rendered page (not raw HTML — the page is already rendered by your browser)
- Extract all available property fields: price, rooms, sqm, address, PLZ, year built, features, photos, agent contact, description
- Use shared Swiss extraction patterns (CHF price formatting, PLZ+municipality, etc.)
- Handle "Preis auf Anfrage" (price on request)
- Detect Zweitwohnung/Erstwohnung status

### R4: One-click import to property portal
- Extension popup shows extracted data for review
- "Import" button sends to backend API: `POST https://md.example.ts.net/listings`
- Pre-fills all available fields
- Shows confirmation: "Imported: Bildweg 12, 7250 Klosters"
- Dedup: warns if property already exists in the portal

### R5: Work across all target portals
- Must support: homegate.ch, immoscout24.ch, comparis.ch, newhome.ch, engelvoelkers.com, neho.ch, betterhomes.ch, remax.ch, sothebysrealty.com, raiffeisen.ch
- Must support Klosters local brokers: fross.ch, hodel-immo.ch, ambuehl-immo.ch, rki.ch, teresas-homes.ch, ginesta.ch
- Generic fallback for unknown sites: try JSON-LD, OpenGraph, visible text patterns

### R6: Minimal footprint
- No background activity when not on a property page
- No tracking, no external calls except to our own backend
- Extension icon changes state: grey (inactive), green (property data found), blue (ChatGPT mode)

## Architecture

```
chrome-bridge/
├── manifest.json              # Manifest V3, matches all supported sites + chatgpt.com
├── background.js              # Service worker: routes messages, manages connections
│                              #   ChatGPT: WebSocket relay (existing)
│                              #   Property: REST API calls to backend
├── content.js                 # Dispatcher: detects site, loads right extractor
├── extractors/
│   ├── shared.js              # Swiss property extraction patterns (ported from Python extractors.py)
│   │                          #   - CHF price parsing (including U+2019 thin space)
│   │                          #   - Rooms (3.5 Zimmer, 5½-Zimmer)
│   │                          #   - Area (m²)
│   │                          #   - PLZ + municipality (multi-word: "Saas im Prättigau")
│   │                          #   - Year built, heating type, parking
│   │                          #   - Zweitwohnung/Erstwohnung detection
│   │                          #   - JSON-LD extraction
│   │                          #   - OpenGraph meta tag extraction
│   │                          #   - Photo URL extraction
│   ├── homegate.js            # Homegate-specific selectors + extraction
│   ├── immoscout.js           # ImmoScout24-specific
│   ├── comparis.js            # Comparis-specific
│   ├── newhome.js             # Newhome-specific
│   ├── engelvoelkers.js       # E&V listing pages
│   ├── neho.js                # Neho-specific
│   ├── betterhomes.js         # BETTERHOMES-specific
│   ├── remax.js               # RE/MAX-specific
│   ├── brokers.js             # Generic broker sites (fross, hodel, ambühl, rki, teresas, ginesta)
│   └── generic.js             # Fallback: JSON-LD → OG → text patterns
├── chatgpt/
│   ├── content.js             # Existing ChatGPT content script (moved here)
│   └── selectors.js           # ChatGPT DOM selectors (extracted from existing)
├── popup.html                 # Extension popup UI
├── popup.js                   # Popup logic: show extracted data, import button
├── popup.css                  # Popup styling
├── api.js                     # Backend API client (REST calls to property portal)
├── lib.js                     # Shared utilities (existing)
├── cli.js                     # Existing CLI for ChatGPT bridge
└── icons/
    ├── icon-grey-48.png       # Inactive
    ├── icon-green-48.png      # Property data found
    └── icon-blue-48.png       # ChatGPT mode
```

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Chrome Bridge",
  "version": "0.2.0",
  "description": "ChatGPT bridge + Swiss property listing importer",

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
    "https://www.ginesta.ch/*",
    "https://md.example.ts.net/*"
  ],

  "background": {
    "service_worker": "background.js"
  },

  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["chatgpt/content.js"],
      "run_at": "document_idle"
    },
    {
      "matches": [
        "https://www.homegate.ch/kaufen/*",
        "https://www.homegate.ch/mieten/*",
        "https://www.immoscout24.ch/*",
        "https://www.comparis.ch/immobilien/*",
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
      "js": ["extractors/shared.js", "content.js"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_popup": "popup.html",
    "default_title": "Chrome Bridge"
  }
}
```

## Content Script Flow (Property Mode)

```javascript
// content.js — dispatches to site-specific extractor

const SITE_EXTRACTORS = {
  'homegate.ch':        () => import('./extractors/homegate.js'),
  'immoscout24.ch':     () => import('./extractors/immoscout.js'),
  'comparis.ch':        () => import('./extractors/comparis.js'),
  'newhome.ch':         () => import('./extractors/newhome.js'),
  'engelvoelkers.com':  () => import('./extractors/engelvoelkers.js'),
  'neho.ch':            () => import('./extractors/neho.js'),
  'betterhomes.ch':     () => import('./extractors/betterhomes.js'),
  'remax.ch':           () => import('./extractors/remax.js'),
  'fross.ch':           () => import('./extractors/brokers.js'),
  'hodel-immo.ch':      () => import('./extractors/brokers.js'),
  'ambuehl-immo.ch':    () => import('./extractors/brokers.js'),
  'rki.ch':             () => import('./extractors/brokers.js'),
  'teresas-homes.ch':   () => import('./extractors/brokers.js'),
  'ginesta.ch':         () => import('./extractors/brokers.js'),
};

async function extractListing() {
  const hostname = window.location.hostname.replace('www.', '');

  // Find matching extractor
  let extractorLoader = null;
  for (const [domain, loader] of Object.entries(SITE_EXTRACTORS)) {
    if (hostname.includes(domain)) {
      extractorLoader = loader;
      break;
    }
  }

  // Use generic fallback if no match
  if (!extractorLoader) {
    extractorLoader = () => import('./extractors/generic.js');
  }

  const extractor = await extractorLoader();
  const listing = extractor.extract(document, window.location.href);

  // Enrich with shared patterns (JSON-LD, OG tags, text patterns)
  const enriched = SharedExtractor.enrich(listing, document);

  // Send to background
  chrome.runtime.sendMessage({
    type: 'property_extracted',
    data: enriched,
    url: window.location.href,
    source: hostname,
  });
}

// Auto-extract on page load
extractListing();

// Re-extract on SPA navigation (for React/Angular sites like Homegate)
const observer = new MutationObserver(() => {
  clearTimeout(window._extractTimeout);
  window._extractTimeout = setTimeout(extractListing, 2000);
});
observer.observe(document.body, { childList: true, subtree: true });
```

## Shared Extractor (JS port of Python extractors.py)

```javascript
// extractors/shared.js

const SharedExtractor = {
  // Price patterns — CHF with Swiss formatting (U+2019 as thousand separator)
  extractPrice(text) {
    const patterns = [
      /(?:CHF|Fr\.)\s*([\d'''\u2018\u2019.,]+)/i,
      /(?:Kaufpreis|Verkaufspreis|Price)\s*:?\s*(?:CHF)?\s*([\d'''\u2018\u2019.,]+)/i,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        const price = parseInt(m[1].replace(/[''\u2018\u2019.,]/g, ''));
        if (price > 10000) return { price, known: true };
      }
    }
    if (/Preis auf Anfrage|Price on request/i.test(text)) {
      return { price: null, known: false };
    }
    return { price: null, known: false };
  },

  // Rooms: "3.5 Zimmer"
  extractRooms(text) { ... },

  // Area: "120 m²"
  extractArea(text) { ... },

  // PLZ + municipality
  extractLocation(text) { ... },

  // Year built
  extractYear(text) { ... },

  // Zweitwohnung/Erstwohnung
  extractZweitwohnung(text) { ... },

  // JSON-LD
  extractJsonLd(document) { ... },

  // OpenGraph
  extractOpenGraph(document) { ... },

  // Photos
  extractPhotos(document) { ... },

  // Merge all into listing object
  enrich(listing, document) {
    const text = document.body.innerText;
    if (!listing.price) Object.assign(listing, this.extractPrice(text));
    if (!listing.rooms) listing.rooms = this.extractRooms(text);
    // ... etc
    return listing;
  },
};
```

## Popup UI

```
┌─────────────────────────────────────────┐
│  🏠 Property Found                      │
│                                          │
│  Bildweg 12, 7250 Klosters              │
│  CHF 1,480,000 · 3.5 Zi · 91 m²        │
│  Built 2009 · STWE · Zweitwohnung OK    │
│                                          │
│  ☀️ Mountain view · 🅿️ 2 parking        │
│  🔥 Oil heating · 🏔️ 1,182m altitude    │
│                                          │
│  Source: neho.ch                         │
│  Completeness: 83%                       │
│                                          │
│  [   Import to Portal   ]  [ Dismiss ]  │
│                                          │
│  ─────────────────────────────────────   │
│  ChatGPT Bridge: ● Connected            │
└─────────────────────────────────────────┘
```

## Backend API Integration

```javascript
// api.js

const API_BASE = 'https://md.example.ts.net';
const API_KEY = '...';  // Stored in chrome.storage.sync

async function importListing(listing) {
  // Check for duplicates first
  const existing = await fetch(`${API_BASE}/listings?search=${encodeURIComponent(listing.address)}&plz=${listing.plz}`);
  const data = await existing.json();

  if (data.items.length > 0) {
    return { status: 'duplicate', existing: data.items[0] };
  }

  // Create new listing
  const resp = await fetch(`${API_BASE}/listings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      address: listing.address,
      plz: listing.plz,
      municipality: listing.municipality,
      listing_url: listing.url,
      listing_source: listing.source,
      price_chf: listing.price,
      price_known: listing.priceKnown,
      living_area_sqm: listing.area,
      rooms: listing.rooms,
      year_built: listing.yearBuilt,
      property_type: listing.propertyType,
      description: listing.description,
      photo_urls: listing.photos,
      agent_name: listing.agentName,
      agent_email: listing.agentEmail,
      agent_phone: listing.agentPhone,
      // ... all other fields
    }),
  });

  return await resp.json();
}
```

## Site-Specific Extractors

Each extractor knows where data lives on that portal's DOM:

### Homegate Example

```javascript
// extractors/homegate.js

export function extract(document, url) {
  const listing = { source: 'homegate', url };

  // Homegate uses specific CSS classes/data attributes
  // These need to be discovered by inspecting the actual page

  // Price
  const priceEl = document.querySelector('[data-test="price"], .HgPriceModule');
  if (priceEl) {
    Object.assign(listing, SharedExtractor.extractPrice(priceEl.textContent));
  }

  // Address
  const addressEl = document.querySelector('[data-test="address"], .AddressDetails');
  if (addressEl) {
    Object.assign(listing, SharedExtractor.extractLocation(addressEl.textContent));
    listing.address = addressEl.textContent.trim();
  }

  // Details table (rooms, area, year, etc.)
  const detailRows = document.querySelectorAll('.SpacedTable tr, [data-test="attributes"] li');
  for (const row of detailRows) {
    const text = row.textContent;
    if (/Zimmer|rooms/i.test(text)) listing.rooms = SharedExtractor.extractRooms(text);
    if (/Fläche|area|m²/i.test(text)) listing.area = SharedExtractor.extractArea(text);
    if (/Baujahr|Built/i.test(text)) listing.yearBuilt = SharedExtractor.extractYear(text);
    // ... etc
  }

  // Photos
  listing.photos = SharedExtractor.extractPhotos(document);

  // Description
  const descEl = document.querySelector('[data-test="description"], .Description');
  if (descEl) listing.description = descEl.textContent.trim();

  return listing;
}
```

**NOTE:** The exact CSS selectors for each portal need to be discovered by inspecting the live pages. The selectors above are approximations — the implementing agent should inspect each portal and update them.

## Backend Changes Required

Plan B needs one additional endpoint (or adapt the existing create flow):

```
POST /listings/import
  Accept a listing from the Chrome extension.
  Similar to what reprocess_listings.py creates, but triggered by REST API.
  Handles dedup, scenario assignment, and returns the created listing.
```

This can also be the existing `POST /listings` endpoint if Plan B implements it.

## Migration from chatgpt-bridge

1. **Rename repo**: `chatgpt-bridge` → `chrome-bridge`
2. **Move existing code**: `content.js` → `chatgpt/content.js`, update manifest
3. **Add property extraction**: new `content.js` dispatcher + `extractors/` directory
4. **Extend popup**: show property data when on a listing page, ChatGPT status at bottom
5. **Test**: verify ChatGPT bridge still works after refactoring
6. **Update deploy**: re-load extension in Chrome

## Implementation Steps

1. **Restructure** — Move ChatGPT files, set up new directory structure (30 min)
2. **Port shared extractor** — Translate `extractors.py` patterns to JavaScript (1 hour)
3. **Build content.js dispatcher** — Site detection + extractor loading (30 min)
4. **Build popup UI** — Show extracted data + import button (1 hour)
5. **Build API client** — REST calls to backend with auth (30 min)
6. **Build Homegate extractor** — Inspect live page, map selectors (1 hour)
7. **Build generic extractor** — JSON-LD + OG + text fallback (30 min)
8. **Build broker extractors** — Simple text-based for local sites (30 min)
9. **Test end-to-end** — Extract from Homegate → import to portal (30 min)
10. **Verify ChatGPT** — Ensure existing bridge still works (15 min)
