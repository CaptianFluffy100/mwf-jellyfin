/**
 * Service worker: fetch mute intervals from MWF (avoids browser CORS on Jellyfin origin).
 */
importScripts("lib/mwf-common.js");

const ext = globalThis.browser ?? globalThis.chrome;
const { trimSlash, parseMuteDocument } = MwfCommon;

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MWF_FETCH_MUTES") {
    fetchMutes(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({
          ok: false,
          error: String(err?.message || err),
        });
      });
    return true;
  }
  if (message?.type === "MWF_PING") {
    pingApi(message.apiBase)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }
  if (message?.type === "MWF_SET_BADGE") {
    const text = message.text || "";
    ext.action.setBadgeText({ text });
    if (message.color) {
      ext.action.setBadgeBackgroundColor({ color: message.color });
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

async function fetchMutes({ apiBase, itemId, userId }) {
  const base = trimSlash(apiBase);
  if (!base) {
    return { ok: false, error: "api_base is empty" };
  }
  if (!itemId) {
    return { ok: false, error: "item_id is empty" };
  }

  let url = `${base}/mutes/${encodeURIComponent(itemId)}`;
  if (userId) {
    url += `?user_id=${encodeURIComponent(userId)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (resp.status === 404) {
      return {
        ok: true,
        status: 404,
        mutes: [],
        error: `no mute data for item ${itemId}`,
      };
    }

    const bodyText = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: `HTTP ${resp.status}: ${bodyText.slice(0, 200)}`,
      };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (_) {
      return { ok: false, error: "invalid JSON from mute API" };
    }

    const mutes = parseMuteDocument(data);
    return {
      ok: true,
      status: 200,
      mutes,
      muteCount: mutes.length,
      url,
    };
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "fetch timed out (check api_base reachable from this machine)"
        : String(err?.message || err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function pingApi(apiBase) {
  const base = trimSlash(apiBase);
  if (!base) {
    return { ok: false, error: "api_base is empty" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${base}/health`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
