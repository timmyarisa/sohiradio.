// GET /.netlify/functions/resolve-playlist?url=<soundcloud playlist/set url>
// Returns a lightweight list of tracks in the playlist: id, title, artist,
// artwork, duration, permalink. Does NOT return stream URLs — those expire
// quickly, so we fetch a fresh one per-track right before playing it
// (see track-stream.js). This function is just for building the queue.

const { getAccessToken } = require("./_soundcloud-auth");

exports.handler = async (event) => {
  const setUrl = event.queryStringParameters && event.queryStringParameters.url;

  if (!setUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required 'url' query parameter." }),
    };
  }

  try {
    const token = await getAccessToken();

    const resolveResp = await fetch(
      `https://api.soundcloud.com/resolve?url=${encodeURIComponent(setUrl)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resolveResp.ok) {
      const text = await resolveResp.text();
      return {
        statusCode: resolveResp.status,
        body: JSON.stringify({ error: `Failed to resolve playlist: ${text}` }),
      };
    }

    const playlist = await resolveResp.json();
    const rawTracks = playlist.tracks || [];

    // Some playlist responses return "stub" tracks (id only, no title/media).
    // Split into full tracks we can use directly and stub tracks we need to
    // fetch individually.
    const fullTracks = rawTracks.filter((t) => t.title);
    const stubIds = rawTracks.filter((t) => !t.title).map((t) => t.id);

    let fetchedStubs = [];
    if (stubIds.length > 0) {
      const idsParam = stubIds.join(",");
      const tracksResp = await fetch(
        `https://api.soundcloud.com/tracks?ids=${idsParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (tracksResp.ok) {
        fetchedStubs = await tracksResp.json();
      }
    }

    const allTracks = [...fullTracks, ...fetchedStubs];
    const candidates = allTracks.filter((t) => t.streamable !== false);

    // Check each candidate's actual stream availability up front, in
    // parallel, so the returned queue only ever contains tracks that will
    // really play — instead of finding out (and skipping visibly) at
    // playback time. Not every track has been transcoded to SoundCloud's
    // current AAC-HLS format yet, especially older uploads.
    const checked = await Promise.all(
      candidates.map(async (t) => {
        try {
          const streamsResp = await fetch(
            `https://api.soundcloud.com/tracks/${t.id}/streams`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!streamsResp.ok) return null;
          const streams = await streamsResp.json();
          const hasStream = !!(streams.hls_aac_160_url || streams.hls_aac_96_url);
          return hasStream ? t : null;
        } catch (e) {
          return null;
        }
      })
    );

    const playableTracks = checked.filter(Boolean);

    const tracks = playableTracks.map((t) => ({
      id: t.id,
      title: t.title || "untitled",
      artist: (t.user && t.user.username) || "unknown artist",
      artworkUrl: t.artwork_url
        ? t.artwork_url.replace("-large", "-t500x500")
        : null,
      durationMs: t.duration || 0,
      permalinkUrl: t.permalink_url || null,
      streamable: true,
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlistTitle: playlist.title || "sohiradio",
        tracks,
        totalInPlaylist: candidates.length,
        playableCount: tracks.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
