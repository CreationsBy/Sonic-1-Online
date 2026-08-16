# Sonic 1 Online

A private-room, maximum-four-player cooperative web experience for the original **Sonic the Hedgehog** on Sega Genesis. Each browser runs its own emulator, so teammates can move through the game at their own pace while seeing one another as colored Sonic figures. The server relays position/stage metadata, on-demand spectator images, and short-lived reconnect checkpoints; it never receives the ROM.

## Run it

Requirements: Node.js 20 or newer and an internet connection for the EmulatorJS runtime.

```powershell
npm install
npm start
```

Open `http://localhost:8080` in each browser. For another device on the same network, use the host computer's LAN address, such as `http://192.168.1.20:8080`. Public deployment should use HTTPS/WSS behind a reverse proxy.

## GitHub Pages

The full site entry point is `public/index.html`. The repository also has a root `index.html` that redirects there when Pages is configured to publish from the branch root.

To share the static site itself, use the included `.github/workflows/pages.yml` workflow:

1. Push the repository to a GitHub repository whose default branch is `main`.
2. Open **Settings â†’ Pages** and set **Source** to **GitHub Actions**.
3. The workflow publishes the contents of `public/`, so `public/index.html` becomes the site's root page automatically.

There is no visitor-facing server configuration field. GitHub Pages can share the interface and client files, but it is a static host and cannot run the lobby/WebSocket process. Running `npm start` serves the client and multiplayer backend together with no configuration.

The Pages copy automatically connects to the deployed Cloudflare Worker listed below. Visitors never see or enter a backend address.

### Cloudflare multiplayer backend

The repository includes `wrangler.jsonc` and `cloudflare/worker.js` for a Cloudflare Worker backend. It uses a SQLite-backed Durable Object to coordinate four-digit rooms, WebSockets, reconnect checkpoints, stage notifications, and spectator relay. This is separate from the static GitHub Pages deployment.

When connecting this repository through Cloudflare Workers Builds:

1. Use the deploy command `npx wrangler deploy`.
2. Do not select Jekyll and do not use `_site` as an output directory. Wrangler reads `wrangler.jsonc`; no static build command is needed for this backend.
3. The current backend is `https://sonic-1-online.spaghettijedi.workers.dev`; its `/health` route confirms the service is online.
4. The Pages client and workflow already use that address. If the Worker address changes later, update `public/config.js` and `.github/workflows/pages.yml`.

The Worker exposes `/health` for a quick deployment check and `/ws` for lobby WebSockets. The ROM is never included in or uploaded to the Worker.

Do not put the ROM in `public/` or the Pages artifact. Every player continues to select their own local copy.

If Pages is instead configured to **Deploy from a branch**, GitHub runs Jekyll against the repository root. The included `_config.yml` excludes `rom/` so Jekyll neither interprets the binary ROM's legacy `.md` filename nor publishes the ROM. The `public/.nojekyll` marker is also included in the static Actions artifact. GitHub Actions remains the recommended Pages source.

Each player must:

1. Choose a display name.
2. Select the provided `rom/Sonic The Hedgehog (USA, Europe).md` file in their own browser. Despite the extension, that file is a 512 KiB Mega Drive ROM.
3. Create a private lobby or enter its four-digit code.
4. Wait for the host to press **Start game**.

The ROM picker accepts only the supplied USA/Europe revision (SHA-256 `46160baa…ff2a6`). This is important because other revisions and ROM hacks may use different RAM layouts.

## How the multiplayer works

This is asynchronous cooperative multiplayer, not traditional shared-input Genesis netplay:

- Every player gets an independent Genesis Plus GX emulator and can play at their own pace.
- When the host starts, the server sends one future timestamp to every browser. Each browser launches at that timestamp.
- The client reads the Genesis Plus GX save-state buffer four to six times a second, using the lower rate on mobile. That buffer begins with a 16-byte core signature followed by the Genesis 64 KiB work RAM.
- Sonic 1's RAM fields provide Sonic's world X/Y position, camera X/Y, current zone/act, game mode, and facing bit.
- Those small values go through WebSocket. A teammate on the same act is drawn as a colored Sonic figure at `teammate world position - local camera position`. Off-screen teammates get an edge marker. Players in another act remain visible in the player-status panel.
- Player 1 is blue, Player 2 red, Player 3 yellow, and Player 4 green. The overlay samples the emulator's current Sonic sprite, keeps its face/gloves/shoes, and recolors the blue fur. Players 2–4 also get that assigned overlay drawn over their local blue Sonic. Every Sonic has a matching-color display name anchored above it and following the same live screen position. A small vector Sonic-style marker is the fallback when a browser blocks WebGL readback.

The relevant code is split by responsibility:

- `src/lobby-store.js` owns four-seat rooms, host authorization, reconnect identity, telemetry validation, and stage-clear detection.
- `src/server.js` serves the app and relays WebSocket events/checkpoints.
- `public/js/sonic-memory.js` documents and reads the Sonic 1 RAM addresses.
- `public/js/emulator.js` embeds EmulatorJS, extracts state, and renders the colored ghosts.
- `public/js/app.js` controls ROM validation, lobby UI, synchronized launch, team status, spectating, and notifications.

## Reconnect behavior

The browser creates a random reconnect token and stores it under the lobby code. While playing, a checkpoint is sent every five seconds. If that player leaves and rejoins the still-running lobby from the same browser:

- the same player number/color is reclaimed;
- everyone sees a left/rejoined pop-up;
- the emulator loads that player's latest checkpoint.

Checkpoints exist in server memory only. Restarting the Node server ends all rooms and discards their checkpoints. Rooms with no connected players expire after 30 minutes. For durable or multi-server deployment, replace the in-memory `LobbyStore` checkpoint field with Redis/object storage and use a shared WebSocket adapter.

## Stage notifications

The server observes valid zone/act transitions. After a player has spent at least eight seconds in an act, entering the next act broadcasts a message such as **“Alex cleared Green Hill Zone — Act 1!”**. Final Zone completion is detected when the game enters its ending mode. The minimum duration prevents menus or uninitialized RAM from producing false clears.

## Cooperative finish and spectating

Finishing Final Zone and reaching Sonic 1's ending marks that player as finished; it does not end the room for everyone else. The finished player's emulator pauses and the interface changes to spectator mode, where they can select any connected teammate who is still playing. If the selected teammate finishes or disconnects, the view switches to another available teammate automatically. A disconnected player's seat and checkpoint remain saved, so spectators wait for them if they are the only unfinished teammate.

Spectator pictures are silent, compressed 320×224 canvas snapshots sent at roughly three frames per second on desktop and two on mobile. They include the watched player's colored teammate overlay, are produced only while someone is actively watching, and are dropped when either WebSocket is backed up. This keeps the feature practical on mobile connections without sharing controller input or ROM data.

## Controls and emulator menu

EmulatorJS supplies keyboard/gamepad mapping and its on-screen controls. Open the emulator's settings menu to remap controls for the current browser. Multiplayer does not send controller input to other players.

The client detects iPhone, iPod, iPad, iPadOS devices reporting `MacIntel`, desktop Macs, Android, and other coarse-pointer devices. On touch devices it enables a Genesis layout with a D-pad plus A, B, C, and Start buttons. The game uses safe-area insets on notched Apple devices, larger tap targets, compact player cards in portrait, a full-height game surface, and a landscape layout that gives most of the screen to the emulator.

## Verification

```powershell
npm test
npm run check
```

The tests cover the four-player limit, host-only start, reconnect seat/checkpoint retention, ROM/name validation, stage and full-game completion, spectator authorization/selection, byte-accurate RAM extraction, and Apple/mobile detection including modern iPadOS user agents.

## Deployment notes

- The default client loads the stable EmulatorJS assets from `cdn.emulatorjs.org`. For an offline/self-contained build, download an EmulatorJS release into `public/vendor/emulatorjs/data/` and change `EJS_pathtodata` plus the loader URL in `public/js/emulator.js`.
- Do not place ROM files in `public/`; this server intentionally serves only that directory.
- Keep the `ws` payload limit and checkpoint validation in place. They bound memory use per message.
- The colored player figure is a sampled/recolored canvas ghost rather than modified ROM data. The original game remains unpatched, which keeps every emulator and save state compatible with the stock ROM.
