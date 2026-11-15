// Toolbar badge: a live count while a run is going, then a tick or a "!" when it ends.
function badge(run) {
  const ended = run && !run.active;
  const text = !run ? "" : run.active ? String(run.removed) : run.state === "done" ? "✓" : run.state === "error" ? "!" : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: ended && run.state === "error" ? "#ff4d4d" : "#4d5cff" });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.run) badge(changes.run.newValue);
});
chrome.storage.local.get("run").then(({ run }) => badge(run && run.active ? run : null));

// Alt+Shift+U starts or stops a run on the TikTok tab you are looking at.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-run") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fh-toggle" });
  } catch {
    // not a TikTok tab
  }
});
