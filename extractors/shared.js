/**
 * Shared Swiss property text patterns.
 *
 * Reusable regex patterns and extraction helpers for Swiss property listing sites.
 * Used by swiss-broker.js and site-specific extractors.
 */

const SwissPatterns = {
  // Price patterns: CHF 1'480'000, CHF 1,480,000, CHF 1'200.–/Mt., etc.
  price: /CHF\s*[\d'',.\s]+(?:\.–|–)?(?:\s*\/\s*(?:Mt\.|Monat|m\.|Mon\.))?/gi,
  priceValue: /CHF\s*([\d'',.\s]+)/i,

  // Room patterns: 3.5 Zimmer, 4½ Zi., 2.5 rooms, etc.
  rooms: /(\d+[.,]?\d*)\s*(?:½\s*)?(?:Zimmer|Zi\.|rooms?)/i,
  roomsAlt: /(\d+[.,]?\d*)\s*(?:½\s*)?(?:pièces?|locali)/i,

  // Area patterns: 91 m², 120m2, 85 m2, etc.
  area: /(\d+(?:[.,]\d+)?)\s*m[²2]/gi,
  livingArea: /(?:Wohnfläche|Wohnfl\.|Living area|Surface habitable)\s*[:.]?\s*(\d+(?:[.,]\d+)?)\s*m[²2]/i,
  plotArea: /(?:Grundstückfläche|Grundstückfl\.|Plot area|Surface terrain|Grundstück)\s*[:.]?\s*(\d+(?:[.,]\d+)?)\s*m[²2]/i,

  // Swiss PLZ (postal code): 4 digits, typically 1000-9999
  plz: /\b([1-9]\d{3})\s+([A-ZÀ-Ž][a-zà-ž\-]+(?:\s+[a-zà-ž\-]+)*)\b/g,

  // Year built
  yearBuilt: /(?:Baujahr|Built|Année de construction|Anno di costruzione)\s*[:.]?\s*(\d{4})/i,

  // Floor
  floor: /(?:Stockwerk|Stock|Etage|Floor|OG|UG|EG)\s*[:.]?\s*(\d+|EG|UG)/i,

  // Availability
  availability: /(?:Bezug|Available|Disponible|Verfügbar)\s*[:.]?\s*(.+?)(?:\n|$)/i,

  // Reference/Object number
  referenceId: /(?:Objekt-?Nr\.|Ref\.|Reference|Referenz)\s*[:.]?\s*(\S+)/i,
};

/**
 * Parse a Swiss price string to a number.
 * "CHF 1'480'000" → 1480000
 * "CHF 2'500.–/Mt." → 2500
 */
function parsePrice(str) {
  if (!str) return null;
  const match = str.match(SwissPatterns.priceValue);
  if (!match) return null;
  const cleaned = match[1].replace(/['',\s]/g, "").replace(/\.–$/, "").replace(/\.$/, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse a room count string.
 * "3.5 Zimmer" → 3.5
 * "4½ Zi." → 4.5
 */
function parseRooms(str) {
  if (!str) return null;
  const match = str.match(SwissPatterns.rooms) || str.match(SwissPatterns.roomsAlt);
  if (!match) return null;
  let val = match[1].replace(",", ".");
  if (str.includes("½")) val = String(parseFloat(val) + 0.5);
  return parseFloat(val);
}

/**
 * Parse an area string in m².
 * "91 m²" → 91
 */
function parseArea(str) {
  if (!str) return null;
  const match = str.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/);
  if (!match) return null;
  return parseFloat(match[1].replace(",", "."));
}

/**
 * Extract address from text using Swiss PLZ pattern.
 * Returns { street, plz, city } or null.
 */
function extractAddress(text) {
  if (!text) return null;
  const match = text.match(SwissPatterns.plz);
  if (!match) return null;
  // Try to get street from context
  const plzMatch = text.match(/(.+?)\b([1-9]\d{3})\s+([A-ZÀ-Ž][a-zà-ž\-]+(?:\s+[a-zà-ž\-]+)*)/);
  if (plzMatch) {
    return {
      street: plzMatch[1].replace(/[,\n]+$/, "").trim(),
      plz: plzMatch[2],
      city: plzMatch[3].trim(),
    };
  }
  return null;
}

// ── Expose globally for other extractors ────────────────────────────────────

if (typeof window !== "undefined") {
  window.__chromeBridge = window.__chromeBridge || {};
  window.__chromeBridge.SwissPatterns = SwissPatterns;
  window.__chromeBridge.parsePrice = parsePrice;
  window.__chromeBridge.parseRooms = parseRooms;
  window.__chromeBridge.parseArea = parseArea;
  window.__chromeBridge.extractAddress = extractAddress;
}

// ── Exports for testing ─────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SwissPatterns, parsePrice, parseRooms, parseArea, extractAddress };
}
