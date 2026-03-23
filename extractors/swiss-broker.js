/**
 * Swiss broker extractor — extracts raw data from Swiss property listing sites.
 *
 * Provides structured data that the site gives us (JSON-LD, OpenGraph) plus
 * the listing's raw text and photos. Parsing structured fields (price, rooms,
 * area) is left to the downstream consumer — they know their domain better.
 *
 * The extractor's job is to deliver clean, relevant raw material:
 *   - JSON-LD and meta tags (as-is from the page)
 *   - Page text trimmed to the listing (excluding recommendations, forms, footer)
 *   - Listing photos (excluding recommendation thumbnails)
 *   - Address from the Location section if clearly labeled
 */

(function register() {
  const bridge = window.__chromeBridge = window.__chromeBridge || {};
  bridge.extractors = bridge.extractors || {};

  const trimToListing = bridge.trimToListing || ((t) => t);

  function extract() {
    const result = {
      type: "property_listing",
      source: window.location.hostname,
      url: window.location.href,
      data: {},
      raw_text: "",
      json_ld: [],
      meta: {},
      photos: [],
    };

    // ── JSON-LD ──────────────────────────────────────────────────────────
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        result.json_ld.push(JSON.parse(script.textContent));
      } catch {}
    }

    // ── OpenGraph meta ───────────────────────────────────────────────────
    const metaTags = document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]');
    for (const tag of metaTags) {
      const prop = (tag.getAttribute("property") || tag.getAttribute("name") || "").replace("og:", "");
      const content = tag.getAttribute("content");
      result.meta[prop] = content;
      if (prop === "image") result.photos.push(content);
    }

    // Title from OG or document title
    result.data.title = result.meta.title || document.title;

    // ── Page text ────────────────────────────────────────────────────────
    const fullText = (document.body.innerText || document.body.textContent || "").trim();
    // Trim to listing content (exclude recommendations, forms, footer)
    result.raw_text = trimToListing(fullText).slice(0, 15000);

    // ── Address (if clearly labeled) ─────────────────────────────────────
    const locMatch = result.raw_text.match(
      /(?:Location|Standort|Adresse|Lieu)\s*\n\s*(.+?,\s*[1-9]\d{3}\s+[A-ZÀ-Ž][a-zà-ž\-]+(?:\s+[a-zà-ž\-]+)*)/i
    );
    if (locMatch) {
      result.data.address = locMatch[1].trim();
    }

    // ── Photos ───────────────────────────────────────────────────────────
    const listingId = extractListingId();
    const images = document.querySelectorAll('img[src]');
    for (const img of images) {
      const src = img.src;
      if (!src.startsWith("http") || src.includes("data:")) continue;
      if (src.includes("logo") || src.includes("icon") || src.includes("avatar")) continue;

      // If we can identify the listing ID, only include its images
      if (listingId && src.includes("/listings/")) {
        if (src.includes(listingId)) {
          if (!result.photos.includes(src)) result.photos.push(src);
        }
        continue;
      }

      if (img.naturalWidth > 200 || !img.complete) {
        if (!result.photos.includes(src)) result.photos.push(src);
      }
    }
    result.photos = result.photos.slice(0, 30);

    return result;
  }

  /** Extract listing ID from URL path (e.g., /buy/4002078347 → "4002078347") */
  function extractListingId() {
    const match = window.location.pathname.match(/\/(\d{7,})(?:[/?#]|$)/);
    return match ? match[1] : null;
  }

  // Register for all known Swiss property hostnames
  const SWISS_PROPERTY_HOSTS = [
    "homegate.ch", "immoscout24.ch", "comparis.ch", "newhome.ch",
    "engelvoelkers.com", "neho.ch", "betterhomes.ch", "remax.ch",
    "sothebysrealty.com", "raiffeisen.ch",
    "fross.ch", "hodel-immo.ch", "ambuehl-immo.ch", "rki.ch",
    "teresas-homes.ch", "ginesta.ch",
  ];

  for (const host of SWISS_PROPERTY_HOSTS) {
    bridge.extractors[host] = { name: "swiss-broker", extract };
  }

  console.log("[chrome-bridge:swiss-broker] Extractor registered for", SWISS_PROPERTY_HOSTS.length, "sites");
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SWISS_PROPERTY_HOSTS: [] };
}
