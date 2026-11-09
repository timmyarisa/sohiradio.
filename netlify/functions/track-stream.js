// GET /.netlify/functions/track-stream?id=<track id>
// Returns a fresh, signed, temporary stream URL for one track. Fetched
// on-demand right before playback (not upfront for the whole playlist),
// since these signed URLs expire. Track metadata is NOT included — the
// client already holds it from resolve-playlist.

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

    // Only the stream URL comes from here. Title, artist, artwork and
    // permalink already arrive with the queue from resolve-playlist (which
    // also drops non-streamable tracks), so a /tracks/:id call per song
    // change just spent SoundCloud quota twice for data the client had.
    // As of Dec 2025, SoundCloud only serves AAC-HLS streams — progressive
    // MP3 and HLS-MP3/Opus were removed.
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
      body: JSON.stringify({ id: Number(trackId), streamUrl, protocol: "hls" }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
