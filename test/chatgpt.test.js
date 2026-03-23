/**
 * @jest-environment jsdom
 */

// Mock chrome APIs before requiring chatgpt extractor
global.chrome = {
  runtime: {
    sendMessage: jest.fn((msg, cb) => { if (cb) cb(); }),
    onMessage: { addListener: jest.fn() },
    lastError: null,
  },
};

// Set up __chromeBridge registry (normally done by content.js which loads first)
window.__chromeBridge = {
  extractors: {},
  safeSend: jest.fn(() => true),
};

const { extractText, extractTextFinal, SELECTORS } = require("../extractors/chatgpt");

// jsdom's innerText only works on elements connected to the document.
function createElement(tag = "div") {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ── SELECTORS ────────────────────────────────────────────────────────────────

describe("SELECTORS", () => {
  test("has all required selectors", () => {
    expect(SELECTORS).toHaveProperty("input");
    expect(SELECTORS).toHaveProperty("sendButton");
    expect(SELECTORS).toHaveProperty("assistantMessage");
    expect(SELECTORS).toHaveProperty("streamingIndicator");
    expect(SELECTORS).toHaveProperty("stopButton");
    expect(SELECTORS).toHaveProperty("errorMessage");
  });

  test("selectors are valid CSS strings", () => {
    for (const [name, sel] of Object.entries(SELECTORS)) {
      expect(() => document.querySelector(sel)).not.toThrow();
    }
  });
});

// ── extractText ──────────────────────────────────────────────────────────────

describe("extractText", () => {
  test("extracts from .markdown container", () => {
    const el = createElement();
    const md = document.createElement("div");
    md.className = "markdown";
    md.textContent = "Hello world";
    el.appendChild(md);
    expect(extractText(el)).toBe("Hello world");
  });

  test("extracts from .prose container", () => {
    const el = createElement();
    const prose = document.createElement("div");
    prose.className = "prose";
    prose.textContent = "Prose text";
    el.appendChild(prose);
    expect(extractText(el)).toBe("Prose text");
  });

  test("prefers .markdown over direct innerText", () => {
    const el = createElement();
    const textNode = document.createTextNode("outer");
    el.appendChild(textNode);
    const md = document.createElement("div");
    md.className = "markdown";
    md.textContent = "inner markdown";
    el.appendChild(md);
    expect(extractText(el)).toBe("inner markdown");
  });

  test("falls back to direct innerText", () => {
    const el = createElement();
    el.textContent = "Direct text";
    expect(extractText(el)).toBe("Direct text");
  });

  test("returns empty for empty element", () => {
    const el = createElement();
    expect(extractText(el)).toBe("");
  });

  test("trims whitespace", () => {
    const el = createElement();
    el.textContent = "  spaced  ";
    expect(extractText(el)).toBe("spaced");
  });

  test("handles nested HTML in markdown", () => {
    const el = createElement();
    const md = document.createElement("div");
    md.className = "markdown";
    md.innerHTML = "<p>First paragraph</p><p>Second paragraph</p>";
    el.appendChild(md);
    const text = extractText(el);
    expect(text).toContain("First paragraph");
    expect(text).toContain("Second paragraph");
  });
});

// ── extractTextFinal ─────────────────────────────────────────────────────────

describe("extractTextFinal", () => {
  test("returns extractText result when available", () => {
    const el = createElement();
    el.textContent = "normal text";
    expect(extractTextFinal(el)).toBe("normal text");
  });

  test("returns empty for empty element", () => {
    const el = createElement();
    expect(extractTextFinal(el)).toBe("");
  });

  test("falls back to Selection API for hidden content", () => {
    const el = createElement();
    const result = extractTextFinal(el);
    expect(typeof result).toBe("string");
  });
});

// ── Extractor registration ──────────────────────────────────────────────────

describe("ChatGPT extractor registration", () => {
  test("registers in __chromeBridge.extractors", () => {
    const extractor = window.__chromeBridge.extractors["chatgpt.com"];
    expect(extractor).toBeDefined();
    expect(extractor.name).toBe("chatgpt");
  });

  test("has extract function", () => {
    const extractor = window.__chromeBridge.extractors["chatgpt.com"];
    expect(typeof extractor.extract).toBe("function");
  });

  test("has handlers for send_message, fetch_api, scrape_dom", () => {
    const extractor = window.__chromeBridge.extractors["chatgpt.com"];
    expect(typeof extractor.handlers.send_message).toBe("function");
    expect(typeof extractor.handlers.fetch_api).toBe("function");
    expect(typeof extractor.handlers.scrape_dom).toBe("function");
  });
});
