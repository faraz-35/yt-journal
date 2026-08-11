// Storage layer: writes one markdown entry per logged video into the yt-journal
// skill dir, and appends a one-line index. Mirrors the my-answers pattern from
// application-filler so any agent reading about-me reads this naturally:
//
//   <dir>/SKILL.md     — what this is, how to use it
//   <dir>/INDEX.md     — one scannable line per video
//   <dir>/NNN.md       — one file per video (full entry)
//
// The dir defaults to ~/.agents/skills/about-me/yt-journal/ (override with
// YTJOURNAL_DIR for testing). Single-writer (the daemon), so id collisions
// aren't a real concern.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const journalDir =
  process.env.YTJOURNAL_DIR ||
  join(homedir(), ".agents", "skills", "about-me", "yt-journal");
export const indexPath = join(journalDir, "INDEX.md");

// Lightweight typed errors so the server can map to the right HTTP status.
export class InputError extends Error {}
export class ConfigError extends Error {}

// Write one entry and append its INDEX line.
// Payload: { title (required), url (required), channel?, takeaway?,
//            summary?, explanation? }. Returns { id, path }.
export function logVideo({
  title,
  url,
  channel,
  takeaway,
  summary,
  explanation,
} = {}) {
  const t = (title ?? "").toString().trim();
  const u = (url ?? "").toString().trim();
  if (!t) throw new InputError("No title to save.");
  if (!u) throw new InputError("No URL to save.");

  if (!existsSync(journalDir)) {
    try {
      mkdirSync(journalDir, { recursive: true });
    } catch {
      throw new ConfigError(`Could not create journal dir at ${journalDir}`);
    }
  }

  const id = nextId();
  const entryPath = join(journalDir, `${id}.md`);
  writeFileSync(
    entryPath,
    renderEntry({ id, title: t, url: u, channel, takeaway, summary, explanation }),
    "utf8"
  );
  appendIndexLine(id, t, channel);
  return { id, path: entryPath };
}

// Next monotonic 3-digit id by scanning existing NNN.md files.
function nextId() {
  let max = 0;
  try {
    for (const name of readdirSync(journalDir)) {
      const m = name.match(/^(\d{3,})\.md$/i);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    /* empty/missing dir -> start at 001 */
  }
  return String(max + 1).padStart(3, "0");
}

function renderEntry({ id, title, url, channel, takeaway, summary, explanation }) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ch = channel && channel.trim() ? channel.trim() : "";
  const summaryBlock = summary && summary.trim()
    ? `\n## Summary\n\n${summary.trim()}\n`
    : "";
  const explanationBlock = explanation && explanation.trim()
    ? `\n## Explanation\n\n${explanation.trim()}\n`
    : "";
  const takeawayBlock = takeaway && takeaway.trim()
    ? `\n## Takeaway\n\n${takeaway.trim()}\n`
    : "";
  return [
    `# [${id}] ${oneLine(title)}`,
    ``,
    `- date: ${date}`,
    `- channel: ${ch}`,
    `- url: ${url}`,
    summaryBlock,
    explanationBlock,
    takeawayBlock,
  ]
    .filter((s) => s !== "")
    .join("\n") + "\n";
}

// One INDEX line: [NNN] <title>  ·  <channel>  ·  <date>
function appendIndexLine(id, title, channel) {
  const date = new Date().toISOString().slice(0, 10);
  const ch = channel && channel.trim() ? channel.trim() : "?";
  const line = `- [${id}] ${oneLine(title, 90)}  ·  ${oneLine(ch, 30)}  ·  ${date}\n`;
  try {
    appendFileSync(indexPath, line);
  } catch {
    /* INDEX is best-effort; the entry file is the source of truth */
  }
}

// Collapse to a single line and truncate for INDEX / entry-title use.
function oneLine(s, max = 120) {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
