// Local HTTP helper that lets the yt-journal browser extension log YouTube
// videos. Binds to 127.0.0.1 ONLY — never reachable from the network.
//
//   POST /log-video   { title, url, channel?, takeaway?, summary?, explanation? }
//                     -> { ok, id }   (instant, writes one markdown entry)
//   POST /summarize   { url, title }  -> { summary, explanation, warning? }  (best-effort)
//   GET  /health                       -> { ok: true }
//
// CORS is permissive: we listen on localhost only, so letting the extension
// origin call us is safe.
//
// Run:  npm run server
//       node --env-file=.env src/server.mjs
// Override port with HELPER_PORT (default 8776).

import http from "node:http";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logVideo, InputError, ConfigError } from "./store.mjs";
import { summarizeVideo, summarizeTranscript } from "./summarize.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HELPER_PORT) || 8776;

// Persistent request log (gitignored) — the launching terminal's stdout isn't
// reachable otherwise.
const requestLogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.log");
function logLine(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(entry);
  try {
    appendFileSync(requestLogPath, entry);
  } catch {
    /* best effort */
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

// Map store's typed errors to HTTP statuses.
function statusFor(err) {
  if (err instanceof InputError) return 400;
  if (err instanceof ConfigError) return 500;
  return 500;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const { pathname } = new URL(req.url, `http://${HOST}`);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/log-video") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }
    const { title, url, channel, takeaway, summary, explanation } = body;
    logLine(
      `POST /log-video title=${title?.length || 0}c url=${url?.length || 0}c ` +
        `channel=${channel?.length || 0}c takeaway=${takeaway?.length || 0}c`
    );
    try {
      const { id } = logVideo({ title, url, channel, takeaway, summary, explanation });
      logLine(`POST /log-video -> 200 id=${id}`);
      return send(res, 200, { ok: true, id });
    } catch (err) {
      const status = statusFor(err);
      logLine(`POST /log-video -> ${status} ${err.message}`);
      return send(res, status, { error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/summarize") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }
    const { url, title } = body;
    logLine(`POST /summarize url=${url?.length || 0}c title=${title?.length || 0}c`);
    const startedAt = Date.now();
    try {
      const result = await summarizeVideo({ url, title });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(
        `POST /summarize -> 200 (${elapsed}s) summary=${result.summary?.length || 0}c ` +
          `explanation=${result.explanation?.length || 0}c${result.warning ? ` warning="${result.warning}"` : ""}`
      );
      return send(res, 200, result);
    } catch (err) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(`POST /summarize -> 500 (${elapsed}s) ${err.message}`);
      return send(res, 500, { error: err.message });
    }
  }

  // Summarize a transcript the caller already has (the extension fetches it
  // from YouTube's page context, where the proof-of-origin token lives — a
  // Node-side fetch can no longer get it as of 2026-08).
  //   { transcript, title } -> { summary, explanation, warning? }
  if (req.method === "POST" && pathname === "/summarize-text") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }
    const { transcript, title } = body;
    logLine(
      `POST /summarize-text transcript=${transcript?.length || 0}c title=${title?.length || 0}c`
    );
    const startedAt = Date.now();
    try {
      const result = await summarizeTranscript({ transcript, title });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(
        `POST /summarize-text -> 200 (${elapsed}s) summary=${result.summary?.length || 0}c ` +
          `explanation=${result.explanation?.length || 0}c${result.warning ? ` warning="${result.warning}"` : ""}`
      );
      return send(res, 200, result);
    } catch (err) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(`POST /summarize-text -> 500 (${elapsed}s) ${err.message}`);
      return send(res, 500, { error: err.message });
    }
  }

  return send(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`yt-journal server on http://${HOST}:${PORT}`);
  console.log(`  POST /log-video      { title, url, channel?, takeaway?, summary?, explanation? }  -> { ok, id }`);
  console.log(`  POST /summarize-text { transcript, title }  -> { summary, explanation, warning? }`);
  console.log(`  POST /summarize      { url, title }  -> { ... }  (legacy server-side fetch, usually returns warning)`);
  console.log("  GET  /health");
});
