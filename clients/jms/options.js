const ext = globalThis.browser ?? globalThis.chrome;
const { mergeConfig } = MwfCommon;

const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const testBtn = document.getElementById("testBtn");

const fields = {
  enabled: document.getElementById("enabled"),
  apiBase: document.getElementById("apiBase"),
  userIdOverride: document.getElementById("userIdOverride"),
  itemIdOverride: document.getElementById("itemIdOverride"),
  pollIntervalMs: document.getElementById("pollIntervalMs"),
  debug: document.getElementById("debug"),
};

loadInitialConfig();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const config = readForm();
  // Write sync + local so content script can fall back when sync is unavailable.
  ext.storage.local.set({ mwfConfig: config }, () => {
    ext.storage.sync.set({ mwfConfig: config }, () => {
      if (ext.runtime.lastError) {
        // Sync may fail (quota / disabled); local already saved.
        setStatus("Saved locally (sync unavailable). Reload Jellyfin if open.", true);
        return;
      }
      setStatus("Saved. Reload Jellyfin playback if already open.", true);
    });
  });
});

testBtn.addEventListener("click", () => {
  const apiBase = fields.apiBase.value.trim();
  setStatus("Testing…", true);
  ext.runtime.sendMessage({ type: "MWF_PING", apiBase }, (resp) => {
    if (ext.runtime.lastError) {
      setStatus(ext.runtime.lastError.message, false);
      return;
    }
    if (resp?.ok) {
      const db = resp.data?.database ? ` (${resp.data.database})` : "";
      setStatus(`MWF reachable at ${apiBase}${db}`, true);
    } else {
      setStatus(resp?.error || "Connection failed", false);
    }
  });
});

function storageGet(area, key) {
  return new Promise((resolve) => {
    try {
      ext.storage[area].get(key, (data) => {
        if (ext.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(data?.[key] ?? null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function loadInitialConfig() {
  const fromSync = await storageGet("sync", "mwfConfig");
  const fromLocal = fromSync ? null : await storageGet("local", "mwfConfig");
  applyToForm(mergeConfig(fromSync || fromLocal));

  // Support ?apiBase=&userId= from Profiles extension-config deep link / import.
  const params = new URLSearchParams(location.search);
  const apiBase = params.get("apiBase") || params.get("api_base");
  const userId = params.get("userId") || params.get("user_id");
  if (apiBase) fields.apiBase.value = apiBase;
  if (userId) fields.userIdOverride.value = userId;
}

function readForm() {
  return mergeConfig({
    enabled: fields.enabled.checked,
    apiBase: fields.apiBase.value.trim(),
    userIdOverride: fields.userIdOverride.value.trim(),
    itemIdOverride: fields.itemIdOverride.value.trim(),
    pollIntervalMs: Number(fields.pollIntervalMs.value) || 100,
    debug: fields.debug.checked,
  });
}

function applyToForm(config) {
  fields.enabled.checked = config.enabled !== false;
  fields.apiBase.value = config.apiBase || "";
  fields.userIdOverride.value = config.userIdOverride || "";
  fields.itemIdOverride.value = config.itemIdOverride || "";
  fields.pollIntervalMs.value = config.pollIntervalMs || 100;
  fields.debug.checked = !!config.debug;
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}
