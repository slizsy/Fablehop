const $ = (id) => document.getElementById(id);
const go = $("go");

const DEFAULTS = { speed: "normal" };
let opts = { ...DEFAULTS };
let tab = null;
let onTikTok = false;
let run = null;

const STATES = { running: "Running", done: "Done", stopped: "Stopped", error: "Stuck" };
const saveOpts = () => chrome.storage.local.set({ opts });

function logos() {
  $("logo").innerHTML = fhLogo.svg("fablehop", 20);
  $("glyph").innerHTML = fhLogo.svg("unrepost", 30);
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
    group.querySelectorAll(".tag").forEach((t) => t.classList.toggle("on", t.dataset.val === String(opts[group.dataset.opt])));
  });

  go.textContent = !onTikTok ? "Open TikTok ↗" : active ? "Stop" : "Start";
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
        opts[key] = t.dataset.val;
        saveOpts();
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

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("main section").forEach((s) => (s.hidden = s.id !== "v-" + b.dataset.view));
});

chrome.storage.onChanged.addListener((changes) => {
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
  const s = await chrome.storage.local.get(["run", "total", "opts"]);
  run = s.run || null;
  opts = { ...DEFAULTS, ...s.opts };
  $("total").textContent = s.total || 0;
  logos();
  bindOptions();
  paint();
})();
