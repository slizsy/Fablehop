// Fablehop Unrepost: walks your Reposts tab and un-reposts each video.
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

  function findRepostTab() {
    return (
      first(['[data-e2e="repost-tab"]', '[class*="PRepost"]']) ||
      [...document.querySelectorAll('[role="tab"], [class*="Tab"] p, [class*="Tab"] span')].find(
        (el) => visible(el) && /^reposts?$/i.test(el.textContent.trim())
      ) ||
      null
    );
  }

  function findRepostItem() {
    return first([
      '[data-e2e="user-repost-item"] a[href]',
      '[data-e2e="user-repost-item"]',
      '[data-e2e="user-repost-item-list"] a[href*="/video/"]',
      '[data-e2e="user-repost-item-list"] a[href*="/photo/"]',
      '[class*="DivVideoContainer"]',
    ]);
  }

  const findRepostBtn = () =>
    first([
      '[data-e2e="video-share-repost"]',
      '[data-e2e="browse-repost"]',
      '[data-e2e*="repost"]:is(button, [role="button"])',
      'button[aria-label*="epost"]',
    ]);

  const findNext = () => first(['[data-e2e="arrow-right"]', 'button[aria-label="Go to next video"]']);
  const findClose = () => first(['[data-e2e="browse-close"]', 'button[aria-label="Close"]']);

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

    status("Opening the Reposts tab");
    const tab = await waitFor(findRepostTab, 12000);
    if (!tab) return finish("error", "No Reposts tab on this profile.");
    tab.click();
    await pause(1800);
    if (tab.hasAttribute("aria-selected") && tab.getAttribute("aria-selected") !== "true") {
      tab.click();
      await pause(1500);
    }

    status("Looking for reposts");
    let item = await waitFor(findRepostItem, 8000);
    if (!item) {
      // TikTok sometimes shows an empty grid until you scroll
      window.scrollTo(0, document.documentElement.scrollHeight);
      item = await waitFor(findRepostItem, 4000);
      window.scrollTo(0, 0);
    }
    if (!item) return emptyPass(false);
    run.empty = 0;
    item.click();
    await pause(1200);

    const delay = SPEEDS[run.speed] || SPEEDS.normal;
    const seen = new Set();
    let passRemoved = 0;
    let passSkipped = 0;

    status("Removing reposts");
    while (true) {
      const id = videoId();
      if (seen.has(id)) break;
      seen.add(id);

      const btn = await waitFor(findRepostBtn, 6000);
      // aria-pressed="false" would mean it is not reposted, and a click would repost it
      if (btn && btn.getAttribute("aria-pressed") !== "false") {
        btn.click();
        run.removed++;
        passRemoved++;
        bumpTotal();
        log("removed  " + String(id).slice(-10));
      } else {
        run.skipped++;
        passSkipped++;
        log("skipped  " + String(id).slice(-10));
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
    run.empty = 0;
    if (stuck) return finish("error", "Couldn't find the repost button. TikTok may have changed its layout.");
    return finish("done", run.removed ? "All clear. No reposts left." : "No reposts found. Nothing to remove.");
  }

  function start(o) {
    const opts = Object.assign({ speed: "normal" }, o);
    run = { active: true, state: "running", removed: 0, skipped: 0, pass: 1, speed: opts.speed, opts, status: "Starting", ts: Date.now() };
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
    .stat { flex: 1; padding: 6px 10px; border: 1px solid var(--border); margin-left: -1px; }
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
      background: var(--accent); color: #fff; border: 1px solid var(--accent);
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
          ${fhLogo.svg("fablehop", 18)}<span>FABLEHOP<sup>°</sup></span>
          <span class="where">UNREPOST</span>
          <button class="x" title="Hide panel" aria-label="Hide panel">×</button>
        </div>
        <div class="scan"><i></i></div>
        <div class="body">
          <div class="label"><span class="sq"></span><span class="state"></span></div>
          <div class="num"></div>
          <div class="stats">
            <div class="stat"><div class="l">Pass</div><div class="v pass"></div></div>
            <div class="stat"><div class="l">Skipped</div><div class="v skipped"></div></div>
            <div class="stat"><div class="l">Speed</div><div class="v speed"></div></div>
          </div>
          <div class="status"></div>
          <div class="log"></div>
          <button class="btn act"></button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { p: $(".p"), state: $(".state"), num: $(".num"), pass: $(".pass"), skipped: $(".skipped"), speed: $(".speed"), status: $(".status"), log: $(".log"), act: $(".act"), last: -1 };
    $(".x").addEventListener("click", () => host.remove());
    ui.act.addEventListener("click", () => {
      if (run.active) stopFlag = true;
      else start(run.opts);
    });
    document.documentElement.appendChild(host);
  }

  const LABELS = { running: "Removed so far", done: "Done / removed", stopped: "Stopped / removed", error: "Stuck / removed" };

  function render() {
    if (!run) return;
    mount();
    const state = run.active ? "running" : run.state || "stopped";
    ui.p.className = "p " + state;
    ui.state.textContent = LABELS[state];
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
    ui.speed.textContent = run.speed;
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
    } else if (msg.type === "fh-ping") {
      reply({ ok: true, active: !!(run && run.active) });
    }
  });

  // A run that navigated or reloaded the page carries on here.
  chrome.storage.local.get("run").then(({ run: saved }) => {
    if (saved && saved.active && Date.now() - saved.ts < RESUME_WINDOW) {
      run = saved;
      run.opts = run.opts || { speed: run.speed };
      log("pass " + String(run.pass).padStart(2, "0"));
      main();
    } else if (saved && saved.active) {
      saved.active = false;
      saved.state = "stopped";
      chrome.storage.local.set({ run: saved });
    }
  });
})();
