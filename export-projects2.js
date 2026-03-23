#!/usr/bin/env node
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = 9223;
const token = fs.readFileSync(path.join(os.tmpdir(), "chatgpt-bridge-token"), "utf8").trim();
const BASE = "https://chatgpt.com/backend-api";
const OUT = path.join(os.homedir(), "Downloads/chatgpt/personal/projects");

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

function sanitize(s) {
  return (s || "untitled").replace(/[/\\:*?"<>|]/g, "_").trim().slice(0, 80);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Simple sequential fetch: send one request, wait for its response
function doFetch(ws, url) {
  return new Promise((resolve, reject) => {
    const fid = "f" + Date.now() + crypto.randomBytes(2).toString("hex");
    const to = setTimeout(() => { reject(new Error("timeout")); }, 60000);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "fetch_response" && msg.id === fid) {
        clearTimeout(to);
        ws.removeListener("message", handler);
        resolve(msg);
      }
    }
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "fetch_api", id: fid, url }));
  });
}

const wss = new WebSocketServer({ port: PORT });
setTimeout(() => process.exit(1), 600000);

console.error(`${PROJECTS.length} projects`);

let activeWs = null;

wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost:" + PORT);
  if (u.searchParams.get("token") !== token) { ws.close(); return; }

  // Track the active WebSocket — extension may reconnect
  activeWs = ws;

  ws.once("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "hello") return;
    // Only process on the first hello
    if (ws !== activeWs) return;
    console.error("Connected.\n");

    // Wait for content script to fully initialize
    await sleep(2000);

    let totalConvs = 0;

    for (let pi = 0; pi < PROJECTS.length; pi++) {
      const proj = PROJECTS[pi];

      // Conversations
      await sleep(300);
      const cr = await doFetch(ws, `${BASE}/gizmos/${proj.id}/conversations?offset=0&limit=100`);
      const convs = (cr.status === 200 && cr.data?.items) ? cr.data.items : [];

      // Metadata
      await sleep(300);
      const mr = await doFetch(ws, `${BASE}/gizmos/${proj.slug}`);
      const name = (mr.status === 200 && mr.data?.gizmo?.display?.name) || proj.slug;

      console.error(`[${pi + 1}/${PROJECTS.length}] ${name.padEnd(45)} ${convs.length} chats (conv status: ${cr.status})`);

      const dirName = sanitize(name);
      const projDir = path.join(OUT, dirName);
      fs.mkdirSync(path.join(projDir, "json"), { recursive: true });

      if (mr.status === 200) {
        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(mr.data, null, 2));
        const instructions = mr.data?.gizmo?.instructions || "(none)";
        fs.writeFileSync(path.join(projDir, "README.md"),
          `# ${name}\nProject ID: ${proj.id}\n\n## Instructions\n\n${instructions}\n`);
      }

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
        const jsonPath = path.join(projDir, "json", `${cslug}.json`);
        if (fs.existsSync(jsonPath)) continue;

        await sleep(500);
        try {
          const cvr = await doFetch(ws, `${BASE}/conversation/${c.id}`);
          if (cvr.status === 200) {
            fs.writeFileSync(jsonPath, JSON.stringify(cvr.data, null, 2));
            console.error(`  ${i + 1}/${convs.length} ${(c.title || "?").slice(0, 50)} OK`);
            totalConvs++;
          } else {
            console.error(`  ${i + 1}/${convs.length} HTTP ${cvr.status}`);
          }
        } catch (e) {
          console.error(`  ${i + 1}/${convs.length} FAILED: ${e.message}`);
        }
      }
    }

    console.error(`\nDone. ${totalConvs} project conversations exported to ${OUT}`);
    wss.close();
    process.exit(0);
  });
});
