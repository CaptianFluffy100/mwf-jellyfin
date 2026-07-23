const ext = globalThis.browser ?? globalThis.chrome;

document.getElementById("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  ext.runtime.openOptionsPage();
});

function render(status, config) {
  const root = document.getElementById("root");
  if (!status) {
    root.innerHTML =
      '<p class="off">Open a Jellyfin tab and start playback. Configure <code>api_base</code> in Options first.</p>';
    return;
  }

  const enabled = status.enabled !== false && config?.enabled !== false;
  const lines = [
    ["Filtering", enabled ? "ON" : "OFF"],
    ["MWF API", status.apiBase || config?.apiBase || "(not set)"],
    ["User", status.userId || "(unknown)"],
    ["Item", status.itemId || "(none)"],
    ["Mute ranges", String(status.muteCount ?? 0)],
    [
      "Currently muted",
      status.currentlyMuted
        ? '<span class="muted-yes">yes</span>'
        : '<span class="muted-no">no</span>',
    ],
  ];

  if (status.lastError) {
    lines.push(["Last error", `<span class="err">${escapeHtml(status.lastError)}</span>`]);
  }

  const dl = lines
    .map(
      ([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${value.startsWith("<") ? value : escapeHtml(value)}</dd>`,
    )
    .join("");

  root.innerHTML = `<dl>${dl}</dl>`;
}

ext.storage.local.get("mwfStatus", (local) => {
  ext.storage.sync.get("mwfConfig", (sync) => {
    render(local?.mwfStatus, sync?.mwfConfig);
  });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
