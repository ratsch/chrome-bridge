/**
 * Homegate.ch extractor — site-specific structured extraction.
 *
 * Parses Homegate listing pages into structured property data.
 * Homegate uses a React SPA with consistent text patterns in the rendered DOM.
 *
 * Relies on shared.js being loaded first for Swiss patterns.
 */

(function register() {
  const bridge = window.__chromeBridge = window.__chromeBridge || {};
  bridge.extractors = bridge.extractors || {};

  const parsePrice = bridge.parsePrice || (() => ({ price: null, known: false }));
  const parseRooms = bridge.parseRooms || (() => null);
  const parseArea = bridge.parseArea || (() => null);

  function extract() {
    const result = {
      type: "property_listing",
      source: "homegate.ch",
      url: window.location.href,
      data: {},
      raw_text: "",
      json_ld: [],
      meta: {},
      photos: [],
    };

    const data = result.data;

    // ── Title ─────────────────────────────────────────────────────────
    const ogTitle = document.querySelector('meta[property="og:title"]');
    data.title = ogTitle ? ogTitle.content : document.title;

    // ── Body text for pattern matching ────────────────────────────────
    const bodyText = document.body.innerText || "";
    result.raw_text = bodyText;

    // ── Price ─────────────────────────────────────────────────────────
    // Look for "Purchase price" / "Verkaufspreis" section
    const priceMatch = bodyText.match(/(?:Purchase price|Verkaufspreis|Kaufpreis)\s*[:\n]?\s*(CHF[\s\d'''\u2018\u2019.,]+|On request|Preis auf Anfrage|auf Anfrage)/i);
    if (priceMatch) {
      const priceText = priceMatch[1].trim();
      if (/on request|auf anfrage/i.test(priceText)) {
        data.price_chf = null;
        data.price_known = false;
      } else {
        const cleaned = priceText.replace(/[^0-9]/g, '');
        const price = parseInt(cleaned);
        if (price > 10000) {
          data.price_chf = price;
          data.price_known = true;
        }
      }
    }

    // ── Rooms ─────────────────────────────────────────────────────────
    const roomsMatch = bodyText.match(/(?:No\. of rooms|Zimmer|Rooms)\s*[:\n]?\s*([\d.½]+)/i);
    if (roomsMatch) {
      let rooms = roomsMatch[1].replace('½', '.5');
      data.rooms = parseFloat(rooms);
    }

    // ── Living area ──────────────────────────────────────────────────
    const areaMatch = bodyText.match(/(?:Floor space|Wohnfläche|Nutzfläche|Living space)\s*[:\n]?\s*(\d+)\s*m/i);
    if (areaMatch) {
      data.living_area_sqm = parseInt(areaMatch[1]);
    }

    // ── Year built ───────────────────────────────────────────────────
    const yearMatch = bodyText.match(/(?:Year built|Baujahr)\s*[:\n]?\s*(\d{4})/i);
    if (yearMatch) {
      data.year_built = parseInt(yearMatch[1]);
    }

    // ── Last renovation ──────────────────────────────────────────────
    const renoMatch = bodyText.match(/(?:Last refurbishment|Renovation|Letzte Renovation)\s*[:\n]?\s*(\d{4})/i);
    if (renoMatch) {
      data.last_renovation = parseInt(renoMatch[1]);
    }

    // ── Property type ────────────────────────────────────────────────
    const typeMatch = bodyText.match(/(?:Type|Objektart)\s*[:\n]?\s*(Apartment|Wohnung|House|Haus|Chalet|Villa|Einfamilienhaus|Mehrfamilienhaus|Flat|Maisonette|Loft|Attic|Studio|Penthouse)/i);
    if (typeMatch) {
      const raw = typeMatch[1].toLowerCase();
      if (['apartment', 'wohnung', 'flat', 'maisonette', 'loft', 'attic', 'studio', 'penthouse'].includes(raw)) {
        data.property_type = 'apartment';
      } else if (['house', 'haus', 'chalet', 'villa', 'einfamilienhaus'].includes(raw)) {
        data.property_type = 'single_family';
      } else if (['mehrfamilienhaus'].includes(raw)) {
        data.property_type = 'multi_family';
      } else {
        data.property_type = raw;
      }
    }

    // ── Floors ───────────────────────────────────────────────────────
    const floorsMatch = bodyText.match(/(?:Number of floors|Etagen|Geschosse)\s*[:\n]?\s*(\d+)/i);
    if (floorsMatch) data.floors = parseInt(floorsMatch[1]);

    // ── Bathrooms ────────────────────────────────────────────────────
    const bathMatch = bodyText.match(/(?:Number of bathrooms|Badezimmer|Bäder)\s*[:\n]?\s*(\d+)/i);
    if (bathMatch) data.bathrooms = parseInt(bathMatch[1]);

    // ── Floor (for apartments) ───────────────────────────────────────
    const floorMatch = bodyText.match(/(?:Floor|Etage|Stockwerk)\s*[:\n]?\s*(\d+)/i);
    if (floorMatch) data.floor = parseInt(floorMatch[1]);

    // ── Address + PLZ ────────────────────────────────────────────────
    // Homegate shows address in "Location" section
    const locMatch = bodyText.match(/(?:Location|Standort|Adresse)\s*\n?\s*([^\n]+(?:\d{4})\s+\w[^\n]*)/i);
    if (locMatch) {
      const locText = locMatch[1].trim();
      data.address = locText.split('\n')[0].trim();

      const plzMatch = locText.match(/(\d{4})\s+(\w+)/);
      if (plzMatch) {
        data.plz = plzMatch[1];
        data.municipality = plzMatch[2];
      }
    }

    // Fallback: try OG description
    if (!data.plz) {
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) {
        const descPlz = ogDesc.content.match(/(\d{4})\s+(\w+)/);
        if (descPlz) {
          data.plz = descPlz[1];
          data.municipality = descPlz[2];
        }
      }
    }

    // ── Available from ───────────────────────────────────────────────
    const availMatch = bodyText.match(/(?:Available from|Verfügbar ab)\s*[:\n]?\s*([^\n]+)/i);
    if (availMatch) data.available_from = availMatch[1].trim();

    // ── Parking ──────────────────────────────────────────────────────
    const parkMatch = bodyText.match(/(\d+)\s*(?:outdoor )?parking|(\d+)\s*(?:Garagen|Parkplä|Tiefgarage|Stellplä)/i);
    if (parkMatch) data.parking_spaces = parseInt(parkMatch[1] || parkMatch[2]);

    // ── Agent / Advertiser ───────────────────────────────────────────
    const advertiserMatch = bodyText.match(/(?:Advertiser|Anbieter)\s*\n\s*([^\n]+)/i);
    if (advertiserMatch) data.agent_company = advertiserMatch[1].trim();

    const contactMatch = bodyText.match(/(?:Contact|Kontakt)\s*\n\s*([^\n]+)/i);
    if (contactMatch) data.agent_name = contactMatch[1].trim();

    const phoneMatch = bodyText.match(/(\+41[\s\d]{9,15})/);
    if (phoneMatch) data.agent_phone = phoneMatch[1].trim();

    // ── Listing ID ───────────────────────────────────────────────────
    const idMatch = bodyText.match(/(?:Listing ID|Inserate-Nr)\s*\n?\s*(\d+)/i);
    if (idMatch) data.listing_id = idMatch[1];

    const refMatch = bodyText.match(/(?:Object ref|Referenz-Nr)\s*\.?\n?\s*([^\n]+)/i);
    if (refMatch) data.listing_ref = refMatch[1].trim();

    // ── Zweitwohnung / Erstwohnung ───────────────────────────────────
    const textLower = bodyText.toLowerCase();
    if (textLower.includes('erstwohnung') || textLower.includes('primary residence only')) {
      data.zweitwohnung_allowed = false;
    } else if (textLower.includes('zweitwohnung') || textLower.includes('ferienwohnung') || textLower.includes('second home') || textLower.includes('vacation')) {
      data.zweitwohnung_allowed = true;
    }

    // ── Heating ──────────────────────────────────────────────────────
    if (textLower.includes('ölheizung') || textLower.includes('heizöl') || textLower.includes('oil heating')) {
      data.heating_type = 'oil';
    } else if (textLower.includes('wärmepumpe') || textLower.includes('heat pump') || textLower.includes('erdsonde')) {
      data.heating_type = 'heat_pump';
    } else if (textLower.includes('gasheizung') || textLower.includes('gas heating')) {
      data.heating_type = 'gas';
    }

    // ── Features detection ───────────────────────────────────────────
    data.has_mountain_view = /bergblick|bergsicht|mountain view|panoram/i.test(bodyText) || undefined;
    data.has_lake_view = /seesicht|seeblick|lake view/i.test(bodyText) || undefined;
    data.has_garden = /garten|garden/i.test(bodyText) || undefined;
    data.has_balcony = /balkon|balcony|terrasse|terrace/i.test(bodyText) || undefined;
    data.has_fireplace = /cheminée|kamin|fireplace/i.test(bodyText) || undefined;
    data.has_elevator = /aufzug|lift|elevator/i.test(bodyText) || undefined;
    data.minergie = /minergie/i.test(bodyText) || undefined;

    // ── JSON-LD ──────────────────────────────────────────────────────
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const ld = JSON.parse(script.textContent);
        result.json_ld.push(ld);
      } catch {}
    }

    // ── OpenGraph meta ───────────────────────────────────────────────
    const ogTags = document.querySelectorAll('meta[property^="og:"]');
    for (const tag of ogTags) {
      const prop = tag.getAttribute('property').replace('og:', '');
      result.meta[prop] = tag.content;
    }

    // ── Photos ───────────────────────────────────────────────────────
    // Homegate listing photos are in media2.homegate.ch
    const imgs = document.querySelectorAll('img[src*="homegate.ch"]');
    for (const img of imgs) {
      const src = img.src;
      if (src.includes('/listings/') && !result.photos.includes(src)) {
        result.photos.push(src);
      }
    }
    // Also check OG image
    if (result.meta.image && !result.photos.includes(result.meta.image)) {
      result.photos.unshift(result.meta.image);
    }

    return result;
  }

  // Register with dispatcher
  bridge.extractors["www.homegate.ch"] = {
    extract: extract,
    handlers: {},
  };

  console.log("[chrome-bridge] Homegate extractor registered");
})();
