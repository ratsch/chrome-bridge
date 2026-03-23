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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sanitize(s) { return (s || "untitled").replace(/[/\\:*?"<>|]/g, "_").trim().slice(0, 80); }

const wss = new WebSocketServer({ port: PORT });
setTimeout(() => process.exit(1), 600000);
console.error(PROJECTS.length + " projects");

let started = false;
wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost:" + PORT);
  if (u.searchParams.get("token") !== token) { ws.close(); return; }
  console.error("WS connection, readyState=" + ws.readyState);

  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "hello") return;
    if (started) { console.error("Duplicate hello, ignoring"); return; }
    started = true;
    console.error("Connected. readyState=" + ws.readyState + "\n");
    await sleep(1000);

    let totalConvs = 0;

    // Phase 1: List conversations for all projects
    const projectData = [];
    for (let i = 0; i < PROJECTS.length; i++) {
      const proj = PROJECTS[i];
      const fid = "f" + Date.now() + crypto.randomBytes(2).toString("hex");
      const convUrl = BASE + "/gizmos/" + proj.id + "/conversations?offset=0&limit=50";

      const cr = await new Promise((resolve) => {
        function h(raw2) {
          let r;
          try { r = JSON.parse(raw2); } catch { return; }
          if (r.type === "fetch_response" && r.id === fid) {
            ws.removeListener("message", h);
            resolve(r);
          }
        }
        ws.on("message", h);
        ws.send(JSON.stringify({ type: "fetch_api", id: fid, url: convUrl }));
      });

      const items = (cr.status === 200 && cr.data && cr.data.items) ? cr.data.items : [];
      projectData.push({ proj, items });
      if (cr.status !== 200) console.error("  Response: " + JSON.stringify(cr.data).slice(0, 200));
      console.error("[" + (i + 1) + "/" + PROJECTS.length + "] " + proj.slug.slice(38).padEnd(42) + items.length + " chats (HTTP " + cr.status + ")");
      await sleep(300);
    }

    // Phase 2: Fetch metadata + download conversations
    console.error("\nDownloading...\n");
    for (const { proj, items } of projectData) {
      // Metadata
      const mfid = "m" + Date.now() + crypto.randomBytes(2).toString("hex");
      const mr = await new Promise((resolve) => {
        function h(raw2) {
          let r;
          try { r = JSON.parse(raw2); } catch { return; }
          if (r.type === "fetch_response" && r.id === mfid) {
            ws.removeListener("message", h);
            resolve(r);
          }
        }
        ws.on("message", h);
        ws.send(JSON.stringify({ type: "fetch_api", id: mfid, url: BASE + "/gizmos/" + proj.slug }));
      });

      const name = (mr.status === 200 && mr.data && mr.data.gizmo && mr.data.gizmo.display)
        ? mr.data.gizmo.display.name : proj.slug;
      const dirName = sanitize(name);
      const projDir = path.join(OUT, dirName);
      fs.mkdirSync(path.join(projDir, "json"), { recursive: true });

      if (mr.status === 200) {
        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(mr.data, null, 2));
        const inst = (mr.data.gizmo && mr.data.gizmo.instructions) || "(none)";
        fs.writeFileSync(path.join(projDir, "README.md"),
          "# " + name + "\nProject ID: " + proj.id + "\n\n## Instructions\n\n" + inst + "\n");
      }

      // Download conversations
      for (let ci = 0; ci < items.length; ci++) {
        const c = items[ci];
        let created = "unknown";
        try {
          if (c.create_time) {
            const t = new Date(c.create_time);
            if (!isNaN(t.getTime())) created = t.toISOString().slice(0, 10);
          }
        } catch {}
        const cslug = created + "_" + sanitize(c.title) + "_" + c.id.slice(0, 8);
        const jsonPath = path.join(projDir, "json", cslug + ".json");
        if (fs.existsSync(jsonPath)) continue;

        await sleep(500);
        const cfid = "c" + Date.now() + crypto.randomBytes(2).toString("hex");
        const cvr = await new Promise((resolve) => {
          function h(raw2) {
            let r;
            try { r = JSON.parse(raw2); } catch { return; }
            if (r.type === "fetch_response" && r.id === cfid) {
              ws.removeListener("message", h);
              resolve(r);
            }
          }
          ws.on("message", h);
          ws.send(JSON.stringify({ type: "fetch_api", id: cfid, url: BASE + "/conversation/" + c.id }));
        });

        if (cvr.status === 200) {
          fs.writeFileSync(jsonPath, JSON.stringify(cvr.data, null, 2));
          console.error("  " + (c.title || "?").slice(0, 50) + " OK");
          totalConvs++;
        } else {
          console.error("  " + (c.title || "?").slice(0, 50) + " HTTP " + cvr.status);
        }
      }
      await sleep(300);
    }

    console.error("\n" + "=".repeat(50));
    console.error("Project conversations exported: " + totalConvs);
    console.error("Output: " + OUT);
    console.error("=".repeat(50));
    wss.close();
    process.exit(0);
  });
});
