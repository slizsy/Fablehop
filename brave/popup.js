const $ = (id) => document.getElementById(id);
const go = $("go");

const DEFAULTS = { speed: "normal", targets: ["reposts"], limit: 0, mode: "remove", keep: "", accent: "#4d5cff" };
let opts = { ...DEFAULTS };
let tab = null;
let onTikTok = false;
let run = null;

const STATES = { running: "Running", done: "Done", stopped: "Stopped", error: "Stuck" };
const saveOpts = () => chrome.storage.local.set({ opts });

function logos() {
  const root = document.documentElement.style;
  root.setProperty("--accent", opts.accent);
  root.setProperty("--on-accent", fhLogo.onColor(opts.accent));
  $("logo").innerHTML = fhLogo.svg("fablehop", 20, { "#": opts.accent });
  $("glyph").innerHTML = fhLogo.svg("unrepost", 30, { "#": opts.accent });
}

function paint() {
  const active = !!(run && run.active);
  const state = active ? "running" : (run && run.state) || "";
  document.body.className = state;
  $("state").textContent = STATES[state] || "Ready";
  $("removed").textContent = run ? run.removed : 0;
  $("pass").textContent = run ? String(run.pass).padStart(2, "0") : "--";
  $("status").textContent = run && run.status ? run.status + (active ? "…" : "") : onTikTok ? "" : "Open TikTok first, then come back here.";

  document.querySelectorAll(".tags[data-opt]").forEach((group) => {
    const v = opts[group.dataset.opt];
    group.querySelectorAll(".tag").forEach((t) => t.classList.toggle("on", Array.isArray(v) ? v.includes(t.dataset.val) : t.dataset.val === String(v)));
  });
  $("what").textContent = opts.targets.join(", ").replace(/, ([^,]*)$/, " and $1");

  go.textContent = !onTikTok ? "Open TikTok ↗" : active ? "Stop" : opts.mode === "count" ? "Start counting" : "Start";
  go.classList.toggle("ghost", active);
}

// Anything in the Options view with data-opt="name" reads and writes opts.name.
function bindOptions() {
  document.querySelectorAll("[data-opt]").forEach((el) => {
    const key = el.dataset.opt;
    if (el.classList.contains("tags")) {
      el.addEventListener("click", (e) => {
        const t = e.target.closest(".tag");
        if (!t) return;
        if (el.hasAttribute("data-multi")) {
          const on = opts[key].includes(t.dataset.val);
          const next = [...el.querySelectorAll(".tag")].map((x) => x.dataset.val).filter((v) => (v === t.dataset.val ? !on : opts[key].includes(v)));
          if (!next.length) return; // keep at least one picked
          opts[key] = next;
        } else opts[key] = t.dataset.val;
        saveOpts();
        logos();
        paint();
      });
    } else {
      el.value = opts[key] || "";
      el.addEventListener("input", () => {
        opts[key] = el.type === "number" ? Math.max(0, parseInt(el.value, 10) || 0) : el.value;
        saveOpts();
      });
    }
  });
}

async function send(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // tab was open before the extension was loaded: put the script in now
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["logo.js", "content.js"] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

function fail() {
  $("status").textContent = "Couldn't reach the page. Reload TikTok and try again.";
  document.body.className = "error";
}

go.addEventListener("click", async () => {
  if (!onTikTok) {
    chrome.tabs.create({ url: "https://www.tiktok.com/" });
    return window.close();
  }
  try {
    if (run && run.active) await send({ type: "fh-stop" });
    else await send({ type: "fh-start", opts });
  } catch {
    fail();
  }
});

// Reports what the extension can see on the page, for when a run gets stuck.
$("check").addEventListener("click", async () => {
  const out = $("check-out");
  out.hidden = false;
  out.replaceChildren();
  const line = (ok, text) => out.appendChild(Object.assign(document.createElement("div"), { className: ok ? "ok" : "no", textContent: text }));
  if (!onTikTok) return line(false, "This tab is not TikTok");
  try {
    const r = await send({ type: "fh-check" });
    line(r.loggedIn, r.loggedIn ? "Logged in" : "Not logged in, or TikTok is still loading");
    line(r.mine, r.mine ? "On your profile" : "Not on your profile yet (start opens it)");
    if (r.mine) for (const t in r.tabs) line(r.tabs[t], (r.tabs[t] ? "Found the " : "Can't see the ") + t + " tab");
  } catch {
    line(false, "Couldn't reach the page. Reload TikTok.");
  }
});

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("main section").forEach((s) => (s.hidden = s.id !== "v-" + b.dataset.view));
});

/* ---------- log ---------- */

let cleared = [];

function paintLog() {
  const list = $("log-list");
  $("log-count").textContent = cleared.length ? cleared.length + " cleared" : "Nothing cleared yet";
  list.replaceChildren();
  if (!cleared.length) {
    list.innerHTML = '<div class="none">Cleared videos show up here.</div>';
    return;
  }
  cleared.slice(-200).reverse().forEach((e) => {
    const a = document.createElement("a");
    a.href = e.url;
    a.target = "_blank";
    a.rel = "noopener";
    const who = (e.url.match(/@[^/]+/) || ["video"])[0];
    const when = new Date(e.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    for (const [cls, text] of [["k", e.kind], ["w", who], ["t", when]]) {
      a.appendChild(Object.assign(document.createElement("span"), { className: cls, textContent: text }));
    }
    list.appendChild(a);
  });
}

const logText = () => cleared.map((e) => e.url).join("\n");

$("log-copy").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(logText());
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy links"), 1200);
});
$("log-save").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([logText() + "\n"], { type: "text/plain" }));
  a.download = "fablehop-unrepost-log.txt";
  a.click();
});
$("log-clear").addEventListener("click", () => {
  cleared = [];
  chrome.storage.local.set({ cleared });
  paintLog();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.history) {
    cleared = changes.history.newValue || [];
    paintLog();
  }
  if (changes.run) run = changes.run.newValue;
  if (changes.total) $("total").textContent = changes.total.newValue;
  paint();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  onTikTok = !!(tab && tab.url && tab.url.startsWith("https://www.tiktok.com/"));
  if (!onTikTok && tab) {
    // the browser may hide the tab's address from us: ask the page directly instead
    try {
      onTikTok = !!(await chrome.tabs.sendMessage(tab.id, { type: "fh-ping" })).ok;
    } catch {}
  }
  const s = await chrome.storage.local.get(["run", "total", "opts", "history"]);
  cleared = s.history || [];
  paintLog();
  run = s.run || null;
  opts = { ...DEFAULTS, ...s.opts };
  $("total").textContent = s.total || 0;
  logos();
  bindOptions();
  paint();
})();
