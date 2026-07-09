// Shared helper: exchanges your app's Client ID + Secret for a short-lived
// access token. SoundCloud rate-limits the token endpoint itself (~50
// requests per 12h), so minting a fresh token on every cold start can take
// the whole site down — every function 429'd under normal-ish traffic on
// 2026-07-09. Three layers keep token requests rare:
//   1. in-memory cache — warm instances never re-fetch,
//   2. a shared Netlify Blobs store — cold starts and sibling functions
//      reuse one token instead of each minting their own,
//   3. stale-serving + backoff — a token past its refresh margin but not
//      hard-expired is still served if a refresh fails, and after a 429
//      nothing retries the token endpoint until the backoff passes.
// If Blobs isn't available (not enabled, local dev), everything degrades
// to the old in-memory-only behavior.
// Never expose CLIENT_SECRET to the browser — it only ever lives here,
// server-side, read from Netlify's environment variables.

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // start refreshing this long before expiry
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const BLOB_STORE = "soundcloud-auth";
const BLOB_KEY = "token";

let mem = null;      // { accessToken, expiresAt, backoffUntil } — warm-instance cache
let inFlight = null; // de-dupes concurrent refreshes within this instance

function openStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    // Lambda-compatible functions need the event to locate the Blobs
    // context; newer runtimes also inject it via environment, in which
    // case this is a harmless no-op.
    if (event && typeof blobs.connectLambda === "function") {
      try { blobs.connectLambda(event); } catch (e) {}
    }
    return blobs.getStore(BLOB_STORE);
  } catch (e) {
    return null;
  }
}

async function readShared(store) {
  try {
    return await store.get(BLOB_KEY, { type: "json" });
  } catch (e) {
    return null;
  }
}

async function writeShared(store, record) {
  try {
    await store.setJSON(BLOB_KEY, record);
  } catch (e) {}
}

// Prefer whichever record holds the longer-lived token, but honor the
// strictest backoff either side has seen.
function mergeRecords(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (b.expiresAt || 0) > (a.expiresAt || 0) ? b : a;
  return Object.assign({}, newer, {
    backoffUntil: Math.max(a.backoffUntil || 0, b.backoffUntil || 0),
  });
}

async function refreshToken(store) {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET environment variables. " +
      "Set these in your Netlify site settings under Site configuration > Environment variables."
    );
  }

  const response = await fetch("https://api.soundcloud.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json; charset=utf-8",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      // Tell every instance (via the shared store) to stop asking for a
      // while — retrying is what turns one 429 into a dead site.
      mem = Object.assign({ accessToken: null, expiresAt: 0 }, mem, {
        backoffUntil: Date.now() + RATE_LIMIT_BACKOFF_MS,
      });
      if (store) await writeShared(store, mem);
    }
    throw new Error(`SoundCloud token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  mem = {
    accessToken: data.access_token,
    // expires_in is in seconds
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000),
    backoffUntil: 0,
  };
  if (store) await writeShared(store, mem);
  return mem.accessToken;
}

// Pass the function's `event` through so the shared store can bind in
// Lambda-compatible functions; omitting it just skips the shared layer.
async function getAccessToken(event) {
  const now = Date.now();

  if (mem && mem.accessToken && now < mem.expiresAt - REFRESH_MARGIN_MS) {
    return mem.accessToken;
  }

  const store = openStore(event);

  // Another instance may already have refreshed.
  if (store) {
    mem = mergeRecords(mem, await readShared(store));
    if (mem && mem.accessToken && now < mem.expiresAt - REFRESH_MARGIN_MS) {
      return mem.accessToken;
    }
  }

  // In backoff after a 429: serve a stale-but-unexpired token rather than
  // hammer the token endpoint; with nothing usable, fail fast.
  if (mem && now < (mem.backoffUntil || 0)) {
    if (mem.accessToken && now < mem.expiresAt) return mem.accessToken;
    throw new Error(
      "SoundCloud token endpoint is rate-limited and no cached token is usable; retrying after backoff."
    );
  }

  if (!inFlight) {
    inFlight = refreshToken(store).finally(() => { inFlight = null; });
  }
  try {
    return await inFlight;
  } catch (err) {
    // The refresh failed, but a token inside its refresh margin is still
    // valid — keep the site up on the stale one.
    if (mem && mem.accessToken && Date.now() < mem.expiresAt) return mem.accessToken;
    throw err;
  }
}

module.exports = { getAccessToken };
