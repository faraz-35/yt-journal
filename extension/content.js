// YT Journal — content script (youtube.com only).
//
// On the hotkey (relayed by the background) or the toolbar action, extract the
// current video's title / channel / url from the page, then show an inline card
// with those auto-filled (editable) plus an empty Takeaway (the point) and
// optional Summary / Explanation fields. "Generate" calls the local server for
// a best-effort transcript summary; "Save" writes the entry instantly. The card
// lives in a Shadow DOM so YouTube's CSS can't touch it.

(() => {
  if (window.__ytjInjected) return;
  window.__ytjInjected = true;

  const TAG = "[ytj]";
  const log = (...a) => console.log(TAG, ...a);
  const logErr = (...a) => console.error(TAG, ...a);

  let active = null; // { close() } for the currently-open card, if any

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  /* ---------------- video metadata extraction ---------------- */
  // YouTube's DOM is brittle and varies by page type (watch / shorts / channel
  // embed). Try several sources for each field, best first. Always editable in
  // the card, so a wrong guess is recoverable, not fatal.
  function extractMeta() {
    const url = location.href;

    // Title: h1.ytd-watch-metadata (modern watch), then yt-formatted-string
    // title, then og:title, then document.title with " - YouTube" stripped.
    const title =
      clean(document.querySelector("h1.ytd-watch-metadata #title")?.textContent) ||
      clean(document.querySelector("h1.title yt-formatted-string")?.textContent) ||
      clean(document.querySelector('meta[property="og:title"]')?.content) ||
      clean(document.title).replace(/\s*-\s*YouTube\s*$/i, "");

    // Channel: the channel-name link on watch pages, then the link's aria, then
    // a meta tag as a last resort.
    const channelLink =
      document.querySelector("ytd-watch-metadata #channel-name a") ||
      document.querySelector("ytd-video-owner-renderer a") ||
      document.querySelector("#owner-text a");
    const channel =
      clean(channelLink?.textContent) ||
      clean(channelLink?.getAttribute("aria-label")) ||
      clean(document.querySelector('meta[name="author"]')?.content) ||
      "";

    return { title, channel, url };
  }

  /* ---------------- transcript fetch (page context — has the POT token) ---------------- */
  // YouTube now requires a proof-of-origin token that only the in-page JS can
  // produce, so the transcript MUST be fetched here in the content script (real
  // browser session, cookies, same-origin) and sent to the server as text. The
  // server's summarize path over a bare Node fetch returns empty.
  //
  // Strategy: pull the caption track baseUrl out of the page's embedded
  // ytInitialPlayerResponse JSON, then fetch it with &fmt=json3 (same-origin,
  // carries cookies). Falls back to the player response's tracks if present.

  async function fetchTranscriptFromPage() {
    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId) return "";

    // Try the page's embedded player response first (cheapest).
    let baseUrl = findCaptionBaseUrl(document.body?.innerHTML || "");

    // Fall back to the live player API the page itself uses.
    if (!baseUrl) {
      baseUrl = await fetchCaptionBaseUrlViaInnertube(videoId);
    }
    if (!baseUrl) return "";

    try {
      const res = await fetch(appendFmt(baseUrl, "json3"), {
        credentials: "include",
      });
      if (!res.ok) return "";
      const json = await res.json();
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

  // Scan HTML for the first caption track baseUrl, preferring English.
  function findCaptionBaseUrl(html) {
    const tracks = [...html.matchAll(/"captionTracks":(\[.*?\])/s)]
      .map((m) => {
        try {
          return JSON.parse(m[1]);
        } catch {
          return [];
        }
      })
      .flat();
    if (!tracks.length) return null;
    const track =
      tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
    return track?.baseUrl?.replace(/\\u0026/g, "&") || null;
  }

  // Ask YouTube's player API (same-origin from the content script) for caption
  // tracks. This is what the page does internally.
  async function fetchCaptionBaseUrlViaInnertube(videoId) {
    try {
      const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB", clientVersion: "2.20240801.00.00" },
          },
          videoId,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || !tracks.length) return null;
      const track =
        tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
      return track?.baseUrl?.replace(/\\u0026/g, "&") || null;
    } catch {
      return null;
    }
  }

  function appendFmt(url, fmt) {
    return url + (url.includes("&fmt=") ? "" : `&fmt=${fmt}`);
  }

  /* ---------------- the brain call (via background, CSP-safe) ---------------- */
  // Like application-filler, fetching through the background avoids YouTube's
  // CSP, which would otherwise block a content-script fetch to 127.0.0.1.

  async function postLogVideo(payload) {
    const res = await browser.runtime.sendMessage({ type: "LOG_VIDEO", ...payload });
    if (res?.error) throw new Error(res.error);
    return res;
  }

  // Send transcript text (fetched here in the page context) to the server for
  // GLM summarization. The server never fetches the transcript itself — it
  // can't, without YouTube's proof-of-origin token.
  async function postSummarizeText(transcript, title) {
    const res = await browser.runtime.sendMessage({
      type: "SUMMARIZE_TEXT",
      transcript,
      title,
    });
    if (res?.error) throw new Error(res.error);
    return res; // { summary, explanation, warning? }
  }

  /* ---------------- toast ---------------- */
  function toast(text, kind = "info") {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .t { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
              background: ${kind === "error" ? "#7f1d1d" : "#111827"}; color: #fff;
              font: 13px/1.4 -apple-system, system-ui, sans-serif;
              padding: 9px 14px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.3);
              z-index: 2147483647; max-width: 80vw; }
      </style>
      <div class="t"></div>`;
    root.querySelector(".t").textContent = text;
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 2600);
  }

  /* ---------------- the inline card (Shadow DOM) ---------------- */
  const CARD_CSS = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .wrap { position: fixed; z-index: 2147483646; width: 420px; top: 80px; right: 24px; }
    .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(15,23,42,.18); padding: 14px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
    .title { font-size: 12px; font-weight: 600; color: #374151; }
    .spacer { flex: 1; }
    .close { border: none; background: transparent; cursor: pointer; color: #9ca3af;
             font-size: 15px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
    .close:hover { background: #f3f4f6; color: #374151; }
    label { display: block; font-size: 10px; font-weight: 700; color: #6b7280;
            margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
    label .opt { text-transform: none; font-weight: 400; color: #9ca3af; }
    label .auto { text-transform: none; font-weight: 400; color: #9ca3af; }
    input, textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px;
                      font-size: 13px; color: #111827; outline: none; background: #fff; }
    textarea { resize: vertical; min-height: 44px; }
    textarea.tall { min-height: 90px; }
    input:focus, textarea:focus { border-color: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.13); }
    .row { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    button.save { background: #ef4444; color: #fff; border: none; border-radius: 8px;
                  padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
                  white-space: nowrap; }
    button.save:disabled { background: #9ca3af; cursor: default; }
    button.save:hover:not(:disabled) { background: #dc2626; }
    button.gen { background: transparent; color: #374151; border: 1px solid #d1d5db;
                 border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600;
                 cursor: pointer; white-space: nowrap; }
    button.gen:disabled { color: #9ca3af; cursor: default; }
    button.gen:hover:not(:disabled) { background: #f3f4f6; border-color: #9ca3af; }
    .status { font-size: 12px; color: #6b7280; min-height: 16px; margin-top: 8px;
              word-break: break-word; flex: 1; }
    .status.err { color: #b91c1c; }
    .status.ok { color: #047857; }
    .status.load { color: #dc2626; }
    .hint { font-size: 10px; color: #9ca3af; margin-top: 8px; }
    .min-btn { border: none; background: transparent; cursor: pointer; color: #9ca3af;
               font-size: 15px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
    .min-btn:hover { background: #f3f4f6; color: #374151; }
    /* Minimized state: hide the form, show a compact circle. The same .wrap
       stays in place — only the children toggle. */
    .wrap.min .card { display: none; }
    .wrap:not(.min) .pill { display: none; }
    .pill { position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
            width: 44px; height: 44px; border-radius: 50%; background: #ef4444;
            cursor: pointer; box-shadow: 0 6px 20px rgba(15,23,42,.28);
            display: flex; align-items: center; justify-content: center;
            user-select: none; touch-action: none; transition: background .15s, transform .1s; }
    .pill:hover { background: #dc2626; }
    .pill:active { transform: scale(.94); }
    .pill svg { width: 20px; height: 20px; fill: #fff; pointer-events: none; }
    .pill .pcount { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
                    border-radius: 999px; background: #fff; color: #ef4444; text-align: center;
                    padding: 0 4px; box-shadow: 0 1px 4px rgba(0,0,0,.25);
                    font: 700 11px/18px -apple-system, system-ui, sans-serif;
                    display: none; pointer-events: none; }
    .pill .pcount.show { display: block; }
  `;

  function buildCard(meta) {
    const host = document.createElement("div");
    host.className = "ytj-card";
    host.style.cssText = "all: initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CARD_CSS}</style>
      <div class="wrap">
        <div class="card">
          <div class="head">
            <span class="dot"></span><span class="title">YT Journal</span>
            <span class="spacer"></span>
            <button class="min-btn" title="Minimize (keeps your notes)" aria-label="Minimize">–</button>
            <button class="close" title="Close (Esc)" aria-label="Close">✕</button>
          </div>
          <label for="ytj-title">Title <span class="auto">(auto — edit if wrong)</span></label>
          <input id="ytj-title" type="text" spellcheck="false" />
          <label for="ytj-channel">Channel <span class="opt">(optional)</span></label>
          <input id="ytj-channel" type="text" spellcheck="false" />
          <label for="ytj-url">URL</label>
          <input id="ytj-url" type="text" spellcheck="false" />
          <label for="ytj-take">Takeaway <span class="opt">(your reaction — the point)</span></label>
          <textarea id="ytj-take" rows="3" class="tall" spellcheck="true"
                    placeholder="What stuck with you? What did you agree or disagree with? How did it move your thinking?"></textarea>
          <label for="ytj-sum">Summary <span class="opt">(optional · auto via Generate)</span></label>
          <textarea id="ytj-sum" rows="2" spellcheck="false"></textarea>
          <label for="ytj-exp">Explanation <span class="opt">(optional · auto via Generate)</span></label>
          <textarea id="ytj-exp" rows="3" class="tall" spellcheck="false"></textarea>
          <div class="row">
            <button class="gen" title="Fetch transcript and summarize via GLM (best-effort)">Generate</button>
            <button class="save">Save entry</button>
            <span class="status"></span>
          </div>
          <div class="hint">Ctrl/⌘+Enter saves · – minimizes to a pill · Esc closes</div>
        </div>
        <div class="pill" title="Expand your notes (drag to move)">
          <svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6zm0 2 4 4h-4V5zM8 13h8v2H8v-2zm0 4h8v2H8v-2z"/></svg>
          <span class="pcount">0</span>
        </div>
      </div>`;
    document.body.appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const titleEl = $("#ytj-title");
    const channelEl = $("#ytj-channel");
    const urlEl = $("#ytj-url");
    const takeEl = $("#ytj-take");
    const sumEl = $("#ytj-sum");
    const expEl = $("#ytj-exp");
    const saveBtn = $("button.save");
    const genBtn = $("button.gen");
    const statusEl = $(".status");
    const minBtn = $("button.min-btn");
    const pillEl = $(".pill");
    const pillCountEl = $(".pill .pcount");
    const wrapEl = $(".wrap");

    titleEl.value = meta.title || "";
    channelEl.value = meta.channel || "";
    urlEl.value = meta.url || "";

    let busy = false;
    const setStatus = (text, kind) => {
      statusEl.textContent = text || "";
      statusEl.className = "status" + (kind ? " " + kind : "");
    };

    // Minimize: collapse to a small draggable circle (state preserved — same
    // DOM, just hidden). Used to park the card while watching and jot
    // incrementally, saving once at the end. Focus returns to the page so
    // YouTube shortcuts work again while watching.
    function minimize() {
      wrapEl.classList.add("min");
      const ae = root.activeElement;
      if (ae && typeof ae.blur === "function") ae.blur();
      refreshPill();
    }
    function expand() {
      wrapEl.classList.remove("min");
      takeEl.focus();
    }
    // The circle shows a count badge once notes exist, so you can see at a
    // glance that there's something to save.
    function refreshPill() {
      const n = takeEl.value.trim().length;
      if (n > 0) {
        pillCountEl.textContent = n > 99 ? "99+" : String(n);
        pillCountEl.classList.add("show");
      } else {
        pillCountEl.classList.remove("show");
      }
    }
    minBtn.addEventListener("click", minimize);
    takeEl.addEventListener("input", refreshPill);
    refreshPill();

    // Drag the circle. Pointer events (not mouse) so it works on touchpads and
    // touchscreens too. The tricky part: a click should expand, a drag should
    // move. We track movement and only treat it as a drag past a small
    // threshold; the click handler checks the same flag to avoid expanding
    // after a drag.
    let dragging = false;
    let moved = false;
    let dragOffX = 0;
    let dragOffY = 0;
    const DRAG_THRESH = 4; // px of movement before it counts as a drag

    function onPillPointerDown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return; // left-click only
      dragging = true;
      moved = false;
      const r = pillEl.getBoundingClientRect();
      // Offset of the pointer within the circle, so it drags from where you
      // grabbed it rather than snapping to center.
      dragOffX = e.clientX - r.left;
      dragOffY = e.clientY - r.top;
      pillEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function onPillPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - (pillEl.getBoundingClientRect().left + dragOffX);
      const dy = e.clientY - (pillEl.getBoundingClientRect().top + dragOffY);
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESH) return;
      moved = true;
      // Switch from bottom/right anchoring to explicit top/left so the circle
      // stays put under the cursor instead of jumping.
      let left = e.clientX - dragOffX;
      let top = e.clientY - dragOffY;
      // Keep it on-screen.
      const size = 44;
      left = Math.max(8, Math.min(window.innerWidth - size - 8, left));
      top = Math.max(8, Math.min(window.innerHeight - size - 8, top));
      pillEl.style.left = left + "px";
      pillEl.style.top = top + "px";
      pillEl.style.right = "auto";
      pillEl.style.bottom = "auto";
    }
    function onPillPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      try { pillEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // Click (no real movement) expands; a drag just ends.
      if (!moved) expand();
    }
    pillEl.addEventListener("pointerdown", onPillPointerDown);
    pillEl.addEventListener("pointermove", onPillPointerMove);
    pillEl.addEventListener("pointerup", onPillPointerUp);
    pillEl.addEventListener("pointercancel", onPillPointerUp);

    // Best-effort summary. Fetches the transcript from the page context (where
    // YouTube's proof-of-origin token lives), sends it to the server for GLM
    // summarization. Fills Summary/Explanation on success; leaves them
    // untouched on failure. Never throws to the user.
    async function generate() {
      if (busy) return;
      const title = titleEl.value.trim();
      busy = true;
      genBtn.disabled = true;
      saveBtn.disabled = true;
      const oldGen = genBtn.textContent;
      genBtn.textContent = "Generating…";
      setStatus("Fetching transcript…", "load");
      try {
        const transcript = await fetchTranscriptFromPage();
        if (!transcript) {
          setStatus(
            "No transcript available for this video. You can still type one, or save without it.",
            "err"
          );
          return;
        }
        setStatus("Summarizing via GLM…", "load");
        const res = await postSummarizeText(transcript, title);
        if (res?.summary) sumEl.value = res.summary;
        if (res?.explanation) expEl.value = res.explanation;
        if (res?.warning) {
          setStatus(res.warning, "err");
        } else if (res?.summary || res?.explanation) {
          setStatus("Filled in summary + explanation.", "ok");
        } else {
          setStatus("Nothing returned.", "err");
        }
      } catch (e) {
        setStatus(e.message || "Generate failed.", "err");
      } finally {
        busy = false;
        genBtn.disabled = false;
        saveBtn.disabled = false;
        genBtn.textContent = oldGen;
      }
    }

    async function save() {
      if (busy) return;
      const title = titleEl.value.trim();
      const url = urlEl.value.trim();
      if (!title) {
        setStatus("Title is required.", "err");
        titleEl.focus();
        return;
      }
      if (!url) {
        setStatus("URL is required.", "err");
        urlEl.focus();
        return;
      }
      busy = true;
      saveBtn.disabled = true;
      genBtn.disabled = true;
      const oldSave = saveBtn.textContent;
      saveBtn.textContent = "Saving…";
      try {
        const res = await postLogVideo({
          title,
          url,
          channel: channelEl.value.trim(),
          takeaway: takeEl.value.trim(),
          summary: sumEl.value.trim(),
          explanation: expEl.value.trim(),
        });
        toast(`Logged as ${res?.id || ""}`.trim());
        close();
      } catch (e) {
        setStatus(e.message || "Save failed.", "err");
      } finally {
        busy = false;
        saveBtn.disabled = false;
        genBtn.disabled = false;
        saveBtn.textContent = oldSave;
      }
    }

    genBtn.addEventListener("click", generate);
    saveBtn.addEventListener("click", save);
    $("button.close").addEventListener("click", close);

    const onKey = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    };
    root.addEventListener("keydown", onKey);

    // Keystroke guard. YouTube binds single-key shortcuts (k, j, l, space,
    // arrows, etc.) at document level, and Shadow DOM doesn't stop keydown
    // from bubbling to document — so typing in the card would fire them. This
    // capture-phase listener checks, for every keydown, whether the event
    // started inside our card (composedPath sees through Shadow DOM) and, if
    // so, stops it before YouTube's listeners ever see it. Keyup too, since YT
    // also reacts to keyup on some keys.
    const isInsideCard = (e) => e.composedPath().includes(host);
    const swallow = (e) => {
      if (isInsideCard(e)) e.stopImmediatePropagation();
    };
    // Capture phase on document runs before any bubble-phase listener YouTube
    // registered on document, so stopImmediatePropagation kills the event
    // before YT's shortcut handlers see it.
    document.addEventListener("keydown", swallow, true);
    document.addEventListener("keyup", swallow, true);

    const onEsc = (e) => {
      if (e.key !== "Escape") return;
      // Only react to Esc that originates inside the card — otherwise pressing
      // Esc to exit YT fullscreen (or anything else) would discard notes.
      if (!isInsideCard(e)) return;
      e.stopPropagation();
      if (wrapEl.classList.contains("min")) {
        expand();
      } else {
        close();
      }
    };
    document.addEventListener("keydown", onEsc, true);

    // Focus the takeaway — it's the only thing the user is expected to write.
    setTimeout(() => takeEl.focus(), 0);

    function close() {
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("keydown", swallow, true);
      document.removeEventListener("keyup", swallow, true);
      host.remove();
      if (active === card) active = null;
    }

    const card = { close };
    return card;
  }

  /* ---------------- orchestration ---------------- */
  function openCard() {
    if (active) {
      active.close();
      active = null;
    }
    // Bail with a toast if we're not actually on a video page. YouTube routes
    // a lot of pages through youtube.com/*; only watch/shorts have real meta.
    const meta = extractMeta();
    if (!meta.title && !/\/(watch|shorts|embed)\b/.test(location.pathname)) {
      toast("Open a YouTube video first, then press the shortcut.", "error");
      return;
    }
    active = buildCard(meta);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "OPEN_CARD") openCard();
  });
})();
