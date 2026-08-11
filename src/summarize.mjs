// Summarize a transcript via GLM. Two entry points:
//
//   summarizeTranscript({ transcript, title }) -> { summary, explanation }
//     Pure GLM call over provided text. The extension is responsible for
//     obtaining the transcript (it runs in YouTube's page context and has the
//     real browser session YouTube's anti-abuse layer expects).
//
//   summarizeVideo({ url, title }) -> { summary, explanation, warning }
//     Legacy server-side path: fetches the transcript itself. BROKEN as of
//     2026-08 — YouTube now requires a proof-of-origin token that only the
//     in-page JS can produce, so a Node-side timedtext fetch returns empty.
//     Kept as a fallback and for tests; expect { warning } in practice.
//
// Every failure here degrades gracefully: a video is ALWAYS loggable;
// summarize is a nice-to-have that fills optional fields.

export class SummarizeError extends Error {}

// Config: same shape as application-filler's core.mjs so the same .env works.
function config() {
  const apiKey = process.env.ZAI_API_KEY;
  return {
    apiKey,
    model: process.env.ZAI_MODEL || "glm-4.5-air",
    baseURL: process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4",
    thinking: { type: "disabled" }, // summary doesn't need reasoning tokens
  };
}

// Extract the 11-char video id from any YT URL shape we're likely to see.
export function parseVideoId(url) {
  if (!url) return null;
  const u = String(url);
  const m =
    u.match(/(?:youtu\.be\/|watch\?v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) ||
    u.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    u.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

// Main entry: GLM summary over a transcript the caller already has.
// Returns { summary, explanation }. Empty strings on any failure (never throws
// to the caller — they still save the entry without these fields).
export async function summarizeTranscript({ transcript, title }) {
  const c = config();
  if (!c.apiKey) {
    return { summary: "", explanation: "", warning: "ZAI_API_KEY not set." };
  }
  if (!transcript || !transcript.trim()) {
    return {
      summary: "",
      explanation: "",
      warning: "No transcript provided.",
    };
  }

  const systemPrompt = `You summarize YouTube videos from their transcript for a personal journal. The reader is an intelligent adult who values precision and hates filler. Be specific, factual, and brief. No preamble, no marketing tone, no em dashes. Output EXACTLY two sections with these exact headers and nothing else:

## SUMMARY
2-3 sentences capturing what the video is about and its main claim.

## EXPLANATION
4-6 sentences. The argument's structure, key examples, and any important nuance or qualification the speaker made.`;

  const userPrompt = `TITLE: ${title || "(unknown)"}

TRANSCRIPT:
${truncate(transcript, 12000)}`;

  let data;
  try {
    const res = await fetch(`${c.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        thinking: c.thinking,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) return { summary: "", explanation: "", warning: `GLM API error ${res.status}.` };
    data = await res.json();
  } catch (e) {
    return { summary: "", explanation: "", warning: e.message || "GLM call failed." };
  }

  const out = data.choices?.[0]?.message?.content?.trim() || "";
  return splitSummaryExplanation(out);
}

// Legacy server-side fetch path. See file header: broken as of 2026-08 because
// YouTube requires a proof-of-origin token. Kept for tests/fallback; the real
// transcript now comes from the extension via summarizeTranscript.
export async function summarizeVideo({ url, title }) {
  const videoId = parseVideoId(url);
  const transcript = await fetchTranscript(videoId);
  if (!transcript) {
    return {
      summary: "",
      explanation: "",
      warning: "Server-side transcript fetch is unavailable (YouTube requires a browser session). The extension provides the transcript from the page.",
    };
  }
  return summarizeTranscript({ transcript, title });
}

// Fetch the transcript text for a video id. Returns "" on any failure.
async function fetchTranscript(videoId) {
  if (!videoId) return "";
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let html;
  try {
    const res = await fetch(watchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return "";
    html = await res.text();
  } catch {
    return "";
  }

  const playerJson = extractPlayerResponse(html);
  if (!playerJson) return "";
  const tracks =
    playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return "";

  const track =
    tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
  const baseUrl = track?.baseUrl;
  if (!baseUrl) return "";

  try {
    const res = await fetch(`${baseUrl}&fmt=json3`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return "";
    const json = await res.json();
    // json3: { events: [{ segs: [{ utf8 }] }] }
    const text = (json.events || [])
      .map((e) => (e.segs || []).map((s) => s.utf8 || "").join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  } catch {
    return "";
  }
}

// The watch page embeds ytInitialPlayerResponse = {...}; as a top-level JS
// assignment. Slice from that marker to the closing `};` at depth 0 and JSON
// parse. Returns null if not found or unparseable.
function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf("{", start);
  if (eq === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = eq; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(eq, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Split the model's two-section output into separate fields.
function splitSummaryExplanation(text) {
  if (!text) return { summary: "", explanation: "" };
  const m = text.match(/^(?:#{1,3})\s*SUMMARY\s*([\s\S]*?)\n\s*(?:#{1,3})\s*EXPLANATION\s*([\s\S]*)$/i);
  if (m) {
    return { summary: m[1].trim(), explanation: m[2].trim() };
  }
  return { summary: text.trim(), explanation: "" };
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}
