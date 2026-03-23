const { SwissPatterns, parsePrice, parseRooms, parseArea, extractAddress } = require("../extractors/shared");

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
  });
});
