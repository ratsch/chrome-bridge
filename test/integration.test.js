const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const net = require("net");
const os = require("os");

jest.setTimeout(15000);

const CLI_PATH = path.join(__dirname, "..", "cli.js");
const PORT = 9223;
const TOKEN_FILE = path.join(os.tmpdir(), "chatgpt-bridge-token");

// Helper: wait until port is free
function waitForPortFree(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const sock = new net.Socket();
      sock.once("connect", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} still in use after ${timeoutMs}ms`));
        } else {
          setTimeout(check, 100);
        }
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(); // Port is free
      });
      sock.connect(port, "127.0.0.1");
    };
    check();
  });
}

// Helper: start CLI as a child process, wait for it to be ready
function startCli(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.on("data", (d) => { stdout += d.toString(); });

    // Wait for "Waiting for extension" message
    const check = setInterval(() => {
      if (stderr.includes("Waiting for extension")) {
        clearInterval(check);
        resolve({ proc, getStderr: () => stderr, getStdout: () => stdout });
      }
    }, 50);

    proc.on("error", (err) => {
      clearInterval(check);
      reject(err);
    });

    setTimeout(() => {
      clearInterval(check);
      reject(new Error(`CLI did not start in time. stderr: ${stderr}`));
    }, 5000);
  });
}

// Helper: wait for process to exit
function waitForExit(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Process did not exit in time"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// Helper: connect as mock extension client
function connectClient(token) {
  const url = token
    ? `ws://localhost:${PORT}?token=${encodeURIComponent(token)}`
    : `ws://localhost:${PORT}`;
  const ws = new WebSocket(url);

  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// Clean up between tests
let activeProcs = [];

afterEach(async () => {
  for (const p of activeProcs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  activeProcs = [];
  // Wait for port to be released before next test
  await waitForPortFree(PORT).catch(() => {});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CLI WebSocket integration", () => {

  test("full round trip: send prompt, receive streaming response", async () => {
    const token = "test-roundtrip-" + Date.now();
    const { proc, getStdout } = await startCli(["--token", token, "Hello ChatGPT"]);
    activeProcs.push(proc);

    const ws = await connectClient(token);

    // Send hello to trigger prompt dispatch
    ws.send(JSON.stringify({ type: "hello", client: "chatgpt-bridge" }));

    // Wait for send_message from CLI
    const msg = await new Promise((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "send_message") resolve(m);
      });
    });

    expect(msg.type).toBe("send_message");
    expect(msg.text).toBe("Hello ChatGPT");
    expect(msg.id).toMatch(/^cli-/);

    // Simulate ChatGPT response
    ws.send(JSON.stringify({ type: "stream_start", id: msg.id }));
    ws.send(JSON.stringify({ type: "stream_delta", id: msg.id, text: "Hi " }));
    ws.send(JSON.stringify({ type: "stream_delta", id: msg.id, text: "there!" }));
    ws.send(JSON.stringify({ type: "stream_done", id: msg.id, text: "Hi there!" }));

    const exitCode = await waitForExit(proc);
    expect(exitCode).toBe(0);
    expect(getStdout().trim()).toBe("Hi there!");
  });

  test("rejects connection with wrong token", async () => {
    const token = "correct-token-" + Date.now();
    const { proc } = await startCli(["--token", token, "Hello"]);
    activeProcs.push(proc);

    const ws = await connectClient("wrong-token");

    const closeEvent = await new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    expect(closeEvent.code).toBe(1008);

    proc.kill();
  });

  test("accepts connection with correct token", async () => {
    const token = "valid-token-" + Date.now();
    const { proc, getStderr } = await startCli(["--token", token, "Hello"]);
    activeProcs.push(proc);

    const ws = await connectClient(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(JSON.stringify({ type: "hello", client: "chatgpt-bridge" }));

    const msg = await new Promise((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "send_message") resolve(m);
      });
    });

    expect(msg.type).toBe("send_message");
    expect(getStderr()).toContain("Extension connected");

    // Complete the exchange so CLI exits cleanly
    ws.send(JSON.stringify({ type: "stream_done", id: msg.id, text: "ok" }));
    await waitForExit(proc);
  });

  test("token written to temp file", async () => {
    const token = "file-token-" + Date.now();
    const { proc } = await startCli(["--token", token, "Hello"]);
    activeProcs.push(proc);

    const fileContent = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    expect(fileContent).toBe(token);

    proc.kill();
  });

  test("token from CHATGPT_BRIDGE_TOKEN env var", async () => {
    const token = "env-token-" + Date.now();
    const { proc, getStderr } = await startCli(["Hello"], {
      CHATGPT_BRIDGE_TOKEN: token,
    });
    activeProcs.push(proc);

    expect(getStderr()).toContain(`Auth token: ${token}`);

    const ws = await connectClient(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    proc.kill();
  });

  test("generates random token when none provided", async () => {
    // Remove token file so CLI falls through to random generation
    try { fs.unlinkSync(TOKEN_FILE); } catch {}
    const { proc, getStderr } = await startCli(["Hello"], {
      CHATGPT_BRIDGE_TOKEN: "",
    });
    activeProcs.push(proc);

    const match = getStderr().match(/Auth token: ([0-9a-f]+)/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/^[0-9a-f]{32}$/);

    proc.kill();
  });

  test("EADDRINUSE when port is occupied", async () => {
    const token1 = "first-" + Date.now();
    const { proc: proc1 } = await startCli(["--token", token1, "Hello"]);
    activeProcs.push(proc1);

    // Start second instance — should fail immediately
    const token2 = "second-" + Date.now();
    const proc2 = spawn(process.execPath, [CLI_PATH, "--token", token2, "Hello"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeProcs.push(proc2);

    let stderr2 = "";
    proc2.stderr.on("data", (d) => { stderr2 += d.toString(); });

    const exitCode = await waitForExit(proc2);
    expect(exitCode).toBe(1);
    expect(stderr2).toContain("already in use");

    proc1.kill();
  });

  test("error message forwarded from extension", async () => {
    const token = "error-test-" + Date.now();
    const { proc, getStderr } = await startCli(["--token", token, "Hello"]);
    activeProcs.push(proc);

    const ws = await connectClient(token);
    ws.send(JSON.stringify({ type: "hello", client: "chatgpt-bridge" }));

    const msg = await new Promise((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "send_message") resolve(m);
      });
    });

    // Simulate error from extension
    ws.send(JSON.stringify({ type: "error", id: msg.id, error: "No ChatGPT tab open" }));

    const exitCode = await waitForExit(proc);
    expect(exitCode).toBe(1);
    expect(getStderr()).toContain("No ChatGPT tab open");
  });

  test("message protocol: only chatgpt-bridge hello triggers dispatch", async () => {
    const token = "proto-test-" + Date.now();
    const { proc } = await startCli(["--token", token, "Test prompt"]);
    activeProcs.push(proc);

    const ws = await connectClient(token);

    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw)));

    // Wrong client name should not trigger send_message
    ws.send(JSON.stringify({ type: "hello", client: "wrong-client" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(messages.filter((m) => m.type === "send_message")).toHaveLength(0);

    // Correct hello should trigger send_message
    ws.send(JSON.stringify({ type: "hello", client: "chatgpt-bridge" }));
    await new Promise((r) => setTimeout(r, 300));
    const sendMsgs = messages.filter((m) => m.type === "send_message");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0].text).toBe("Test prompt");

    ws.send(JSON.stringify({ type: "stream_done", id: sendMsgs[0].id, text: "done" }));
    await waitForExit(proc);
  });
});
