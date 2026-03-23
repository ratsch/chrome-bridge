#!/usr/bin/env node
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = 9223;
const TOKEN_FILE = path.join(os.tmpdir(), "chatgpt-bridge-token");
const BASE = "https://chatgpt.com/backend-api";
const OUT = path.join(os.homedir(), "Downloads/chatgpt/personal/projects");

const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const urls = fs.readFileSync(path.join(OUT, "project_urls.txt"), "utf8").trim().split("\n");

const seen = new Set();
const PROJECTS = [];
for (const u of urls) {
  const m = u.match(/g-p-([a-f0-9]{32})-([a-z0-9-]+)/);
  if (m) {
    const id = "g-p-" + m[1];
    const slug = id + "-" + m[2];
    if (!seen.has(id)) { seen.add(id); PROJECTS.push({ id, slug }); }
  }
}

function fetchApi(ws, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const fid = "f" + Date.now() + crypto.randomBytes(2).toString("hex");
    const to = setTimeout(() => { ws.off("message", h); reject(new Error("timeout: " + url)); }, 60000);
    const h = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "fetch_response" && msg.id === fid) {
        clearTimeout(to);
        ws.off("message", h);
        if (msg.error) reject(new Error(msg.error));
        else if (msg.status >= 400) reject(new Error("HTTP " + msg.status));
        else resolve(msg.data);
      }
    };
    ws.on("message", h);
    const payload = { type: "fetch_api", id: fid, url };
    if (opts.noAuth) payload.noAuth = true;
    console.error(`  [debug] sending ${fid} -> ${url.slice(0, 80)}`);
    ws.send(JSON.stringify(payload));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sanitize(s) {
  return (s || "untitled").replace(/[/\\:*?"<>|]/g, "_").trim().slice(0, 80);
}

const wss = new WebSocketServer({ port: PORT });
const timer = setTimeout(() => { process.exit(1); }, 600000);

console.error(`[projects] ${PROJECTS.length} projects to export`);
console.error(`[projects] Waiting for extension...`);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost:" + PORT);
  if (url.searchParams.get("token") !== token) { ws.close(); return; }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "hello") return;
    clearTimeout(timer);
    console.error("[projects] Connected.\n");

    let totalConvs = 0;

    for (let pi = 0; pi < PROJECTS.length; pi++) {
      const proj = PROJECTS[pi];

      // List conversations (no auth headers — gizmo endpoint rejects account-id)
      await sleep(500);
      let convs = [];
      const convUrl = BASE + "/gizmos/" + proj.id + "/conversations?offset=0&limit=100";
      try {
        const data = await fetchApi(ws, convUrl);
        convs = data.items || [];
      } catch (e) {
        console.error(`  Conv error: ${e.message}`);
      }

      // Get project metadata
      await sleep(300);
      let meta, name;
      try {
        meta = await fetchApi(ws, BASE + "/gizmos/" + proj.slug);
        name = meta.gizmo?.display?.name || proj.slug;
      } catch (e) {
        name = proj.slug;
      }

      const dirName = sanitize(name);
      const projDir = path.join(OUT, dirName);
      fs.mkdirSync(path.join(projDir, "json"), { recursive: true });
      if (meta) {
        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(meta, null, 2));
        const instructions = meta.gizmo?.instructions || "(none)";
        fs.writeFileSync(path.join(projDir, "README.md"),
          `# ${name}\nProject ID: ${proj.id}\n\n## Instructions\n\n${instructions}\n`);
      }

      console.error(`[${pi + 1}/${PROJECTS.length}] ${name.padEnd(45)} ${convs.length} chats`);

      // Download each conversation
      for (let i = 0; i < convs.length; i++) {
        const c = convs[i];
        let created = "unknown";
        try {
          if (c.create_time) {
            const t = new Date(c.create_time);
            if (!isNaN(t.getTime())) created = t.toISOString().slice(0, 10);
          }
        } catch {}

        const cslug = `${created}_${sanitize(c.title)}_${c.id.slice(0, 8)}`;
        const jsonPath = path.join(projDir, "json", cslug + ".json");
        if (fs.existsSync(jsonPath)) continue;

        try {
          const conv = await fetchApi(ws, BASE + "/conversation/" + c.id);
          fs.writeFileSync(jsonPath, JSON.stringify(conv, null, 2));
          console.error(`  ${i + 1}/${convs.length} ${(c.title || "?").slice(0, 50)} OK`);
          totalConvs++;
        } catch (e) {
          console.error(`  ${i + 1}/${convs.length} FAILED: ${e.message}`);
        }
        await sleep(500);
      }
      await sleep(500);
    }

    console.error(`\n${"=".repeat(50)}`);
    console.error(`Project conversations exported: ${totalConvs}`);
    console.error(`Output: ${OUT}`);
    console.error("=".repeat(50));
    wss.close();
    process.exit(0);
  });
});
