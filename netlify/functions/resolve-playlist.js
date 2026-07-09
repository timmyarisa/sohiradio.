// GET /.netlify/functions/resolve-playlist?url=<soundcloud playlist/set url>
// Returns a lightweight list of tracks in the playlist: id, title, artist,
// artwork, duration, permalink. Does NOT return stream URLs — those expire
// quickly, so we fetch a fresh one per-track right before playing it
// (see track-stream.js). This function is just for building the queue.

const { getAccessToken } = require("./_soundcloud-auth");

// Resolving a playlist means checking every track's actual stream
// availability (see below), which is a lot of SoundCloud API calls. The
// playlist rarely changes, so cache the final response per setUrl and reuse
// it across requests for as long as the function instance stays warm —
// same pattern as the token cache in _soundcloud-auth.js.
const playlistCache = new Map(); // setUrl -> { data, expiresAt }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

exports.handler = async (event) => {
  const setUrl = event.queryStringParameters && event.queryStringParameters.url;

  if (!setUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required 'url' query parameter." }),
    };
  }

  const cached = playlistCache.get(setUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cached.data),
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
    const excluded = allTracks
      .filter((t) => t.streamable === false)
      .map((t) => ({ id: t.id, title: t.title || "untitled", reason: "owner-blocked" }));

    // Check each candidate's actual stream availability up front, so the
    // returned queue only ever contains tracks that will really play —
    // instead of finding out (and skipping visibly) at playback time. Not
    // every track has been transcoded to SoundCloud's current AAC-HLS
    // format yet, especially older uploads.
    //
    // Deliberately NOT all in parallel: firing dozens of simultaneous
    // calls gets some of them rate-limited (429), which made playable
    // tracks randomly vanish from the queue. Limited concurrency plus one
    // retry keeps the result stable.
    async function checkTrack(t) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const streamsResp = await fetch(
            `https://api.soundcloud.com/tracks/${t.id}/streams`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (streamsResp.ok) {
            const streams = await streamsResp.json();
            const ok = !!(streams.hls_aac_160_url || streams.hls_aac_96_url);
            return { track: t, playable: ok, reason: ok ? null : "no-hls-stream" };
          }
          if ((streamsResp.status === 429 || streamsResp.status >= 500) && attempt === 0) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          return { track: t, playable: false, reason: `streams-endpoint-${streamsResp.status}` };
        } catch (e) {
          if (attempt === 0) continue;
          return { track: t, playable: false, reason: "streams-endpoint-unreachable" };
        }
      }
      return { track: t, playable: false, reason: "streams-endpoint-unreachable" };
    }

    const CONCURRENCY = 5;
    const pending = [...candidates];
    const results = [];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        while (pending.length > 0) {
          results.push(await checkTrack(pending.shift()));
        }
      })
    );

    const playableIds = new Set(
      results.filter((r) => r.playable).map((r) => r.track.id)
    );
    // Filter the original list (not the pool results) to keep playlist order.
    const playableTracks = candidates.filter((t) => playableIds.has(t.id));
    for (const r of results) {
      if (!r.playable) {
        excluded.push({ id: r.track.id, title: r.track.title || "untitled", reason: r.reason });
      }
    }

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

    const responseData = {
      playlistTitle: playlist.title || "sohiradio",
      tracks,
      excluded,
      totalInPlaylist: allTracks.length,
      playableCount: tracks.length,
    };

    playlistCache.set(setUrl, {
      data: responseData,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseData),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
