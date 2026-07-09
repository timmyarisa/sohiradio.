// GET /.netlify/functions/stream-proxy?url=<encoded soundcloud stream URL>
//
// SoundCloud's HLS stream URLs (manifest AND every segment they reference)
// require an Authorization: Bearer header on every single request. Browsers
// can't attach custom headers to <video src="..."> or hls.js's default
// segment loader, which is exactly why native/hls.js playback was getting
// 401 Unauthorized. This function fetches everything server-side (where we
// can attach the header), and for the manifest specifically, rewrites every
// segment URL inside it to point back through this same proxy — so the
// player never needs to make an authenticated request itself.

const { getAccessToken } = require("./_soundcloud-auth");

exports.handler = async (event) => {
  const targetUrl = event.queryStringParameters && event.queryStringParameters.url;

  if (!targetUrl) {
    return { statusCode: 400, body: "Missing required 'url' query parameter." };
  }

  try {
    const token = await getAccessToken();
    const upstream = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return { statusCode: upstream.status, body: `Upstream error: ${text}` };
    }

    const contentType = upstream.headers.get("content-type") || "";
    const isManifest =
      contentType.includes("mpegurl") ||
      contentType.includes("m3u8") ||
      targetUrl.includes("/hls");

    if (isManifest) {
      const manifestText = await upstream.text();
      const rewritten = manifestText
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          // This line is a segment (or nested playlist) URL — resolve it
          // relative to the manifest's own URL.
          let resolved;
          try {
            resolved = new URL(trimmed, targetUrl);
          } catch (e) {
            return `/.netlify/functions/stream-proxy?url=${encodeURIComponent(trimmed)}`;
          }
          // Segment URLs on SoundCloud's CDN are pre-signed (CloudFront
          // Policy/Signature params) and served with open CORS, so the
          // browser can fetch them directly — routing the audio bytes
          // through this function would only add latency and bandwidth
          // cost. Only api.soundcloud.com URLs (e.g. nested playlists)
          // still require the Bearer header, so only those come back
          // through the proxy.
          if (resolved.hostname === "api.soundcloud.com") {
            return `/.netlify/functions/stream-proxy?url=${encodeURIComponent(resolved.toString())}`;
          }
          return resolved.toString();
        })
        .join("\n");

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
        body: rewritten,
      };
    }

    // Binary segment data (audio chunks) — pass through as base64.
    const arrayBuffer = await upstream.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType || "video/mp2t",
        "Cache-Control": "public, max-age=3600",
      },
      body: base64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: `Proxy error: ${err.message}` };
  }
};
