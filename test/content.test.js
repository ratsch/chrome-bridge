/**
 * @jest-environment jsdom
 */

// Mock chrome APIs before requiring content.js
global.chrome = {
  runtime: {
    sendMessage: jest.fn((msg, cb) => { if (cb) cb(); }),
    onMessage: { addListener: jest.fn() },
    lastError: null,
  },
};

const { genericExtract } = require("../content");

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  // Reset extractors
  if (window.__chromeBridge) {
    window.__chromeBridge.extractors = {};
  }
});

// ── genericExtract ──────────────────────────────────────────────────────────

describe("genericExtract", () => {
  test("returns basic page structure", () => {
    document.title = "Test Page";
    document.body.textContent = "Hello world";

    const result = genericExtract();
    expect(result.type).toBe("page");
    expect(result.title).toBe("Test Page");
    expect(result.raw_text).toContain("Hello world");
    expect(result.json_ld).toEqual([]);
    expect(result.meta).toBeDefined();
  });

  test("extracts JSON-LD", () => {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.textContent = JSON.stringify({ "@type": "Product", "name": "Test" });
    document.head.appendChild(script);

    const result = genericExtract();
    expect(result.json_ld).toHaveLength(1);
    expect(result.json_ld[0]["@type"]).toBe("Product");
  });

  test("extracts OpenGraph meta tags", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:title");
    meta.setAttribute("content", "OG Title");
    document.head.appendChild(meta);

    const result = genericExtract();
    expect(result.meta.title).toBe("OG Title");
  });

  test("extracts image URLs", () => {
    const img = document.createElement("img");
    img.src = "https://example.com/photo.jpg";
    document.body.appendChild(img);

    const result = genericExtract();
    expect(result.photos).toContain("https://example.com/photo.jpg");
  });

  test("truncates raw_text to 10000 chars", () => {
    document.body.textContent = "x".repeat(20000);

    const result = genericExtract();
    expect(result.raw_text.length).toBe(10000);
  });

  test("handles empty page", () => {
    const result = genericExtract();
    expect(result.type).toBe("page");
    expect(result.json_ld).toEqual([]);
  });
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

describe("dispatcher", () => {
  test("__chromeBridge registry is initialized", () => {
    expect(window.__chromeBridge).toBeDefined();
    expect(window.__chromeBridge.extractors).toBeDefined();
    expect(typeof window.__chromeBridge.safeSend).toBe("function");
  });

  test("safeSend forwards to chrome.runtime.sendMessage", () => {
    chrome.runtime.sendMessage.mockClear();
    window.__chromeBridge.safeSend({ type: "test", data: "hello" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "test", data: "hello" },
      expect.any(Function)
    );
  });
});
