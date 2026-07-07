// GET /.netlify/functions/track-stream?id=<track id>
// Returns a fresh, signed, temporary stream URL for one track. Fetched
// on-demand right before playback (not upfront for the whole playlist),
// since these signed URLs expire.

const { getAccessToken } = require("./_soundcloud-auth");

exports.handler = async (event) => {
  const trackId = event.queryStringParameters && event.queryStringParameters.id;

  if (!trackId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required 'id' query parameter." }),
    };
  }

  try {
    const token = await getAccessToken();

    // Fetch full track details to get the list of available transcodings
    const trackResp = await fetch(`https://api.soundcloud.com/tracks/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!trackResp.ok) {
      const text = await trackResp.text();
      return {
        statusCode: trackResp.status,
        body: JSON.stringify({ error: `Failed to fetch track: ${text}` }),
      };
    }

    const track = await trackResp.json();

    if (track.streamable === false) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: "This track's owner has disabled streaming outside SoundCloud.",
        }),
      };
    }

    const transcodings = (track.media && track.media.transcodings) || [];

    // Prefer a plain progressive MP3 stream — simplest for a native <audio> element.
    // Fall back to HLS if that's all that's available.
    const progressive = transcodings.find(
      (t) => t.format && t.format.protocol === "progressive"
    );
    const chosen = progressive || transcodings[0];

    if (!chosen) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No playable stream found for this track." }),
      };
    }

    const streamInfoResp = await fetch(chosen.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!streamInfoResp.ok) {
      const text = await streamInfoResp.text();
      return {
        statusCode: streamInfoResp.status,
        body: JSON.stringify({ error: `Failed to get stream URL: ${text}` }),
      };
    }

    const streamInfo = await streamInfoResp.json();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamUrl: streamInfo.url,
        protocol: chosen.format.protocol,
        title: track.title,
        artist: (track.user && track.user.username) || "unknown artist",
        artworkUrl: track.artwork_url
          ? track.artwork_url.replace("-large", "-t500x500")
          : null,
        durationMs: track.duration || 0,
        permalinkUrl: track.permalink_url || null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
