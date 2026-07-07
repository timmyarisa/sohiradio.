# sohiradio — deployment guide

This version replaces the hidden SoundCloud iframe with real audio played
through your own `<audio>` element, using the SoundCloud API directly. This
is what actually fixes the lock-screen "SoundCloud Widget" issue — once
audio plays natively on your own page, iOS shows real track metadata.

## Why this can't use Netlify Drop anymore

Drag-and-drop deploys are static-files-only. This version needs:
- Serverless functions (the `netlify/functions` folder)
- Environment variables (to hold your Client Secret safely)

Neither works with Netlify Drop. You'll need a real Netlify site instead —
one-time setup, not much harder.

## Setup steps

### 1. Get your SoundCloud API credentials
Register an app at developers.soundcloud.com (requires the Artist Pro
account you already have). Note your **Client ID** and **Client Secret**.

### 2. Push this folder to a GitHub repo
- Create a new repo on GitHub (public or private, either works)
- Upload this whole folder to it (all files, including the `netlify` folder)

### 3. Connect Netlify to that repo
- Go to app.netlify.com → "Add new site" → "Import an existing project"
- Pick the GitHub repo you just created
- Build settings: leave build command blank, publish directory as `.`
  (the `netlify.toml` already in this folder handles the rest)

### 4. Add your environment variables
In the Netlify site dashboard: **Site configuration → Environment variables**
- Add `SOUNDCLOUD_CLIENT_ID` = your Client ID
- Add `SOUNDCLOUD_CLIENT_SECRET` = your Client Secret
(This is the only place the secret should ever live.)

### 5. Deploy
Netlify will auto-deploy once connected. After that, any time you push a
change to GitHub, it redeploys automatically — no more manual drag-and-drop.

### 6. Update the playlist URL if needed
In `index.html`, near the top of the `<script>` block:
```js
const AMBIENT_SET_URL = "https://soundcloud.com/sohisounds/sets/sohiradio-default";
```
Change this to whatever playlist/set you want the ambient stream to pull from.

## What to expect
- Real track audio plays through your own page, not a hidden SoundCloud frame
- Lock-screen / Now Playing should show real title + artist + artwork
- Tracks that a SoundCloud creator has blocked from off-platform streaming
  will be automatically skipped (the function detects this and retries
  another track)
- Shuffle plays a random track from the resolved playlist each time,
  never repeating the immediately-previous track
