/**
 * Shared Swiss property text patterns.
 *
 * Provides regex patterns and parse helpers for Swiss property listing text.
 * These are available to downstream consumers via the extracted data, and
 * also used by the extractor to trim page text to the listing content.
 */

const SwissPatterns = {
  price: /CHF\s*[\d'',.\s]+(?:\.–|–)?(?:\s*\/\s*(?:Mt\.|Monat|m\.|Mon\.))?/gi,
  priceValue: /CHF\s*([\d'',.\s]+)/i,
  priceOnRequest: /(?:on request|price on request|auf anfrage|preis auf anfrage|prix sur demande|su richiesta)/i,
  rooms: /(\d+[.,]?\d*)\s*(?:½\s*)?(?:Zimmer|Zi\.|rooms?)/i,
  roomsAlt: /(\d+[.,]?\d*)\s*(?:½\s*)?(?:pièces?|locali)/i,
  area: /(\d+(?:[.,]\d+)?)\s*m[²2]/gi,
  livingArea: /(?:Wohnfläche|Wohnfl\.|Living area|Surface habitable|Floor space)\s*[:.]?\s*(\d+(?:[.,]\d+)?)\s*m[²2]/i,
  plotArea: /(?:Grundstückfläche|Grundstückfl\.|Plot area|Surface terrain|Grundstück)\s*[:.]?\s*(\d+(?:[.,]\d+)?)\s*m[²2]/i,
  plz: /\b([1-9]\d{3})\s+([A-ZÀ-Ž][a-zà-ž\-]+(?:\s+[a-zà-ž\-]+)*)\b/g,
  yearBuilt: /(?:Baujahr|Built|Year built|Année de construction|Anno di costruzione|Year of construction)\s*[:.]?\s*(\d{4})/i,
  referenceId: /(?:Objekt-?Nr\.|Object ref\.|Ref\.|Reference|Referenz|Listing ID)\s*[:.]?\s*(\S+)/i,
};

function parsePrice(str) {
  if (!str) return null;
  const match = str.match(SwissPatterns.priceValue);
  if (!match) return null;
  const cleaned = match[1].replace(/['',\s]/g, "").replace(/\.–$/, "").replace(/\.$/, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseRooms(str) {
  if (!str) return null;
  const match = str.match(SwissPatterns.rooms) || str.match(SwissPatterns.roomsAlt);
  if (!match) return null;
  let val = match[1].replace(",", ".");
  if (str.includes("½")) val = String(parseFloat(val) + 0.5);
  return parseFloat(val);
}

function parseArea(str) {
  if (!str) return null;
  const match = str.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/);
  if (!match) return null;
  return parseFloat(match[1].replace(",", "."));
}

function extractAddress(text) {
  if (!text) return null;
  const match = text.match(SwissPatterns.plz);
  if (!match) return null;
  const plzMatch = text.match(/([A-ZÀ-Ža-zà-ž][\w\s.,\-]+?)\s*[,\n]\s*([1-9]\d{3})\s+([A-ZÀ-Ž][a-zà-ž\-]+(?:\s+[a-zà-ž\-]+)*)/);
  if (plzMatch) {
    return {
      street: plzMatch[1].replace(/[,\n\s]+$/, "").trim(),
      plz: plzMatch[2],
      city: plzMatch[3].trim(),
    };
  }
  return null;
}

/**
 * Trim page text to the main listing content by removing recommendation
 * sections, contact forms, and footers that pollute pattern matching.
 */
function trimToListing(text) {
  const cutMarkers = [
    /\n\s*(?:Other properties|Ähnliche Objekte|Andere Immobilien|Weitere Objekte|Autres biens|Similar listings|You might also like)/i,
    /\n\s*(?:Fraud prevention|Betrugshinweis|Prévention de la fraude)/i,
    /\n\s*(?:Tips and services|Tipps und Services)/i,
    /\n\s*(?:Report listing|Inserat melden)/i,
    /\n\s*(?:Contact the advertiser|Kontakt aufnehmen|Contacter l'annonceur)/i,
  ];
  let trimmed = text;
  for (const marker of cutMarkers) {
    const idx = trimmed.search(marker);
    if (idx > 200) {
      trimmed = trimmed.slice(0, idx);
    }
  }
  return trimmed;
}

// ── Expose globally for other extractors ────────────────────────────────────

if (typeof window !== "undefined") {
  window.__chromeBridge = window.__chromeBridge || {};
  window.__chromeBridge.SwissPatterns = SwissPatterns;
  window.__chromeBridge.parsePrice = parsePrice;
  window.__chromeBridge.parseRooms = parseRooms;
  window.__chromeBridge.parseArea = parseArea;
  window.__chromeBridge.extractAddress = extractAddress;
  window.__chromeBridge.trimToListing = trimToListing;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SwissPatterns, parsePrice, parseRooms, parseArea, extractAddress, trimToListing };
}
