#!/usr/bin/env node
/**
 * ChatGPT CLI — send prompts to ChatGPT via the browser extension.
 *
 * Usage:
 *   chatgpt "What is the meaning of life?"
 *   chatgpt -f code.py "Review this code"
 *   cat file.txt | chatgpt "Summarize this"
 *   chatgpt -f src/*.py "Find bugs in these files"
 *   chatgpt -b -f *.py "Add docstrings to this file"
 *   chatgpt -b -o '{name}.out' -f *.py "Add docstrings"
 */

const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseArgs, buildPrompt, expandOutput, readFile, generateId, generateToken } = require("./lib");

// ── Constants ────────────────────────────────────────────────────────────────

const PORT = 9223;
const CONNECT_TIMEOUT = 15_000;
const TOKEN_FILE = path.join(os.tmpdir(), "chatgpt-bridge-token");

// ── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  process.stderr.write(`
Usage: chatgpt [options] "prompt"

Options:
  -f, --file <file>       Include file contents in the prompt (repeatable)
  -a, --attach <file>     Upload file to ChatGPT (PDF, images; repeatable)
  -b, --batch             Process each -f file as a separate request
  -o, --output <pattern>  Write batch results to files ({name}, {ext}, {base})
  -t, --timeout <secs>    Response timeout in seconds (default: 3600)
  --token <value>         Auth token (default: random, or CHATGPT_BRIDGE_TOKEN env)
  -h, --help              Show this help

Examples:
  chatgpt "What is the meaning of life?"
  chatgpt -f code.py "Review this code"
  cat file.txt | chatgpt "Summarize this"
  chatgpt -a scan.pdf "OCR this document and return JSON"
  chatgpt -b -o '{name}.documented.py' -f *.py "Add docstrings"
`);
}

// ── Read stdin ───────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data || null));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const { files, attachments, batch, outputPattern, timeout, promptText } = opts;
  const stdinData = await readStdin();

  // Validate we have something to send
  if (!promptText && files.length === 0 && attachments.length === 0 && !stdinData) {
    printHelp();
    process.exit(1);
  }

  // Resolve auth token: --token flag > env var > existing token file > random
  let existingFileToken = null;
  try { existingFileToken = fs.readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch {}
  const token = opts.token || process.env.CHATGPT_BRIDGE_TOKEN || existingFileToken || generateToken();

  // Write token to temp file (mode 0600) — persists for next run
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  process.stderr.write(`[cli] Auth token: ${token}\n`);

  // Build prompt(s)
  let prompts; // Array of { label, text, outputFile? }
  if (batch && files.length > 0) {
    prompts = files.map((f) => {
      const content = readFile(f);
      if (!content) return null;
      return {
        label: f,
        text: buildPrompt(promptText, [{ name: path.basename(f), content }]),
        outputFile: outputPattern ? expandOutput(outputPattern, f) : null,
      };
    }).filter(Boolean);
  } else {
    // Single prompt with all files + stdin
    const fileContents = [];
    if (stdinData) fileContents.push({ name: "stdin", content: stdinData });
    for (const f of files) {
      const content = readFile(f);
      if (content) fileContents.push({ name: path.basename(f), content });
    }
    prompts = [{ label: "query", text: buildPrompt(promptText, fileContents) }];
  }

  // Read binary attachments (for file upload to ChatGPT)
  const MIME_TYPES = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".tiff": "image/tiff", ".tif": "image/tiff", ".bmp": "image/bmp",
  };
  const attachmentData = [];
  for (const f of (attachments || [])) {
    try {
      const data = fs.readFileSync(f);
      const ext = path.extname(f).toLowerCase();
      attachmentData.push({
        name: path.basename(f),
        type: MIME_TYPES[ext] || "application/octet-stream",
        data: data.toString("base64"),
      });
      process.stderr.write(`[cli] Attaching: ${path.basename(f)} (${(data.length / 1024).toFixed(0)} KB)\n`);
    } catch (err) {
      process.stderr.write(`[cli] Warning: cannot read attachment ${f}: ${err.message}\n`);
    }
  }
  // Include attachments in all prompts
  if (attachmentData.length > 0) {
    for (const p of prompts) {
      p.attachments = attachmentData;
    }
  }

  if (prompts.length === 0) {
    process.stderr.write("[cli] No valid input to send.\n");
    process.exit(1);
  }

  // Start server
  const wss = new WebSocketServer({ port: PORT });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[cli] Error: Port ${PORT} is already in use.\n` +
        `[cli] Another chatgpt-bridge instance may be running.\n`
      );
      process.exit(1);
    }
    throw err;
  });

  process.stderr.write(`[cli] Waiting for extension on ws://localhost:${PORT}...\n`);

  const connectTimer = setTimeout(() => {
    process.stderr.write("[cli] Timed out waiting for extension. Is Chrome open with the extension loaded?\n");
    wss.close();
    process.exit(1);
  }, CONNECT_TIMEOUT);

  wss.on("connection", (ws, req) => {
    // Verify auth token from query string
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const clientToken = url.searchParams.get("token");
    if (clientToken !== token) {
      process.stderr.write("[cli] Rejected connection: invalid token\n");
      ws.close(1008, "Invalid token");
      return;
    }

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "hello" && msg.client === "chatgpt-bridge") {
        clearTimeout(connectTimer);
        process.stderr.write("[cli] Extension connected.\n");
        await processPrompts(ws, wss, prompts, timeout);
      }
    });
  });
}

async function processPrompts(ws, wss, prompts, timeout) {
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    if (prompts.length > 1) {
      process.stderr.write(`\n[cli] [${i + 1}/${prompts.length}] ${p.label}\n`);
    }

    try {
      const response = await sendAndWait(ws, p.text, timeout, p.attachments);
      if (p.outputFile) {
        fs.writeFileSync(p.outputFile, response);
        process.stderr.write(`[cli] Wrote ${p.outputFile}\n`);
      } else {
        process.stdout.write(response + "\n");
      }
    } catch (err) {
      process.stderr.write(`[cli] Error: ${err.message}\n`);
      if (prompts.length === 1) {
        wss.close();
        process.exit(1);
      }
    }
  }

  wss.close();
  process.exit(0);
}

function sendAndWait(ws, text, timeout, attachments) {
  return new Promise((resolve, reject) => {
    const id = generateId();

    const msg = { type: "send_message", id, text };
    if (attachments && attachments.length > 0) {
      msg.files = attachments;
      process.stderr.write(`[cli] Sending message with ${attachments.length} attachment(s)...\n`);
    } else {
      process.stderr.write("[cli] Sending message...\n");
    }
    ws.send(JSON.stringify(msg));

    const responseTimer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Response timeout"));
    }, timeout);

    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "stream_start") {
        process.stderr.write("[cli] ChatGPT is responding...\n");
      } else if (msg.type === "stream_delta") {
        process.stderr.write(msg.text);
      } else if (msg.type === "stream_done") {
        clearTimeout(responseTimer);
        ws.off("message", handler);
        process.stderr.write("\n");
        resolve(msg.text);
      } else if (msg.type === "error") {
        clearTimeout(responseTimer);
        ws.off("message", handler);
        reject(new Error(msg.error));
      }
    };

    ws.on("message", handler);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
