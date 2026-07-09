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
    const token = await getAccessToken(event);

    // Track metadata (title, artist, artwork, etc.)
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

    // As of Dec 2025, SoundCloud only serves AAC-HLS streams — progressive
    // MP3 and HLS-MP3/Opus were removed. This is a separate endpoint from
    // the track resource itself.
    const streamsResp = await fetch(
      `https://api.soundcloud.com/tracks/${trackId}/streams`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!streamsResp.ok) {
      const text = await streamsResp.text();
      return {
        statusCode: streamsResp.status,
        body: JSON.stringify({ error: `Failed to get streams: ${text}` }),
      };
    }

    const streams = await streamsResp.json();
    // Prefer the higher-quality 160k AAC stream, fall back to 96k AAC,
    // then MP3-HLS (some tracks are only transcoded to that). These are
    // already final, playable HLS manifest URLs — no extra resolution
    // step needed (confirmed: fetching one directly returns real #EXTM3U
    // playlist content, not a JSON wrapper). preview_* streams are 30s
    // teasers and never used.
    const streamUrl =
      streams.hls_aac_160_url || streams.hls_aac_96_url || streams.hls_mp3_128_url;

    if (!streamUrl) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No full-length HLS stream found for this track." }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: track.id,
        streamUrl,
        protocol: "hls",
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
