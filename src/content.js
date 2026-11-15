// Fablehop Unrepost: walks your Reposts, Liked and Favorites tabs and clears each video.
(() => {
  if (window.__fhUnrepost) return;
  window.__fhUnrepost = true;

  const SPEEDS = { fast: 700, normal: 1400, slow: 2800 };
  const MAX_PASSES = 200;
  const EMPTY_RETRIES = 3; // reloads to try when the grid looks empty
  const RESUME_WINDOW = 90 * 1000; // only pick a run back up if it was alive this recently

  const STOP = Symbol("stop");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms * (0.8 + Math.random() * 0.5);

  let run = null; // { active, state, removed, skipped, pass, speed, status, ts }
  let stopFlag = false;
  let busy = false;
  const lines = [];

  /* ---------- storage ---------- */

  const save = () => {
    run.ts = Date.now();
    return chrome.storage.local.set({ run });
  };
  const bumpTotal = async () => {
    const { total = 0 } = await chrome.storage.local.get("total");
    await chrome.storage.local.set({ total: total + 1 });
  };

  // Every cleared video is written down so you can find it again later.
  let chain = Promise.resolve();
  const remember = (entry) =>
    (chain = chain.then(async () => {
      const { history = [] } = await chrome.storage.local.get("history");
      history.push(entry);
      await chrome.storage.local.set({ history: history.slice(-1000) });
    }));

  /* ---------- finding things on the page ---------- */

  const q = (sel, root = document) => root.querySelector(sel);
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const first = (sels) => {
    for (const s of sels) {
      const el = [...document.querySelectorAll(s)].find(visible);
      if (el) return el;
    }
    return null;
  };

  function navProfilePath() {
    const el = q('[data-e2e="nav-profile"]');
    const link = el && (el.matches("a") ? el : el.closest("a") || el.querySelector("a"));
    const m = ((link && link.getAttribute("href")) || "").match(/\/@[^/?#]+/);
    return m ? m[0] : null;
  }

  // "Edit profile" only shows on your own profile.
  function onOwnProfile() {
    if (!/^\/@[^/]+\/?$/.test(location.pathname)) return false;
    if (q('[data-e2e="edit-profile-entrance"]')) return true;
    return [...document.querySelectorAll("button")].some((b) => /^edit profile$/i.test(b.textContent.trim()));
  }

  const samePath = (a, b) => decodeURIComponent(a).replace(/\/$/, "").toLowerCase() === decodeURIComponent(b).replace(/\/$/, "").toLowerCase();

  // What can be cleared. Each one is a tab on your profile, the grid inside it,
  // and the button in the video viewer that undoes it.
  const TARGETS = {
    reposts: {
      label: "reposts",
      verb: "removed",
      tab: ['[data-e2e="repost-tab"]', '[class*="PRepost"]'],
      tabText: /^reposts?$/i,
      items: [
        '[data-e2e="user-repost-item"] a[href]',
        '[data-e2e="user-repost-item"]',
        '[data-e2e="user-repost-item-list"] a[href*="/video/"]',
        '[data-e2e="user-repost-item-list"] a[href*="/photo/"]',
      ],
      btn: [
        '[data-e2e="video-share-repost"]',
        '[data-e2e="browse-repost"]',
        '[data-e2e*="repost"]:is(button, [role="button"])',
        'button[aria-label*="epost"]',
      ],
    },
    likes: {
      label: "likes",
      verb: "unliked",
      tab: ['[data-e2e="liked-tab"]', '[class*="PLike"]'],
      tabText: /^liked$/i,
      items: [
        '[data-e2e="user-liked-item"] a[href]',
        '[data-e2e="user-liked-item"]',
        '[data-e2e="user-liked-item-list"] a[href*="/video/"]',
        '[data-e2e="user-liked-item-list"] a[href*="/photo/"]',
      ],
      btn: ['[data-e2e="browse-like-icon"]', '[data-e2e="like-icon"]'],
    },
    favorites: {
      label: "favorites",
      verb: "unsaved",
      tab: ['[data-e2e="favorites-tab"]', '[class*="PFavorite"]'],
      tabText: /^favorites$/i,
      items: [
        '[data-e2e="favorites-item"] a[href]',
        '[data-e2e="favorites-item"]',
        '[data-e2e="favorites-item-list"] a[href*="/video/"]',
        '[data-e2e="favorites-item-list"] a[href*="/photo/"]',
      ],
      btn: ['[data-e2e="browse-favorite-icon"]', '[data-e2e="undefined-icon"]', '[data-e2e="favorite-icon"]'],
    },
  };

  function findTab(T) {
    return (
      first(T.tab) ||
      [...document.querySelectorAll('[role="tab"], [class*="Tab"] p, [class*="Tab"] span')].find(
        (el) => visible(el) && T.tabText.test(el.textContent.trim())
      ) ||
      null
    );
  }

  function findItem(T) {
    return (
      first(T.items) ||
      // last resort: any video tile that is not one of your own posts
      [...document.querySelectorAll('[class*="DivVideoContainer"]')].find(
        (el) => visible(el) && (T === TARGETS.reposts || !el.closest('[data-e2e="user-post-item-list"]'))
      ) ||
      null
    );
  }

  function findBtn(T) {
    const el = first(T.btn);
    return el ? el.closest('button, [role="button"]') || el : null;
  }

  const findNext = () => first(['[data-e2e="arrow-right"]', 'button[aria-label="Go to next video"]']);
  const findClose = () => first(['[data-e2e="browse-close"]', 'button[aria-label="Close"]']);

  // the viewer's address looks like /@creator/video/123
  const creator = () => ((location.pathname.match(/^\/@([^/]+)/) || [])[1] || "").toLowerCase();

  const videoId = () => {
    const m = location.pathname.match(/\/(?:video|photo)\/(\d+)/);
    return m ? m[1] : location.href;
  };

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (stopFlag) throw STOP;
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  }
  async function pause(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopFlag) throw STOP;
      await sleep(Math.min(120, end - Date.now()));
    }
  }

  /* ---------- the run ---------- */

  function status(text) {
    run.status = text;
    render();
  }
  function log(text) {
    lines.push(text);
    if (lines.length > 5) lines.shift();
    render();
  }
  async function finish(state, text) {
    run.active = false;
    run.state = state;
    run.status = text;
    await save();
    render();
  }

  async function main() {
    if (busy) return;
    busy = true;
    stopFlag = false;
    try {
      await work();
    } catch (e) {
      if (e === STOP) await finish("stopped", "Stopped. Press start to carry on.");
      else {
        console.error("[fablehop unrepost]", e);
        await finish("error", "Something broke: " + (e && e.message ? e.message : e));
      }
    } finally {
      busy = false;
    }
  }

  async function work() {
    status("Finding your profile");
    const path = await waitFor(navProfilePath, 6000);

    if (path && !samePath(location.pathname, path)) {
      log("opening " + path);
      await save();
      location.href = path; // the run picks back up when the page loads
      return;
    }
    if (!path && !(await waitFor(onOwnProfile, 3000))) {
      return finish("error", "Couldn't find your profile. Log in to TikTok, open your own profile, then press start.");
    }

    const T = TARGETS[run.target];
    status("Opening your " + T.label);
    const tab = await waitFor(() => findTab(T), 12000);
    if (!tab) {
      log("no " + T.label + " tab here");
      return nextTarget();
    }
    tab.click();
    await pause(1800);
    if (tab.hasAttribute("aria-selected") && tab.getAttribute("aria-selected") !== "true") {
      tab.click();
      await pause(1500);
    }

    status("Looking for " + T.label);
    let item = await waitFor(() => findItem(T), 8000);
    if (!item) {
      // TikTok sometimes shows an empty grid until you scroll
      window.scrollTo(0, document.documentElement.scrollHeight);
      item = await waitFor(() => findItem(T), 4000);
      window.scrollTo(0, 0);
    }
    if (!item) return emptyPass(false);
    item.click();
    await pause(1200);

    const delay = SPEEDS[run.speed] || SPEEDS.normal;
    const dry = run.opts.mode === "count"; // count only: walk the videos but click nothing
    const keep = new Set((run.opts.keep || "").toLowerCase().split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean));
    const seen = new Set();
    let passKept = 0;
    let passRemoved = 0;
    let passSkipped = 0;

    status("Clearing " + T.label);
    while (true) {
      const id = videoId();
      if (seen.has(id)) break;
      seen.add(id);

      const btn = await waitFor(() => findBtn(T), 6000);
      // aria-pressed="false" would mean it is already off, and a click would turn it back on
      if (keep.has(creator())) {
        run.kept = (run.kept || 0) + 1;
        passKept++;
        log("kept  @" + creator());
      } else if (btn && btn.getAttribute("aria-pressed") !== "false") {
        if (!dry) btn.click();
        run.removed++;
        run.counts[run.target] = (run.counts[run.target] || 0) + 1;
        run.empty = 0;
        passRemoved++;
        if (!dry) bumpTotal();
        if (!dry) remember({ kind: run.target, url: location.origin + location.pathname, t: Date.now() });
        log((dry ? "found" : T.verb) + "  " + String(id).slice(-10));
      } else {
        run.skipped++;
        passSkipped++;
        log("skipped  " + String(id).slice(-10));
      }
      if (run.opts.limit && run.removed >= run.opts.limit) {
        const x = findClose();
        if (x) x.click();
        return finish("done", "Stopped at your limit of " + run.opts.limit + ".");
      }
      await save();
      render();
      await pause(jitter(delay));

      const next = findNext();
      if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") break;
      const before = location.href;
      next.click();
      if (!(await waitFor(() => location.href !== before, 5000))) break;
      await pause(450);
    }

    const close = findClose();
    if (close) close.click();

    if (dry) return nextTarget();
    if (passRemoved === 0 && passKept && !passSkipped) return nextTarget(); // only keepers left
    if (passRemoved === 0) return emptyPass(passSkipped > 0);
    if (run.pass >= MAX_PASSES) return finish("done", "Stopped after " + MAX_PASSES + " passes. Press start to keep going.");

    run.empty = 0;
    run.pass++;
    status("Reloading to check for more");
    await save();
    await pause(1500);
    await save();
    location.reload();
  }

  // TikTok often stops showing reposts while more are left, so an empty
  // grid has to come up several reloads in a row before we believe it.
  async function emptyPass(stuck) {
    run.empty = (run.empty || 0) + 1;
    if (run.empty <= EMPTY_RETRIES) {
      status("Nothing showing. Reloading to look again (" + run.empty + "/" + EMPTY_RETRIES + ")");
      log("empty, looking again");
      await save();
      await pause(3500);
      await save();
      location.reload();
      return;
    }
    if (stuck) {
      run.stuck = true;
      log("no button found for " + run.target);
    }
    return nextTarget();
  }

  // Move on to the next thing to clear, or wrap up.
  async function nextTarget() {
    run.empty = 0;
    const i = run.targets.indexOf(run.target);
    if (i > -1 && i < run.targets.length - 1) {
      run.target = run.targets[i + 1];
      run.pass = 1;
      log("next up: " + run.target);
      await save();
      return work();
    }
    const parts = run.targets.filter((t) => run.counts[t]).map((t) => run.counts[t] + " " + TARGETS[t].label);
    if (parts.length && run.opts.mode === "count") return finish("done", "Counted " + parts.join(", ") + ". Nothing was changed.");
    if (parts.length) return finish("done", "All clear. Cleared " + parts.join(", ") + "." + (run.kept ? " Kept the ones on your keep list." : ""));
    if (run.kept) return finish("done", "Nothing to clear. Only videos from your keep list are left.");
    if (run.stuck) return finish("error", "Found videos but not the button to clear them. TikTok may have changed its layout.");
    return finish("done", "Nothing found to clear.");
  }

  function start(o) {
    const opts = Object.assign({ speed: "normal", targets: ["reposts"] }, o);
    const targets = Object.keys(TARGETS).filter((t) => opts.targets.includes(t));
    if (!targets.length) targets.push("reposts");
    run = { active: true, state: "running", removed: 0, skipped: 0, pass: 1, speed: opts.speed, opts, targets, target: targets[0], counts: {}, status: "Starting", ts: Date.now() };
    lines.length = 0;
    save();
    render();
    main();
  }

  /* ---------- on-page panel ---------- */

  let host, ui;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .p {
      --accent: #4d5cff; --bg: #05050b; --panel: #0a0a14; --panel-2: #11111e;
      --border: #1c1c2e; --text: #ecebf3; --sub: #6f6f8c; --error: #ff4d4d;
      position: fixed; right: 20px; bottom: 20px; width: 320px; z-index: 2147483647;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      font: 12px/1.5 "Roboto Mono", ui-monospace, Menlo, Consolas, monospace;
      -webkit-font-smoothing: antialiased;
      box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(77,92,255,.08);
      animation: in .25s ease-out;
    }
    @keyframes in { from { transform: translateY(12px); opacity: 0; } }
    .bar {
      display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 0 0 12px;
      border-bottom: 1px solid var(--border); font-size: 11px; letter-spacing: .18em; font-weight: 700;
    }
    .bar sup { color: var(--accent); font-size: 9px; }
    .bar .where { margin-left: auto; color: var(--sub); font-weight: 400; letter-spacing: .14em; }
    .x {
      width: 38px; height: 37px; border: 0; border-left: 1px solid var(--border); background: none;
      color: var(--sub); font: inherit; font-size: 13px; cursor: pointer;
    }
    .x:hover { color: var(--text); background: var(--panel-2); }
    .scan { height: 2px; background: var(--border); overflow: hidden; }
    .scan i { display: block; width: 35%; height: 100%; background: var(--accent); transform: translateX(-100%); }
    .running .scan i { animation: scan 1.3s linear infinite; }
    .done .scan i { width: 100%; transform: none; }
    .error .scan i { width: 100%; transform: none; background: var(--error); }
    @keyframes scan { to { transform: translateX(300%); } }
    .body { padding: 16px 14px 14px; }
    .label { display: flex; align-items: center; gap: 9px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--sub); }
    .sq { width: 7px; height: 7px; background: var(--accent); flex: none; }
    .running .sq { animation: blink 1s steps(2) infinite; }
    .error .sq { background: var(--error); }
    @keyframes blink { 50% { opacity: .15; } }
    .num {
      font-size: 64px; line-height: 1; font-weight: 700; letter-spacing: -.07em;
      margin: 10px 0 12px -3px; font-variant-numeric: tabular-nums;
    }
    .num .z { color: var(--border); }
    .num.tick { animation: tick .22s ease-out; }
    @keyframes tick { from { color: var(--accent); transform: translateY(-3px); } }
    .stats { display: flex; }
    .stat { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--border); margin-left: -1px; }
    .stat:first-child { margin-left: 0; }
    .stat .l { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--sub); }
    .stat .v { font-size: 13px; font-weight: 700; text-transform: uppercase; font-variant-numeric: tabular-nums; }
    .status { margin: 12px 0 8px; min-height: 18px; color: var(--text); }
    .error .status { color: var(--error); }
    .log {
      background: var(--panel); border: 1px solid var(--border); padding: 8px 10px; height: 100px;
      font-size: 11px; color: var(--sub); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end;
    }
    .log div::before { content: "> "; color: var(--accent); }
    .log div:last-child { color: var(--text); }
    .btn {
      display: block; width: 100%; height: 38px; margin-top: 12px; cursor: pointer;
      background: var(--accent); color: var(--on-accent, #fff); border: 1px solid var(--accent);
      font: inherit; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
    }
    .btn:hover { background: var(--text); border-color: var(--text); color: var(--bg); }
    .btn.ghost { background: none; color: var(--text); border-color: var(--border); }
    .btn.ghost:hover { border-color: var(--text); background: none; color: var(--text); }
    .btn:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  `;

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "fablehop-unrepost";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="p" role="status" aria-live="polite">
        <div class="bar">
          ${fhLogo.svg("fablehop", 18, { "#": run.opts.accent || "#4d5cff" })}<span>FABLEHOP<sup>°</sup></span>
          <span class="where">UNREPOST</span>
          <button class="x" title="Hide panel" aria-label="Hide panel">×</button>
        </div>
        <div class="scan"><i></i></div>
        <div class="body">
          <div class="label"><span class="sq"></span><span class="state"></span></div>
          <div class="num"></div>
          <div class="stats">
            <div class="stat"><div class="l">Clearing</div><div class="v now"></div></div>
            <div class="stat"><div class="l">Pass</div><div class="v pass"></div></div>
            <div class="stat"><div class="l">Skipped</div><div class="v skipped"></div></div>
          </div>
          <div class="status"></div>
          <div class="log"></div>
          <button class="btn act"></button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { p: $(".p"), state: $(".state"), num: $(".num"), pass: $(".pass"), skipped: $(".skipped"), now: $(".now"), status: $(".status"), log: $(".log"), act: $(".act"), last: -1 };
    $(".x").addEventListener("click", () => host.remove());
    ui.act.addEventListener("click", () => {
      if (run.active) stopFlag = true;
      else start(run.opts);
    });
    document.documentElement.appendChild(host);
  }

  const LABELS = { running: "Cleared so far", done: "Done / cleared", stopped: "Stopped / cleared", error: "Stuck / cleared" };

  function render() {
    if (!run) return;
    mount();
    const state = run.active ? "running" : run.state || "stopped";
    ui.p.className = "p " + state;
    ui.p.style.setProperty("--accent", run.opts.accent || "#4d5cff");
    ui.p.style.setProperty("--on-accent", fhLogo.onColor(run.opts.accent || "#4d5cff"));
    ui.state.textContent = run.opts.mode === "count" ? LABELS[state].replace(/cleared/i, (w) => (w === "Cleared" ? "Counted" : "counted")) : LABELS[state];
    const n = String(run.removed);
    const pad = "0".repeat(Math.max(0, 4 - n.length));
    ui.num.innerHTML = (run.removed ? `<span class="z">${pad}</span>${n}` : `<span class="z">0000</span>`);
    if (run.removed !== ui.last && ui.last !== -1) {
      ui.num.classList.remove("tick");
      void ui.num.offsetWidth;
      ui.num.classList.add("tick");
    }
    ui.last = run.removed;
    ui.pass.textContent = String(run.pass).padStart(2, "0");
    ui.skipped.textContent = String(run.skipped).padStart(2, "0");
    ui.now.textContent = run.target;
    ui.status.textContent = run.status + (run.active ? "…" : "");
    ui.log.replaceChildren(...lines.map((t) => Object.assign(document.createElement("div"), { textContent: t })));
    ui.act.textContent = run.active ? "Stop" : state === "done" ? "Run again" : "Start again";
    ui.act.className = "btn act" + (run.active ? " ghost" : "");
  }

  /* ---------- wiring ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "fh-start") {
      if (!run || !run.active) start(msg.opts);
      else render();
      reply({ ok: true });
    } else if (msg.type === "fh-stop") {
      stopFlag = true;
      reply({ ok: true });
    } else if (msg.type === "fh-toggle") {
      if (run && run.active) stopFlag = true;
      else chrome.storage.local.get("opts").then(({ opts }) => start(opts));
      reply({ ok: true });
    } else if (msg.type === "fh-ping") {
      reply({ ok: true, active: !!(run && run.active) });
    }
  });

  // A run that navigated or reloaded the page carries on here.
  chrome.storage.local.get("run").then(({ run: saved }) => {
    if (saved && saved.active && Date.now() - saved.ts < RESUME_WINDOW) {
      run = saved;
      run.opts = run.opts || { speed: run.speed };
      run.targets = run.targets || ["reposts"];
      run.target = run.target || run.targets[0];
      run.counts = run.counts || {};
      log("pass " + String(run.pass).padStart(2, "0"));
      main();
    } else if (saved && saved.active) {
      saved.active = false;
      saved.state = "stopped";
      chrome.storage.local.set({ run: saved });
    }
  });
})();
