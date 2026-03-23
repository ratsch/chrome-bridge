/**
 * Pure utility functions extracted from cli.js for testability.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseArgs(argv) {
  const files = [];
  const attachments = [];
  let batch = false;
  let outputPattern = null;
  let timeout = 60 * 60_000;
  let promptText = null;
  let token = null;

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-f" || arg === "--file") {
      i++;
      if (i < argv.length) files.push(argv[i]);
    } else if (arg === "-a" || arg === "--attach") {
      i++;
      if (i < argv.length) attachments.push(argv[i]);
    } else if (arg === "-b" || arg === "--batch") {
      batch = true;
    } else if (arg === "-o" || arg === "--output") {
      outputPattern = argv[++i];
    } else if (arg === "-t" || arg === "--timeout") {
      timeout = parseInt(argv[++i]) * 1000;
    } else if (arg === "--token") {
      token = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else {
      positional.push(arg);
    }
  }
  // Last positional arg is the prompt; any earlier ones are files
  if (positional.length > 0) {
    promptText = positional.pop();
    files.push(...positional);
  }
  return { files, attachments, batch, outputPattern, timeout, promptText, token };
}

function buildPrompt(prompt, fileContents) {
  const parts = [];
  for (const { name, content } of fileContents) {
    parts.push(`[file: ${name}]\n${content}\n[end file]`);
  }
  if (prompt) parts.push(prompt);
  return parts.join("\n\n");
}

function expandOutput(pattern, filepath) {
  const ext = path.extname(filepath);
  const base = path.basename(filepath);
  const name = path.basename(filepath, ext);
  const dir = path.dirname(filepath);
  return path.join(dir, pattern
    .replace(/\{name\}/g, name)
    .replace(/\{ext\}/g, ext.slice(1))
    .replace(/\{base\}/g, base));
}

function readFile(filepath) {
  try {
    return fs.readFileSync(filepath, "utf8");
  } catch (err) {
    process.stderr.write(`[cli] Warning: cannot read ${filepath}: ${err.message}\n`);
    return null;
  }
}

function generateId() {
  return "cli-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex");
}

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { parseArgs, buildPrompt, expandOutput, readFile, generateId, generateToken };
