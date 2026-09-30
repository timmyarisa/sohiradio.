// Local dev server for sohiradio — zero dependencies, Node built-ins only.
//
// Why this exists: the app is a static frontend (index.html) plus Netlify
// serverless functions (netlify/functions/*). In production Netlify serves
// both. Locally, `netlify dev` would too, but that requires the Netlify CLI
// and the SoundCloud secrets. This tiny server covers local previewing
// without the CLI: it serves the static files and, for any request to
// /.netlify/functions/<name>, loads that function module and invokes its
// handler with a Netlify-shaped event — the same contract the functions
// already expect.
//
// Audio needs SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET in the env
// (the token exchange lives in netlify/functions/_soundcloud-auth.js). Without
// them the function endpoints respond 500 and the UI still loads — you just
// won't get playback. Set them inline to enable audio locally:
//   SOUNDCLOUD_CLIENT_ID=xxx SOUNDCLOUD_CLIENT_SECRET=yyy node dev-server.js
//
// Committed (not in a scratchpad) so the launch config keeps working across
// sessions. Referenced by .claude/launch.json.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const FN_DIR = path.join(ROOT, "netlify", "functions");
const FN_PREFIX = "/.netlify/functions/";

// Honor the port launch.json passes; fall back to 8642. autoPort in the
// launch config means the harness may bump this if it's taken.
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8642;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers || {});
  res.end(body);
}

// Invoke a Netlify function handler with a Lambda-compatible event.
async function runFunction(name, url, req, res) {
  const file = path.join(FN_DIR, name + ".js");
  if (!fs.existsSync(file)) {
    return send(res, 404, { "Content-Type": "text/plain" }, `No function '${name}'`);
  }
  let mod;
  try {
    // Clear require cache each call so edits to a function are picked up
    // without restarting the server.
    delete require.cache[require.resolve(file)];
    mod = require(file);
  } catch (err) {
    return send(res, 500, { "Content-Type": "text/plain" }, "Load error: " + err.message);
  }
  if (typeof mod.handler !== "function") {
    return send(res, 500, { "Content-Type": "text/plain" }, `Function '${name}' has no handler export`);
  }

  const qs = {};
  url.searchParams.forEach((v, k) => { qs[k] = v; });
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters: qs,
    headers: req.headers,
    body: null,
    isBase64Encoded: false,
  };

  try {
    const result = await mod.handler(event, {});
    const headers = Object.assign({}, result.headers);
    let body = result.body;
    if (result.isBase64Encoded && typeof body === "string") {
      body = Buffer.from(body, "base64");
    }
    send(res, result.statusCode || 200, headers, body);
  } catch (err) {
    send(res, 500, { "Content-Type": "application/json" }, JSON.stringify({ error: err.message }));
  }
}

function serveStatic(url, req, res) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  // Prevent path traversal.
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    // Safari refuses to play <video> from a server that ignores Range, so
    // honour single byte ranges (all a media element ever asks for).
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      const size = stat.size;
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start < 0) start = 0;
      if (start > end || start >= size) {
        return send(res, 416, { "Content-Range": `bytes */${size}` });
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
      });
      return void fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith(FN_PREFIX)) {
    const name = url.pathname.slice(FN_PREFIX.length).split("/")[0];
    return void runFunction(name, url, req, res);
  }
  serveStatic(url, req, res);
});

server.listen(PORT, () => {
  const hasSecrets = !!(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET);
  console.log(`sohiradio dev server → http://localhost:${PORT}`);
  console.log(`  static: ${ROOT}`);
  console.log(`  functions: ${FN_PREFIX}<name>  (${hasSecrets ? "SoundCloud creds detected — audio enabled" : "no SoundCloud creds — UI only, function calls will 500"})`);
});
