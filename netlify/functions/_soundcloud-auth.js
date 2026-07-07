// Shared helper: exchanges your app's Client ID + Secret for a short-lived
// access token, and caches it in memory so we're not re-authenticating on
// every single request. Never expose CLIENT_SECRET to the browser — it only
// ever lives here, server-side, read from Netlify's environment variables.

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();

  // Reuse the cached token if it's still valid (with a 60s safety margin)
  if (cachedToken && now < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }

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
    throw new Error(`SoundCloud token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // expires_in is in seconds
  cachedTokenExpiresAt = now + (data.expires_in ? data.expires_in * 1000 : 3600000);

  return cachedToken;
}

module.exports = { getAccessToken };
