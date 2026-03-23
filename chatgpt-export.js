#!/usr/bin/env node
/**
 * ChatGPT Conversation Exporter — downloads all conversations via the bridge.
 *
 * Uses the fetch_api command to call ChatGPT's internal backend API through
 * the browser session (no API keys needed).
 *
 * Downloads conversations as self-contained backups including:
 *   - Full conversation JSON (message tree, metadata, model info)
 *   - Uploaded files (PDFs, images, code files)
 *   - Generated images (DALL-E)
 *   - Code interpreter output files
 *   - Markdown rendering with local file references
 *
 * Usage:
 *   chatgpt-export                          # Export all to ./chatgpt-export/
 *   chatgpt-export -o ~/backup/chatgpt      # Custom output directory
 *   chatgpt-export --format both            # JSON + Markdown
 *   chatgpt-export --limit 10               # Only first 10 conversations
 *   chatgpt-export --after 2025-01-01       # Only conversations after date
 *   chatgpt-export --no-files               # Skip file downloads
 */

const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ── Constants ────────────────────────────────────────────────────────────────

const PORT = 9223;
const CONNECT_TIMEOUT = 15_000;
const TOKEN_FILE = path.join(os.tmpdir(), "chatgpt-bridge-token");
const API_BASE = "https://chatgpt.com/backend-api";
const PAGE_SIZE = 100;
const DELAY_BETWEEN_REQUESTS = 500;  // ms between API calls
const DELAY_BETWEEN_FILES = 300;     // ms between file downloads
const MAX_RETRIES = 3;
const BACKOFF_BASE = 2000;           // ms, doubles each retry

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseExportArgs(argv) {
  let outputDir = "./chatgpt-export";
  let format = "both";
  let limit = Infinity;
  let after = null;
  let token = null;
  let noFiles = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") outputDir = argv[++i];
    else if (arg === "--format") format = argv[++i];
    else if (arg === "--limit") limit = parseInt(argv[++i]);
    else if (arg === "--after") after = argv[++i];
    else if (arg === "--token") token = argv[++i];
    else if (arg === "--no-files") noFiles = true;
    else if (arg === "-h" || arg === "--help") return { help: true };
  }
  return { outputDir, format, limit, after, token, noFiles };
}

function printHelp() {
  process.stderr.write(`
ChatGPT Conversation Exporter

Usage: chatgpt-export [options]

Options:
  -o, --output <dir>    Output directory (default: ./chatgpt-export)
  --format <type>       Output format: json, md, or both (default: both)
  --limit <n>           Only export first N conversations
  --after <date>        Only conversations after YYYY-MM-DD
  --no-files            Skip downloading attached/generated files
  --token <value>       Auth token (default: from token file)
  -h, --help            Show this help

Output structure:
  chatgpt-export/
    index.json                              # Conversation list
    json/                                   # Raw API responses
      2026-03-20_My Chat_abc12345.json
    md/                                     # Readable Markdown
      2026-03-20_My Chat_abc12345.md
    files/                                  # Downloaded files/images
      abc12345/
        uploaded_document.pdf
        dalle_image_001.png

Examples:
  chatgpt-export
  chatgpt-export -o ~/backup/chats --format both
  chatgpt-export --limit 50 --after 2025-01-01
  chatgpt-export --no-files --format json
`);
}

// ── WebSocket helpers ────────────────────────────────────────────────────────

function fetchApi(ws, url, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const id = "fetch-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex");
    const timeout = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Fetch timeout: ${url}`));
    }, 60_000);

    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "fetch_response" && msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (msg.error) reject(new Error(msg.error));
        else if (msg.status >= 400) reject(new Error(`HTTP ${msg.status}: ${JSON.stringify(msg.data).slice(0, 200)}`));
        else resolve(msg.data);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "fetch_api", id, url, method, body }));
  });
}

function fetchBinary(ws, url) {
  return new Promise((resolve, reject) => {
    const id = "fetch-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex");
    const timeout = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Binary fetch timeout: ${url}`));
    }, 60_000);

    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "fetch_response" && msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (msg.error) reject(new Error(msg.error));
        else if (msg.status >= 400) reject(new Error(`HTTP ${msg.status}`));
        else resolve({ data: msg.data, contentType: msg.contentType || "" });
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "fetch_api", id, url, method: "GET", binary: true }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchApiWithRetry(ws, url, method = "GET", body = null) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchApi(ws, url, method, body);
    } catch (err) {
      const isRateLimit = err.message.includes("429") || err.message.includes("rate");
      const isRetryable = isRateLimit || err.message.includes("timeout");
      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const wait = BACKOFF_BASE * Math.pow(2, attempt);
        process.stderr.write(`\n  [retry ${attempt + 1}/${MAX_RETRIES}] ${isRateLimit ? "rate limited" : "timeout"}, waiting ${(wait / 1000).toFixed(0)}s...`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// ── File extraction from conversations ───────────────────────────────────────

/**
 * Extract all downloadable file references from a conversation.
 * Returns array of { fileId, filename, downloadUrl, type }
 */
function extractFileReferences(conv) {
  const files = [];
  const seen = new Set();
  const mapping = conv.mapping || {};

  for (const node of Object.values(mapping)) {
    const msg = node.message;
    if (!msg) continue;

    // 1. User-uploaded files (in message metadata)
    const attachments = msg.metadata?.attachments || [];
    for (const att of attachments) {
      const fileId = att.id || att.file_id;
      if (!fileId || seen.has(fileId)) continue;
      seen.add(fileId);
      files.push({
        fileId,
        filename: att.name || att.filename || `file_${fileId}`,
        type: "upload",
        mimeType: att.mime_type || att.mimeType || "",
        size: att.size || 0,
      });
    }

    // 2. Content parts that are objects (images, files)
    const parts = msg.content?.parts || [];
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;

      // DALL-E generated images
      if (part.asset_pointer && part.asset_pointer.startsWith("file-service://")) {
        const fileId = part.asset_pointer.replace("file-service://", "");
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        files.push({
          fileId,
          filename: part.metadata?.dalle?.prompt
            ? sanitizeFilename(part.metadata.dalle.prompt.slice(0, 60)) + ".png"
            : `dalle_${fileId.slice(0, 8)}.png`,
          type: "dalle",
          mimeType: "image/png",
        });
      }

      // Code interpreter output files
      if (part.content_type === "real_time_user_action" || part.name) {
        // skip non-file parts
      }
    }

    // 3. Aggregate results / code interpreter outputs
    const aggResult = msg.metadata?.aggregate_result;
    if (aggResult?.messages) {
      for (const armsg of aggResult.messages) {
        if (armsg.message_type === "image" && armsg.image_url) {
          const fileId = armsg.image_url.replace("file-service://", "");
          if (seen.has(fileId)) continue;
          seen.add(fileId);
          files.push({
            fileId,
            filename: `code_output_${fileId.slice(0, 8)}.png`,
            type: "code_output",
            mimeType: "image/png",
          });
        }
      }
    }

    // 4. Citations with downloadable files
    const citations = msg.metadata?.citations || [];
    for (const cit of citations) {
      if (cit.metadata?.file_id) {
        const fileId = cit.metadata.file_id;
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        files.push({
          fileId,
          filename: cit.metadata.filename || cit.metadata.title || `cited_${fileId.slice(0, 8)}`,
          type: "citation",
          mimeType: cit.metadata.mime_type || "",
        });
      }
    }
  }

  return files;
}

/**
 * Download a file by its file-service ID.
 */
async function downloadFile(ws, fileId, destPath) {
  // Step 1: Get the download URL
  let downloadUrl;
  try {
    const meta = await fetchApi(ws, `${API_BASE}/files/${fileId}/download`);
    downloadUrl = meta.download_url || meta.url;
    if (!downloadUrl) throw new Error("No download URL in response");
  } catch (err) {
    // Some files use a different endpoint
    try {
      const meta = await fetchApi(ws, `${API_BASE}/files/${fileId}`);
      downloadUrl = meta.download_url || meta.url;
      if (!downloadUrl) throw new Error("No download URL");
    } catch {
      throw new Error(`Cannot get download URL for ${fileId}: ${err.message}`);
    }
  }

  // Step 2: Download the binary content
  const { data } = await fetchBinary(ws, downloadUrl);
  const buf = Buffer.from(data, "base64");
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// ── Conversation formatting ──────────────────────────────────────────────────

function conversationToMarkdown(conv, filesDir, convSlug) {
  const lines = [];
  const title = conv.title || "Untitled";
  let created = "unknown", updated = "";
  try { if (conv.create_time) {
    const t = typeof conv.create_time === "number" ? new Date(conv.create_time * 1000) : new Date(conv.create_time);
    if (!isNaN(t.getTime())) created = t.toISOString().slice(0, 19);
  }} catch {}
  try { if (conv.update_time) {
    const t = typeof conv.update_time === "number" ? new Date(conv.update_time * 1000) : new Date(conv.update_time);
    if (!isNaN(t.getTime())) updated = t.toISOString().slice(0, 19);
  }} catch {}
  const model = conv.default_model_slug || "unknown";
  const convId = conv.conversation_id || conv.id || "unknown";

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Date | ${created} |`);
  if (updated) lines.push(`| Updated | ${updated} |`);
  lines.push(`| Model | ${model} |`);
  lines.push(`| ID | \`${convId}\` |`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Build a map of fileId -> local filename for reference
  const fileMap = {};
  if (filesDir && convSlug) {
    const fileRefs = extractFileReferences(conv);
    for (const ref of fileRefs) {
      fileMap[ref.fileId] = `../files/${convSlug}/${ref.filename}`;
    }
  }

  // Walk the message tree — follow last child for the "active" path
  const mapping = conv.mapping || {};

  // Find root
  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent) { rootId = id; break; }
  }

  // DFS following the last child (active conversation path)
  const messageOrder = [];
  let currentId = rootId;
  while (currentId) {
    const node = mapping[currentId];
    if (!node) break;
    messageOrder.push(node);
    // Follow the last child (most recent edit/regeneration)
    if (node.children && node.children.length > 0) {
      currentId = node.children[node.children.length - 1];
    } else {
      currentId = null;
    }
  }

  for (const node of messageOrder) {
    const msg = node.message;
    if (!msg || !msg.content) continue;

    const role = msg.author?.role || "unknown";
    if (role === "system") continue;

    const parts = msg.content.parts || [];
    const textParts = [];

    // Build citation map from search_result_groups
    const citations = {};
    const srGroups = msg.metadata?.search_result_groups || [];
    for (const group of srGroups) {
      for (const entry of (group.entries || [])) {
        const url = entry.url || "";
        const title = entry.title || url;
        // Map all cite keys that reference this entry
        if (entry.cite_key) citations[entry.cite_key] = { url, title };
      }
    }

    for (const part of parts) {
      if (typeof part === "string") {
        let cleaned = part;
        // Strip image reference tokens wrapped in Unicode PUA chars
        // Raw format: \ue200i\ue202turn6image0\ue202turn6image3\ue201
        cleaned = cleaned.replace(/[\ue200-\ue2ff]?i?(?:[\ue200-\ue2ff]?turn\d+image\d+)+[\ue200-\ue2ff]?\s*/g, "");
        // Strip any remaining PUA characters
        cleaned = cleaned.replace(/[\ue200-\ue2ff]/g, "");
        // Strip inline citation markers (e.g., "citeturn3view0", "citeturn5search9")
        cleaned = cleaned.replace(/ ?cite(?:turn\d+(?:view|search)\d+)+/g, "");
        if (cleaned.trim()) textParts.push(cleaned);
      } else if (typeof part === "object" && part !== null) {
        // Image reference
        if (part.asset_pointer && part.asset_pointer.startsWith("file-service://")) {
          const fileId = part.asset_pointer.replace("file-service://", "");
          const localPath = fileMap[fileId];
          const caption = part.metadata?.dalle?.prompt || "image";
          if (localPath) {
            textParts.push(`![${caption}](${localPath})`);
          } else {
            textParts.push(`![${caption}](file-service://${fileId})`);
          }
        }
      }
    }

    const text = textParts.join("\n").trim();
    if (!text) continue;

    // Show attached files for user messages
    const attachments = msg.metadata?.attachments || [];
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "tool" ? "Tool" : role;
    let timestamp = "";
    try { if (msg.create_time) {
      const t = typeof msg.create_time === "number" ? new Date(msg.create_time * 1000) : new Date(msg.create_time);
      if (!isNaN(t.getTime())) timestamp = t.toLocaleString();
    }} catch {}

    lines.push(`### ${label}${timestamp ? ` _(${timestamp})_` : ""}`);
    lines.push("");

    if (attachments.length > 0) {
      lines.push("_Attachments:_");
      for (const att of attachments) {
        const fileId = att.id || att.file_id || "";
        const name = att.name || att.filename || "file";
        const localPath = fileMap[fileId];
        if (localPath) {
          lines.push(`- [${name}](${localPath})`);
        } else {
          lines.push(`- ${name}`);
        }
      }
      lines.push("");
    }

    lines.push(text);

    // Append sources from web search results
    if (srGroups.length > 0 && role === "assistant") {
      const seenUrls = new Set();
      const sources = [];
      for (const group of srGroups) {
        for (const entry of (group.entries || [])) {
          if (entry.url && !seenUrls.has(entry.url)) {
            seenUrls.add(entry.url);
            sources.push({ url: entry.url, title: entry.title || entry.url });
          }
        }
      }
      if (sources.length > 0) {
        lines.push("");
        lines.push("<details><summary>Sources</summary>");
        lines.push("");
        for (const s of sources) {
          lines.push(`- [${s.title}](${s.url})`);
        }
        lines.push("</details>");
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function sanitizeFilename(name) {
  return (name || "untitled")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseExportArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }

  const { outputDir, format, limit, after, noFiles } = opts;

  // Resolve token
  let existingToken = null;
  try { existingToken = fs.readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch {}
  const token = opts.token || process.env.CHATGPT_BRIDGE_TOKEN || existingToken;
  if (!token) {
    process.stderr.write("[export] No auth token found. Run 'chatgpt \"test\"' first to set one.\n");
    process.exit(1);
  }

  // Create output directories
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonDir = path.join(outputDir, "json");
  const mdDir = path.join(outputDir, "md");
  const filesDir = path.join(outputDir, "files");
  if (format === "json" || format === "both") fs.mkdirSync(jsonDir, { recursive: true });
  if (format === "md" || format === "both") fs.mkdirSync(mdDir, { recursive: true });
  if (!noFiles) fs.mkdirSync(filesDir, { recursive: true });

  process.stderr.write(`[export] Output:    ${outputDir}\n`);
  process.stderr.write(`[export] Format:    ${format}\n`);
  process.stderr.write(`[export] Files:     ${noFiles ? "skip" : "download"}\n\n`);

  // Start WebSocket server
  const wss = new WebSocketServer({ port: PORT });
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`[export] Port ${PORT} in use. Is another chatgpt instance running?\n`);
      process.exit(1);
    }
    throw err;
  });

  process.stderr.write(`[export] Waiting for extension on ws://localhost:${PORT}...\n`);

  const connectTimer = setTimeout(() => {
    process.stderr.write("[export] Timed out waiting for extension.\n");
    wss.close();
    process.exit(1);
  }, CONNECT_TIMEOUT);

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const clientToken = url.searchParams.get("token");
    if (clientToken !== token) {
      process.stderr.write("[export] Rejected: invalid token\n");
      ws.close(1008, "Invalid token");
      return;
    }

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "hello" && msg.client === "chatgpt-bridge") {
        clearTimeout(connectTimer);
        process.stderr.write("[export] Extension connected.\n\n");

        try {
          await runExport(ws, { outputDir, jsonDir, mdDir, filesDir, format, limit, after, noFiles });
        } catch (err) {
          process.stderr.write(`\n[export] Fatal error: ${err.message}\n`);
          if (err.stack) process.stderr.write(err.stack + "\n");
        }
        wss.close();
        process.exit(0);
      }
    });
  });
}

async function runExport(ws, opts) {
  const { jsonDir, mdDir, filesDir, format, limit, after, noFiles } = opts;
  const afterTs = after ? new Date(after).getTime() / 1000 : null;

  // Phase 1: List all conversations
  process.stderr.write("[export] Fetching conversation list...\n");

  let allConversations = [];
  let offset = 0;
  let total = null;

  while (true) {
    const url = `${API_BASE}/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`;
    let data;
    try {
      data = await fetchApiWithRetry(ws, url);
    } catch (err) {
      process.stderr.write(`[export] Error at offset ${offset}: ${err.message}\n`);
      break;
    }

    if (total === null) {
      total = data.total || "unknown";
      process.stderr.write(`[export] Total conversations on server: ${total}\n`);
    }

    const items = data.items || [];
    if (items.length === 0) break;

    for (const item of items) {
      if (afterTs && item.create_time && item.create_time < afterTs) continue;
      allConversations.push(item);
    }

    offset += items.length;
    process.stderr.write(`[export] Listed ${offset}...\r`);

    if (allConversations.length >= limit) {
      allConversations = allConversations.slice(0, limit);
      break;
    }

    if (items.length < PAGE_SIZE) break;
    await sleep(DELAY_BETWEEN_REQUESTS);
  }

  process.stderr.write(`\n[export] Exporting ${allConversations.length} conversations.\n\n`);

  // Save index
  const indexPath = path.join(opts.outputDir, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify(allConversations, null, 2));

  // Phase 2: Download each conversation + files
  let downloaded = 0;
  let failed = 0;
  let totalFiles = 0;
  let failedFiles = 0;

  for (let i = 0; i < allConversations.length; i++) {
    const item = allConversations[i];
    const convId = item.id;
    const title = item.title || "Untitled";
    let created = "unknown";
    try {
      if (item.create_time) {
        // create_time can be Unix timestamp (number) or ISO string
        const t = typeof item.create_time === "number"
          ? new Date(item.create_time * 1000)
          : new Date(item.create_time);
        if (!isNaN(t.getTime())) created = t.toISOString().slice(0, 10);
      }
    } catch {}
    const convSlug = `${created}_${sanitizeFilename(title)}_${convId.slice(0, 8)}`;

    process.stderr.write(`[${i + 1}/${allConversations.length}] ${title.slice(0, 55).padEnd(55)}  `);

    // Check cache — any existing output means we already downloaded this
    const jsonPath = path.join(jsonDir, `${convSlug}.json`);
    const mdPath = path.join(mdDir, `${convSlug}.md`);
    const cachedJson = fs.existsSync(jsonPath);
    const cachedMd = fs.existsSync(mdPath);
    if ((format === "json" && cachedJson) ||
        (format === "md" && cachedMd) ||
        (format === "both" && cachedJson && cachedMd)) {
      process.stderr.write("(cached)\n");
      downloaded++;
      continue;
    }

    let conv;
    try {
      conv = await fetchApiWithRetry(ws, `${API_BASE}/conversation/${convId}`);
    } catch (err) {
      failed++;
      process.stderr.write(`FAILED: ${err.message}\n`);
      await sleep(DELAY_BETWEEN_REQUESTS);
      continue;
    }

    // Save JSON
    if (format === "json" || format === "both") {
      fs.writeFileSync(jsonPath, JSON.stringify(conv, null, 2));
    }

    // Download files
    let fileCount = 0;
    if (!noFiles) {
      const fileRefs = extractFileReferences(conv);
      if (fileRefs.length > 0) {
        const convFilesDir = path.join(filesDir, convSlug);
        fs.mkdirSync(convFilesDir, { recursive: true });

        // Deduplicate filenames before downloading
        const usedNames = new Set();
        for (const ref of fileRefs) {
          let name = ref.filename;
          if (usedNames.has(name)) {
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            let n = 2;
            while (usedNames.has(`${base}_${n}${ext}`)) n++;
            name = `${base}_${n}${ext}`;
            ref.filename = name; // update so markdown links match
          }
          usedNames.add(name);
        }

        for (const ref of fileRefs) {
          const destPath = path.join(convFilesDir, ref.filename);
          if (fs.existsSync(destPath)) { fileCount++; continue; }

          try {
            await downloadFile(ws, ref.fileId, destPath);
            fileCount++;
            totalFiles++;
          } catch {
            failedFiles++;
          }
          await sleep(DELAY_BETWEEN_FILES);
        }
      }
    }

    // Save Markdown
    if (format === "md" || format === "both") {
      const md = conversationToMarkdown(conv, filesDir, convSlug);
      fs.writeFileSync(mdPath, md);
    }

    downloaded++;
    const fileSuffix = fileCount > 0 ? ` +${fileCount} files` : "";
    process.stderr.write(`OK${fileSuffix}\n`);
    await sleep(DELAY_BETWEEN_REQUESTS);
  }

  // Summary
  process.stderr.write(`\n${"=".repeat(50)}\n`);
  process.stderr.write(`Export complete\n`);
  process.stderr.write(`  Conversations: ${downloaded} downloaded, ${failed} failed\n`);
  if (!noFiles) {
    process.stderr.write(`  Files:         ${totalFiles} downloaded, ${failedFiles} failed\n`);
  }
  process.stderr.write(`  Output:        ${opts.outputDir}\n`);
  process.stderr.write(`${"=".repeat(50)}\n`);
}

if (require.main === module) {
  main();
}
