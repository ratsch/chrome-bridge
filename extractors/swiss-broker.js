/**
 * Swiss broker extractor — generic extractor for Swiss property listing sites.
 *
 * Works as a fallback for sites that don't have a site-specific extractor.
 * Uses Swiss text patterns from shared.js to extract property data from page text,
 * JSON-LD, and OpenGraph meta tags.
 *
 * Covers: homegate.ch, immoscout24.ch, comparis.ch, newhome.ch, engelvoelkers.com,
 * neho.ch, betterhomes.ch, remax.ch, fross.ch, hodel-immo.ch, ambuehl-immo.ch,
 * rki.ch, teresas-homes.ch, ginesta.ch, and similar Swiss broker sites.
 */

(function register() {
  const bridge = window.__chromeBridge = window.__chromeBridge || {};
  bridge.extractors = bridge.extractors || {};

  // Helpers from shared.js (loaded before this file)
  const patterns = bridge.SwissPatterns || {};
  const parsePrice = bridge.parsePrice || (() => null);
  const parseRooms = bridge.parseRooms || (() => null);
  const parseArea = bridge.parseArea || (() => null);
  const extractAddress = bridge.extractAddress || (() => null);

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
        const ld = JSON.parse(script.textContent);
        result.json_ld.push(ld);

        // Extract data from RealEstateListing or Product schema
        const items = Array.isArray(ld) ? ld : [ld];
        for (const item of items) {
          if (item["@type"] === "RealEstateListing" || item["@type"] === "Product" ||
              item["@type"] === "Residence" || item["@type"] === "Apartment" ||
              item["@type"] === "House") {
            if (item.name) result.data.title = item.name;
            if (item.description) result.data.description = item.description;
            if (item.address) {
              const addr = item.address;
              result.data.address = [addr.streetAddress, addr.postalCode, addr.addressLocality]
                .filter(Boolean).join(", ");
            }
            if (item.offers?.price) result.data.price = String(item.offers.price);
            if (item.offers?.priceCurrency) result.data.currency = item.offers.priceCurrency;
            if (item.floorSize?.value) result.data.area = item.floorSize.value + " m²";
            if (item.numberOfRooms) result.data.rooms = String(item.numberOfRooms);
          }
        }
      } catch {}
    }

    // ── OpenGraph meta ───────────────────────────────────────────────────
    const metaTags = document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]');
    for (const tag of metaTags) {
      const prop = (tag.getAttribute("property") || tag.getAttribute("name") || "").replace("og:", "");
      const content = tag.getAttribute("content");
      result.meta[prop] = content;
      if (prop === "title" && !result.data.title) result.data.title = content;
      if (prop === "description" && !result.data.description) result.data.description = content;
      if (prop === "image") result.photos.push(content);
    }

    // ── Page text extraction ─────────────────────────────────────────────
    const bodyText = (document.body.innerText || document.body.textContent || "").trim();
    result.raw_text = bodyText.slice(0, 10000);

    // Extract structured fields from page text using Swiss patterns
    if (!result.data.price) {
      const priceMatch = bodyText.match(patterns.price);
      if (priceMatch) result.data.price = priceMatch[0].trim();
    }

    if (!result.data.rooms) {
      const roomMatch = bodyText.match(patterns.rooms) || bodyText.match(patterns.roomsAlt);
      if (roomMatch) result.data.rooms = roomMatch[0].trim();
    }

    if (!result.data.area) {
      const livingArea = bodyText.match(patterns.livingArea);
      if (livingArea) {
        result.data.area = livingArea[1] + " m²";
      } else {
        const areaMatch = bodyText.match(patterns.area);
        if (areaMatch) result.data.area = areaMatch[0].trim();
      }
    }

    // Plot area (separate from living area)
    const plotMatch = bodyText.match(patterns.plotArea);
    if (plotMatch) result.data.plotArea = plotMatch[1] + " m²";

    if (!result.data.address) {
      const addr = extractAddress(bodyText);
      if (addr) {
        result.data.address = [addr.street, addr.plz + " " + addr.city].filter(Boolean).join(", ");
      }
    }

    // Year built
    const yearMatch = bodyText.match(patterns.yearBuilt);
    if (yearMatch) result.data.yearBuilt = yearMatch[1];

    // Floor
    const floorMatch = bodyText.match(patterns.floor);
    if (floorMatch) result.data.floor = floorMatch[1];

    // Reference ID
    const refMatch = bodyText.match(patterns.referenceId);
    if (refMatch) result.data.referenceId = refMatch[1];

    // ── Photos ───────────────────────────────────────────────────────────
    const images = document.querySelectorAll('img[src]');
    for (const img of images) {
      const src = img.src;
      if (src.startsWith("http") && !src.includes("data:") &&
          !src.includes("logo") && !src.includes("icon") &&
          !src.includes("avatar") && !src.includes("sprite") &&
          (img.naturalWidth > 200 || !img.complete)) {
        if (!result.photos.includes(src)) {
          result.photos.push(src);
        }
      }
    }
    result.photos = result.photos.slice(0, 50);

    return result;
  }

  // Register for all known Swiss property hostnames
  const SWISS_PROPERTY_HOSTS = [
    "homegate.ch", "immoscout24.ch", "comparis.ch", "newhome.ch",
    "engelvoelkers.com", "neho.ch", "betterhomes.ch", "remax.ch",
    "sothebysrealty.com", "raiffeisen.ch",
    "fross.ch", "hodel-immo.ch", "ambuehl-immo.ch", "rki.ch",
    "teresas-homes.ch", "ginesta.ch",
  ];

  // Register for each hostname (dispatcher strips www. when looking up)
  for (const host of SWISS_PROPERTY_HOSTS) {
    bridge.extractors[host] = {
      name: "swiss-broker",
      extract,
    };
  }

  console.log("[chrome-bridge:swiss-broker] Extractor registered for", SWISS_PROPERTY_HOSTS.length, "sites");
})();

// ── Exports for testing ─────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  // For testing, export the extract function directly
  module.exports = { SWISS_PROPERTY_HOSTS: [] };
}
