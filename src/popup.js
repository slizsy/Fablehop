const $ = (id) => document.getElementById(id);
const go = $("go");

$("logo").innerHTML = fhLogo.svg("fablehop", 20);
$("glyph").innerHTML = fhLogo.svg("unrepost", 30);

let tab = null;
let onTikTok = false;
let run = null;
let speed = "normal";

const STATES = { running: "Running", done: "Done", stopped: "Stopped", error: "Stuck" };

function paint() {
  const active = !!(run && run.active);
  const state = active ? "running" : (run && run.state) || "";
  document.body.className = state;
  $("state").textContent = STATES[state] || "Ready";
  $("removed").textContent = run ? run.removed : 0;
  $("pass").textContent = run ? String(run.pass).padStart(2, "0") : "--";
  $("status").textContent = run && run.status ? run.status + (active ? "…" : "") : onTikTok ? "" : "Open TikTok first, then come back here.";

  document.querySelectorAll(".tag").forEach((t) => {
    const on = t.dataset.speed === speed;
    t.classList.toggle("on", on);
    t.setAttribute("aria-checked", on);
    t.disabled = active;
  });

  go.textContent = !onTikTok ? "Open TikTok ↗" : active ? "Stop" : "Start";
  go.classList.toggle("ghost", active);
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

go.addEventListener("click", async () => {
  if (!onTikTok) {
    chrome.tabs.create({ url: "https://www.tiktok.com/" });
    return window.close();
  }
  try {
    if (run && run.active) await send({ type: "fh-stop" });
    else await send({ type: "fh-start", speed });
  } catch (e) {
    $("status").textContent = "Couldn't reach the page. Reload TikTok and try again.";
    document.body.className = "error";
  }
});

$("speeds").addEventListener("click", (e) => {
  const t = e.target.closest(".tag");
  if (!t) return;
  speed = t.dataset.speed;
  chrome.storage.local.set({ speed });
  paint();
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
  const s = await chrome.storage.local.get(["run", "total", "speed"]);
  run = s.run || null;
  speed = s.speed || "normal";
  $("total").textContent = s.total || 0;
  paint();
})();
