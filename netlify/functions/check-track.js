// GET /.netlify/functions/check-track?url=<soundcloud track url>
// Curation helper: given any public SoundCloud track URL, reports whether
// the track will actually stream on sohiradio (full-length HLS available
// via the API) or is rights-holder blocked (preview-only / nothing).
// Used by /check.html.

const { getAccessToken } = require("./_soundcloud-auth");

exports.handler = async (event) => {
  const url = event.queryStringParameters && event.queryStringParameters.url;

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required 'url' query parameter." }),
    };
  }

  try {
    const token = await getAccessToken(event);

    const resolveResp = await fetch(
      `https://api.soundcloud.com/resolve?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resolveResp.ok) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "SoundCloud couldn't find that URL. Check it's a public track link.",
        }),
      };
    }

    const thing = await resolveResp.json();

    if (thing.kind !== "track") {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `That resolves to a ${thing.kind || "page"}, not a track — paste a single track's URL.`,
        }),
      };
    }

    const info = {
      id: thing.id,
      title: thing.title || "untitled",
      artist: (thing.user && thing.user.username) || "unknown artist",
      artworkUrl: thing.artwork_url
        ? thing.artwork_url.replace("-large", "-t500x500")
        : null,
      durationMs: thing.duration || 0,
      permalinkUrl: thing.permalink_url || url,
    };

    if (thing.streamable === false) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...info,
          playable: false,
          reason: "The uploader has disabled streaming outside SoundCloud.",
        }),
      };
    }

    const streamsResp = await fetch(
      `https://api.soundcloud.com/tracks/${thing.id}/streams`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!streamsResp.ok) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...info,
          playable: false,
          reason: `SoundCloud won't share stream info for this track (${streamsResp.status}).`,
        }),
      };
    }

    const streams = await streamsResp.json();
    const quality = streams.hls_aac_160_url
      ? "AAC 160k"
      : streams.hls_aac_96_url
        ? "AAC 96k"
        : streams.hls_mp3_128_url
          ? "MP3 128k"
          : null;

    if (quality) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...info, playable: true, quality }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...info,
        playable: false,
        reason: streams.preview_mp3_128_url
          ? "Rights holder only allows a 30-second preview off-platform."
          : "No stream of any kind is offered for this track.",
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
