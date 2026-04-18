#!/usr/bin/env node
/**
 * Navigate to a URL and extract page data via chrome-bridge extension.
 *
 * Usage: node nav-extract.js <url> [--wait <seconds>] [--token <token>]
 *
 * Sends navigate command, waits for page load, then extracts.
 * More robust than --url flag (doesn't depend on navigated response).
 */
const { WebSocketServer } = require("ws");
const { generateId } = require("./lib");

const PORT = 9223;
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith("http"));
const wait = parseInt(args[args.indexOf("--wait") + 1] || "5") * 1000;
const fs = require("fs");
const path = require("path");
const os = require("os");
const TOKEN_FILE = path.join(os.tmpdir(), "chatgpt-bridge-token");
let tokenFromFile = null;
try { tokenFromFile = fs.readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch {}
const tokenArg = args.indexOf("--token");
const token = (tokenArg >= 0 ? args[tokenArg + 1] : null) || process.env.CHATGPT_BRIDGE_TOKEN || tokenFromFile;
if (!token) {
  process.stderr.write("[nav] No auth token found. Provide --token or run 'chatgpt \"test\"' first.\n");
  process.exit(1);
}

if (!url) {
  process.stderr.write("Usage: node nav-extract.js <url> [--wait <seconds>] [--token <token>]\n");
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write("[nav] Port 9223 in use. Is another instance running?\n");
    process.exit(1);
  }
  throw err;
});

const connectTimeout = setTimeout(() => {
  process.stderr.write("[nav] Timed out waiting for extension.\n");
  wss.close();
  process.exit(1);
}, 15000);

wss.on("connection", (ws, req) => {
  const connUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (connUrl.searchParams.get("token") !== token) {
    ws.close(1008, "Invalid token");
    return;
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "hello") {
      clearTimeout(connectTimeout);
      process.stderr.write(`[nav] Connected. Navigating to ${url}\n`);

      // Send navigate command
      ws.send(JSON.stringify({ type: "navigate", url }));

      // Wait for page load (fixed delay — more reliable than waiting for navigated event)
      process.stderr.write(`[nav] Waiting ${wait/1000}s for page load...\n`);
      await new Promise(r => setTimeout(r, wait));

      // Send extract command with ID (required by extension)
      const id = generateId();
      process.stderr.write("[nav] Extracting...\n");
      ws.send(JSON.stringify({ type: "extract_page", id }));

      // Timeout for extract response
      setTimeout(() => {
        process.stderr.write("[nav] Extract response timeout.\n");
        wss.close();
        process.exit(1);
      }, 30000);
    }

    if (msg.type === "page_data") {
      process.stdout.write(JSON.stringify(msg.data, null, 2));
      process.stderr.write("[nav] Done.\n");
      wss.close();
      process.exit(0);
    }
  });
});
