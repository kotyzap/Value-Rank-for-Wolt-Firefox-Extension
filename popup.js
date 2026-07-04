/* Popup: feature on/off toggle + light/dark theme switch. */

const enabledToggle = document.getElementById("enabledToggle");
const topNSelect = document.getElementById("topNSelect");
const themeToggle = document.getElementById("themeToggle");
const root = document.documentElement;

chrome.storage.local.get({ enabled: true, topN: 8 }, ({ enabled, topN }) => {
  enabledToggle.checked = enabled !== false;
  topNSelect.value = String([4, 8, 12, 16, 20].includes(+topN) ? +topN : 8);
});

enabledToggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledToggle.checked });
});

topNSelect.addEventListener("change", () => {
  chrome.storage.local.set({ topN: parseInt(topNSelect.value, 10) });
});

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
}
chrome.storage.local.get({ theme: "light" }, ({ theme }) => applyTheme(theme));
themeToggle.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage.local.set({ theme: next });
});
