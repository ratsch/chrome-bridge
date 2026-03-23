const { SwissPatterns, parsePrice, parseRooms, parseArea, extractAddress, trimToListing } = require("../extractors/shared");

describe("parsePrice", () => {
  test("parses Swiss format with apostrophes", () => {
    expect(parsePrice("CHF 1'480'000")).toBe(1480000);
  });

  test("parses with commas", () => {
    expect(parsePrice("CHF 1,480,000")).toBe(1480000);
  });

  test("parses simple number", () => {
    expect(parsePrice("CHF 950000")).toBe(950000);
  });

  test("parses rental price", () => {
    expect(parsePrice("CHF 2'500.–/Mt.")).toBe(2500);
  });

  test("returns null for empty", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  test("returns null for non-price text", () => {
    expect(parsePrice("no price here")).toBeNull();
  });
});

describe("parseRooms", () => {
  test("parses 3.5 Zimmer", () => {
    expect(parseRooms("3.5 Zimmer")).toBe(3.5);
  });

  test("parses 4 Zi.", () => {
    expect(parseRooms("4 Zi.")).toBe(4);
  });

  test("parses French", () => {
    expect(parseRooms("5 pièces")).toBe(5);
  });

  test("returns null for non-room text", () => {
    expect(parseRooms("no rooms")).toBeNull();
  });
});

describe("parseArea", () => {
  test("parses m² format", () => {
    expect(parseArea("91 m²")).toBe(91);
  });

  test("parses m2 format", () => {
    expect(parseArea("120 m2")).toBe(120);
  });

  test("parses decimal area", () => {
    expect(parseArea("85.5 m²")).toBe(85.5);
  });

  test("returns null for non-area text", () => {
    expect(parseArea("no area")).toBeNull();
  });
});

describe("extractAddress", () => {
  test("extracts Swiss address", () => {
    const result = extractAddress("Bildweg 12, 7250 Klosters");
    expect(result).not.toBeNull();
    expect(result.plz).toBe("7250");
    expect(result.city).toBe("Klosters");
  });

  test("returns null for non-address", () => {
    expect(extractAddress("no address here")).toBeNull();
  });

  test("returns null for empty", () => {
    expect(extractAddress("")).toBeNull();
    expect(extractAddress(null)).toBeNull();
  });
});

describe("SwissPatterns", () => {
  test("price regex matches CHF amounts", () => {
    expect("CHF 1'200'000").toMatch(SwissPatterns.price);
    expect("CHF 2500").toMatch(SwissPatterns.price);
  });

  test("rooms regex matches Zimmer", () => {
    expect("3.5 Zimmer").toMatch(SwissPatterns.rooms);
    expect("4 Zi.").toMatch(SwissPatterns.rooms);
  });

  test("area regex matches m²", () => {
    expect("91 m²").toMatch(SwissPatterns.area);
    expect("120m2").toMatch(SwissPatterns.area);
  });

  test("yearBuilt regex matches year", () => {
    expect("Baujahr: 2009").toMatch(SwissPatterns.yearBuilt);
    expect("Built: 1985").toMatch(SwissPatterns.yearBuilt);
    expect("Year built:\n1773").toMatch(SwissPatterns.yearBuilt);
  });

  test("priceOnRequest matches common phrases", () => {
    expect("On request").toMatch(SwissPatterns.priceOnRequest);
    expect("Price on request").toMatch(SwissPatterns.priceOnRequest);
    expect("Auf Anfrage").toMatch(SwissPatterns.priceOnRequest);
    expect("Prix sur demande").toMatch(SwissPatterns.priceOnRequest);
  });
});

describe("trimToListing", () => {
  test("removes 'Other properties' section", () => {
    const listing = "x".repeat(300) + "\nPrice: CHF 500'000";
    const text = listing + "\n\nOther properties you might like\nCHF 3,800,000\n8.5 rooms";
    const trimmed = trimToListing(text);
    expect(trimmed).toContain("CHF 500'000");
    expect(trimmed).not.toContain("3,800,000");
  });

  test("removes 'Contact the advertiser' section", () => {
    const listing = "x".repeat(300) + "\nRooms: 5.5";
    const text = listing + "\n\nContact the advertiser\nFirst name\nMonthly household income\nBelow CHF 3,000";
    const trimmed = trimToListing(text);
    expect(trimmed).toContain("Rooms: 5.5");
    expect(trimmed).not.toContain("CHF 3,000");
  });

  test("preserves text when no cut markers found", () => {
    const text = "Simple listing without recommendations";
    expect(trimToListing(text)).toBe(text);
  });
});
