const path = require("path");
const fs = require("fs");
const os = require("os");
const { parseArgs, buildPrompt, expandOutput, readFile, generateId, generateToken } = require("../lib");

// ── parseArgs ────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("prompt only", () => {
    const r = parseArgs(["Hello world"]);
    expect(r.promptText).toBe("Hello world");
    expect(r.files).toEqual([]);
    expect(r.batch).toBe(false);
    expect(r.token).toBeNull();
  });

  test("-f flag with single file", () => {
    const r = parseArgs(["-f", "code.py", "Review this"]);
    expect(r.files).toEqual(["code.py"]);
    expect(r.promptText).toBe("Review this");
  });

  test("multiple -f flags", () => {
    const r = parseArgs(["-f", "a.py", "-f", "b.py", "Review"]);
    expect(r.files).toEqual(["a.py", "b.py"]);
    expect(r.promptText).toBe("Review");
  });

  test("positional files before prompt", () => {
    const r = parseArgs(["a.py", "b.py", "Review"]);
    expect(r.files).toEqual(["a.py", "b.py"]);
    expect(r.promptText).toBe("Review");
  });

  test("mixed -f and positional", () => {
    const r = parseArgs(["-f", "a.py", "b.py", "Review"]);
    expect(r.files).toEqual(["a.py", "b.py"]);
    expect(r.promptText).toBe("Review");
  });

  test("-b batch flag", () => {
    const r = parseArgs(["-b", "-f", "a.py", "Prompt"]);
    expect(r.batch).toBe(true);
  });

  test("-o output pattern", () => {
    const r = parseArgs(["-o", "{name}.out", "-f", "a.py", "Prompt"]);
    expect(r.outputPattern).toBe("{name}.out");
  });

  test("-t timeout in seconds", () => {
    const r = parseArgs(["-t", "30", "Prompt"]);
    expect(r.timeout).toBe(30000);
  });

  test("--token flag", () => {
    const r = parseArgs(["--token", "abc123", "Prompt"]);
    expect(r.token).toBe("abc123");
    expect(r.promptText).toBe("Prompt");
  });

  test("-h returns help flag", () => {
    const r = parseArgs(["-h"]);
    expect(r.help).toBe(true);
  });

  test("--help returns help flag", () => {
    const r = parseArgs(["--help"]);
    expect(r.help).toBe(true);
  });

  test("no args returns nulls", () => {
    const r = parseArgs([]);
    expect(r.promptText).toBeNull();
    expect(r.files).toEqual([]);
    expect(r.batch).toBe(false);
    expect(r.token).toBeNull();
  });

  test("long flags work", () => {
    const r = parseArgs(["--file", "x.py", "--batch", "--output", "{name}.md", "--timeout", "60", "Go"]);
    expect(r.files).toEqual(["x.py"]);
    expect(r.batch).toBe(true);
    expect(r.outputPattern).toBe("{name}.md");
    expect(r.timeout).toBe(60000);
    expect(r.promptText).toBe("Go");
  });

  test("default timeout is 60 minutes", () => {
    const r = parseArgs(["Prompt"]);
    expect(r.timeout).toBe(3600000);
  });
});

// ── buildPrompt ──────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("prompt only", () => {
    expect(buildPrompt("Hello", [])).toBe("Hello");
  });

  test("single file + prompt", () => {
    const result = buildPrompt("Review", [{ name: "a.py", content: "print(1)" }]);
    expect(result).toContain("[file: a.py]");
    expect(result).toContain("print(1)");
    expect(result).toContain("[end file]");
    expect(result).toContain("Review");
  });

  test("multiple files", () => {
    const result = buildPrompt("Review", [
      { name: "a.py", content: "aaa" },
      { name: "b.py", content: "bbb" },
    ]);
    expect(result).toContain("[file: a.py]");
    expect(result).toContain("[file: b.py]");
    expect(result).toContain("aaa");
    expect(result).toContain("bbb");
  });

  test("files appear before prompt", () => {
    const result = buildPrompt("Review", [{ name: "a.py", content: "code" }]);
    const fileIdx = result.indexOf("[file: a.py]");
    const promptIdx = result.indexOf("Review");
    expect(fileIdx).toBeLessThan(promptIdx);
  });

  test("no prompt, just files", () => {
    const result = buildPrompt(null, [{ name: "a.py", content: "code" }]);
    expect(result).toContain("[file: a.py]");
    expect(result).not.toContain("null");
  });

  test("no files, no prompt returns empty", () => {
    expect(buildPrompt(null, [])).toBe("");
  });
});

// ── expandOutput ─────────────────────────────────────────────────────────────

describe("expandOutput", () => {
  test("{name} replacement", () => {
    expect(expandOutput("{name}.out", "src/foo.py")).toBe(path.join("src", "foo.out"));
  });

  test("{ext} replacement (without dot)", () => {
    expect(expandOutput("{name}.{ext}", "src/foo.py")).toBe(path.join("src", "foo.py"));
  });

  test("{base} replacement", () => {
    expect(expandOutput("{base}.bak", "src/foo.py")).toBe(path.join("src", "foo.py.bak"));
  });

  test("complex pattern", () => {
    expect(expandOutput("{name}.documented.{ext}", "lib/bar.js"))
      .toBe(path.join("lib", "bar.documented.js"));
  });

  test("no extension", () => {
    expect(expandOutput("{name}.out", "Makefile")).toBe("Makefile.out");
  });

  test("preserves directory", () => {
    expect(expandOutput("{name}.txt", "/tmp/data/file.csv")).toBe("/tmp/data/file.txt");
  });
});

// ── readFile ─────────────────────────────────────────────────────────────────

describe("readFile", () => {
  test("reads existing file", () => {
    const tmp = path.join(os.tmpdir(), "chatgpt-bridge-test-" + Date.now());
    fs.writeFileSync(tmp, "hello world");
    try {
      expect(readFile(tmp)).toBe("hello world");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test("returns null for missing file", () => {
    expect(readFile("/nonexistent/path/file.txt")).toBeNull();
  });
});

// ── generateId ───────────────────────────────────────────────────────────────

describe("generateId", () => {
  test("starts with cli-", () => {
    expect(generateId()).toMatch(/^cli-/);
  });

  test("contains timestamp and random suffix", () => {
    expect(generateId()).toMatch(/^cli-\d+-[0-9a-f]{4}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ── generateToken ────────────────────────────────────────────────────────────

describe("generateToken", () => {
  test("returns 32-char hex string", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  test("generates unique tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});
