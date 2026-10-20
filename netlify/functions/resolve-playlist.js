// GET /.netlify/functions/resolve-playlist?url=<soundcloud playlist/set url>
// Returns a lightweight list of tracks in the playlist: id, title, artist,
// artwork, duration, permalink. Does NOT return stream URLs — those expire
// quickly, so we fetch a fresh one per-track right before playing it
// (see track-stream.js). This function is just for building the queue.

const { getAccessToken, openStore } = require("./_soundcloud-auth");

// Resolving a playlist means checking every track's actual stream
// availability (see below) — one /streams call per track, and SoundCloud
// counts those against the app's daily play-request quota. A 10-minute
// per-instance cache re-ran the whole sweep on every cold start, and on
// 2026-10-19 that burned the quota and 429'd every stream on the site.
// So the result is cached for hours in a shared Netlify Blobs store (every
// instance reuses one sweep), and a stale copy is served rather than
// re-sweeping while SoundCloud is refusing requests.
const playlistCache = new Map(); // setUrl -> { data, expiresAt } — warm-instance layer
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEGRADED_TTL_MS = 2 * 60 * 1000;   // a sweep with transient failures isn't kept long
const BLOB_STORE = "playlist-cache";

function blobKey(setUrl) {
  return encodeURIComponent(setUrl);
}

async function readShared(store, setUrl) {
  if (!store) return null;
  try {
    return await store.get(blobKey(setUrl), { type: "json" });
  } catch (e) {
    return null;
  }
}

async function writeShared(store, setUrl, record) {
  if (!store) return;
  try {
    await store.setJSON(blobKey(setUrl), record);
  } catch (e) {}
}

function ok(data) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

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
    return ok(cached.data);
  }

  const store = openStore(BLOB_STORE, event);
  const shared = await readShared(store, setUrl);
  if (shared && Date.now() < shared.expiresAt) {
    playlistCache.set(setUrl, shared);
    return ok(shared.data);
  }

  try {
    const token = await getAccessToken(event);

    const resolveResp = await fetch(
      `https://api.soundcloud.com/resolve?url=${encodeURIComponent(setUrl)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resolveResp.ok) {
      const text = await resolveResp.text();
      if (shared) return ok(shared.data);
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
    let stubFetchStatus = null; // null = no stubs to fetch; else the batch HTTP status
    if (stubIds.length > 0) {
      const idsParam = stubIds.join(",");
      const tracksResp = await fetch(
        `https://api.soundcloud.com/tracks?ids=${idsParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      stubFetchStatus = tracksResp.status;
      if (tracksResp.ok) {
        fetchedStubs = await tracksResp.json();
      }
    }

    const allTracks = [...fullTracks, ...fetchedStubs];
    const candidates = allTracks.filter((t) => t.streamable !== false);
    const excluded = allTracks
      .filter((t) => t.streamable === false)
      .map((t) => ({ id: t.id, title: t.title || "untitled", reason: "owner-blocked" }));

    // Reconcile stubs against what actually came back. Any stub id the batch
    // fetch didn't return — a whole-batch failure, or SoundCloud silently
    // omitting some ids from an otherwise-OK response — would vanish from BOTH
    // the queue and the excluded list, so "0 excluded" wouldn't mean "every
    // playlist entry accounted for." Surface each dropped stub instead.
    if (stubIds.length > 0) {
      const returnedIds = new Set(fetchedStubs.map((t) => t.id));
      for (const id of stubIds) {
        if (returnedIds.has(id)) continue;
        excluded.push({
          id,
          title: "untitled",
          reason: stubFetchStatus && stubFetchStatus !== 200
            ? `stub-fetch-${stubFetchStatus}`
            : "stub-omitted-by-api",
        });
      }
    }

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
            // Any full HLS stream counts — AAC preferred, but some tracks
            // only offer MP3-HLS. preview_* fields are 30s teasers and
            // deliberately don't count.
            const ok = !!(streams.hls_aac_160_url || streams.hls_aac_96_url || streams.hls_mp3_128_url);
            if (ok) return { track: t, playable: true, reason: null };
            // No legacy /stream probe here: it's another play request
            // against the quota, spent only on diagnostics.
            return {
              track: t,
              playable: false,
              reason: "no-hls-stream",
              streamKeys: Object.keys(streams),
            };
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
        excluded.push({
          id: r.track.id,
          title: r.track.title || "untitled",
          reason: r.reason,
          streamKeys: r.streamKeys || undefined,
        });
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
      // Raw playlist size — includes stubs the API dropped (now surfaced in
      // `excluded`), so this holds the invariant totalInPlaylist === playableCount + excluded.length.
      totalInPlaylist: rawTracks.length,
      playableCount: tracks.length,
    };

    // A 429/5xx/unreachable track isn't really unplayable — the sweep just
    // couldn't check it. Never let such a sweep replace a good cached one.
    const degraded = results.some(
      (r) => !r.playable && /^streams-endpoint-(429|5\d\d|unreachable)$/.test(r.reason)
    );
    if (degraded && shared) {
      playlistCache.set(setUrl, { data: shared.data, expiresAt: Date.now() + DEGRADED_TTL_MS });
      return ok(shared.data);
    }

    const record = {
      data: responseData,
      expiresAt: Date.now() + (degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS),
    };
    playlistCache.set(setUrl, record);
    if (!degraded) await writeShared(store, setUrl, record);

    return ok(responseData);
  } catch (err) {
    if (shared) return ok(shared.data);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
