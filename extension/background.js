// Background event page. Three jobs:
//  1. Keyboard command / toolbar action -> tell the active tab's content script
//     to open the card (injecting content.js on demand if the tab predates the
//     last reload — otherwise sendMessage throws "Receiving end does not exist").
//  2. POST a log entry ON BEHALF of content scripts (message "LOG_VIDEO").
//  3. POST a summarize request ON BEHALF of content scripts (message "SUMMARIZE").
//
// (2) and (3) live here, not in content.js, on purpose: in Firefox a
// content-script fetch is treated as coming from the web page, so YouTube's
// CSP can block the call to 127.0.0.1. A background fetch runs in the
// extension's own context with full host permissions, so it just works.

const SERVER = "http://127.0.0.1:8776";

async function postJson(path, payload, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON response handled below */
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function messageForError(e, { summarize = false } = {}) {
  if (e?.name === "AbortError") {
    return summarize
      ? "Summarize timed out (over 2 minutes). You can still save without it."
      : "The request timed out (over 2 minutes).";
  }
  if (/network|failed to fetch/i.test(e?.message || "")) {
    return `Can't reach the helper at ${SERVER}. Is the yt-journal server running?`;
  }
  return e?.message || "Request failed.";
}

browser.runtime.onMessage.addListener((msg) => {
  const log = (...a) => console.log("[ytj-bg]", ...a);

  if (msg?.type === "LOG_VIDEO") {
    return (async () => {
      try {
        const { ok, status, data } = await postJson("/log-video", {
          title: msg.title,
          url: msg.url,
          channel: msg.channel,
          takeaway: msg.takeaway,
          summary: msg.summary,
          explanation: msg.explanation,
        });
        if (!ok) return { error: data.error || `Helper error (HTTP ${status}).` };
        if (!data.ok) return { error: "The helper reported failure." };
        return { ok: true, id: data.id };
      } catch (e) {
        log("LOG_VIDEO threw:", e?.name, e?.message);
        return { error: messageForError(e) };
      }
    })();
  }

  if (msg?.type === "SUMMARIZE") {
    return (async () => {
      try {
        const { ok, status, data } = await postJson(
          "/summarize",
          { url: msg.url, title: msg.title },
          { timeoutMs: 120000 } // transcript fetch + GLM can be slow
        );
        if (!ok) return { error: data.error || `Helper error (HTTP ${status}).` };
        return {
          summary: data.summary || "",
          explanation: data.explanation || "",
          warning: data.warning,
        };
      } catch (e) {
        log("SUMMARIZE threw:", e?.name, e?.message);
        return { error: messageForError(e, { summarize: true }) };
      }
    })();
  }

  // Summarize a transcript the content script already fetched from the page.
  // This is the working path as of 2026-08: the extension owns transcript
  // fetching (it has the browser session), the server owns the GLM call.
  if (msg?.type === "SUMMARIZE_TEXT") {
    return (async () => {
      try {
        const { ok, status, data } = await postJson(
          "/summarize-text",
          { transcript: msg.transcript, title: msg.title },
          { timeoutMs: 120000 }
        );
        if (!ok) return { error: data.error || `Helper error (HTTP ${status}).` };
        return {
          summary: data.summary || "",
          explanation: data.explanation || "",
          warning: data.warning,
        };
      } catch (e) {
        log("SUMMARIZE_TEXT threw:", e?.name, e?.message);
        return { error: messageForError(e, { summarize: true }) };
      }
    })();
  }

  return undefined;
});

// On-demand content-script injection. Tabs already open when the extension was
// (re)loaded never received content.js, so sendMessage to them throws. Inject
// here (guarded by the script's own __ytjInjected flag) and retry once.
async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "OPEN_CARD" });
  } catch {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await browser.tabs.sendMessage(tabId, { type: "OPEN_CARD" });
    } catch {
      /* privileged page (about:*, addons store) — nothing to do */
    }
  }
}

// The toolbar action and the keyboard command both open the card.
async function openOnActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  const url = tab.url || "";
  if (!/^https:\/\/(www\.)?youtube\.com\//i.test(url)) {
    // Best-effort: still try (the user may have just navigated), but YouTube
    // only — content.js is scoped to youtube.com so the inject is harmless.
    console.log("[ytj-bg] active tab is not youtube.com:", url);
  }
  await ensureContentScript(tab.id);
}

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "open-log-card") return;
  await openOnActiveTab();
});

browser.action.onClicked.addListener(openOnActiveTab);
