import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { LobbyError, LobbyStore } from "./lobby-store.js";
import { MAX_PLAYERS, SONIC_ROM } from "../public/js/protocol-constants.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, "../public");
const requestedPort = Number(process.env.PORT);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 8080;
const store = new LobbyStore();
const MAX_SPECTATOR_FRAME_LENGTH = 250000;
const MIN_SPECTATOR_FRAME_INTERVAL_MS = 280;

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    setSecurityHeaders(response);

    if (url.pathname === "/api/config") {
      response.writeHead(200, { "Content-Type": MIME_TYPES[".json"] });
      response.end(JSON.stringify({ maxPlayers: MAX_PLAYERS, rom: SONIC_ROM }));
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filename = path.resolve(publicDir, `.${requested}`);
    if (!filename.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const file = await import("node:fs/promises").then(({ readFile }) => readFile(filename));
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (request.method === "HEAD") response.end();
    else response.end(file);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(error);
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

const sockets = new WebSocketServer({ server, path: "/ws", maxPayload: 2 * 1024 * 1024 });

sockets.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        const session = socket.session;
        if (!session) throw new LobbyError("NO_SESSION", "Join a lobby before saving a checkpoint.");
        store.saveCheckpoint(session.code, session.playerId, new Uint8Array(data));
        return;
      }

      const message = JSON.parse(data.toString("utf8"));
      handleMessage(socket, message);
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on("close", () => {
    const result = store.disconnect(socket);
    if (!result) return;
    broadcast(result.lobby, {
      type: "presence",
      action: "left",
      player: publicPlayerFromSnapshot(result.lobby, result.player.id)
    });
    broadcastRoster(result.lobby);
    updateSpectatorDemand(result.lobby);
  });

  socket.on("error", (error) => console.warn("WebSocket error:", error.message));
});

function handleMessage(socket, message) {
  if (!message || typeof message.type !== "string") {
    throw new LobbyError("BAD_MESSAGE", "Invalid message.");
  }

  if (message.type === "create" || message.type === "join") {
    if (socket.session) throw new LobbyError("HAS_SESSION", "This connection already joined a lobby.");
    const result = message.type === "create"
      ? store.create({ ...message, socket })
      : store.join({ ...message, socket });

    socket.session = { code: result.lobby.code, playerId: result.player.id };
    send(socket, {
      type: "session",
      lobby: store.snapshot(result.lobby, result.player.id),
      rejoined: result.rejoined,
      hasCheckpoint: Boolean(result.player.checkpoint)
    });

    if (result.rejoined) {
      broadcast(result.lobby, {
        type: "presence",
        action: "rejoined",
        player: publicPlayerFromSnapshot(result.lobby, result.player.id)
      }, result.player.id);
      if (result.player.checkpoint) {
        send(socket, { type: "checkpoint", bytes: result.player.checkpoint.byteLength });
        socket.send(result.player.checkpoint, { binary: true });
      }
    } else if (result.lobby.players.length > 1) {
      broadcast(result.lobby, {
        type: "presence",
        action: "joined",
        player: publicPlayerFromSnapshot(result.lobby, result.player.id)
      }, result.player.id);
    }
    broadcastRoster(result.lobby);
    updateSpectatorDemand(result.lobby);
    return;
  }

  const session = socket.session;
  if (!session) throw new LobbyError("NO_SESSION", "Create or join a lobby first.");
  const lobby = store.requireLobby(session.code);
  const player = store.requirePlayer(lobby, session.playerId);
  if (player.socket !== socket) throw new LobbyError("STALE_SESSION", "This lobby is open in another tab.");

  switch (message.type) {
    case "start": {
      const started = store.beginStart(lobby.code, player.id);
      broadcast(started, { type: "starting", startAt: started.startAt });
      setTimeout(() => {
        const playing = store.markPlaying(started.code);
        if (playing) broadcastRoster(playing);
      }, Math.max(0, started.startAt - Date.now()));
      break;
    }
    case "telemetry": {
      const update = store.updateTelemetry(lobby.code, player.id, message.data);
      if (!update.accepted) return;
      broadcast(lobby, {
        type: "telemetry",
        playerId: player.id,
        data: update.telemetry
      }, player.id);
      if (update.clear) broadcast(lobby, { type: "stage-clear", ...update.clear });
      if (update.finished) {
        broadcast(lobby, { type: "game-finished", ...update.finished });
        broadcastRoster(lobby);
        updateSpectatorDemand(lobby);
      }
      break;
    }
    case "spectate": {
      const selection = store.setSpectating(lobby.code, player.id, message.targetId);
      send(socket, {
        type: "spectating",
        target: selection.target ? publicPlayerFromSnapshot(lobby, selection.target.id) : null
      });
      broadcastRoster(lobby);
      updateSpectatorDemand(lobby);
      break;
    }
    case "spectator-frame": {
      relaySpectatorFrame(lobby, player, message.dataUrl);
      break;
    }
    case "ping":
      send(socket, { type: "pong", now: Date.now() });
      break;
    default:
      throw new LobbyError("UNKNOWN_MESSAGE", "Unknown message type.");
  }
}

function broadcastRoster(lobby) {
  for (const player of lobby.players) {
    if (player.connected) {
      send(player.socket, { type: "roster", lobby: store.snapshot(lobby, player.id) });
    }
  }
}

function broadcast(lobby, message, exceptPlayerId = null) {
  for (const player of lobby.players) {
    if (player.connected && player.id !== exceptPlayerId) send(player.socket, message);
  }
}

function updateSpectatorDemand(lobby) {
  for (const target of lobby.players) {
    if (!target.connected) continue;
    const count = lobby.players.filter(
      (spectator) => spectator.connected && spectator.completedGame && spectator.spectatingId === target.id
    ).length;
    send(target.socket, { type: "spectator-demand", enabled: count > 0, count });
  }
}

function relaySpectatorFrame(lobby, player, dataUrl) {
  if (player.completedGame || typeof dataUrl !== "string") return;
  if (dataUrl.length > MAX_SPECTATOR_FRAME_LENGTH || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(dataUrl)) {
    throw new LobbyError("BAD_SPECTATOR_FRAME", "The spectator frame is invalid or too large.");
  }
  const now = Date.now();
  if (now - player.lastSpectatorFrameAt < MIN_SPECTATOR_FRAME_INTERVAL_MS) return;
  player.lastSpectatorFrameAt = now;

  for (const spectator of lobby.players) {
    if (
      spectator.connected &&
      spectator.completedGame &&
      spectator.spectatingId === player.id &&
      spectator.socket?.bufferedAmount <= 500_000
    ) {
      send(spectator.socket, {
        type: "spectator-frame",
        targetId: player.id,
        dataUrl
      });
    }
  }
}

function publicPlayerFromSnapshot(lobby, playerId) {
  return store.snapshot(lobby).players.find((player) => player.id === playerId);
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket, error) {
  const known = error instanceof LobbyError;
  send(socket, {
    type: "error",
    code: known ? error.code : "SERVER_ERROR",
    message: known ? error.message : "The server could not process that request."
  });
  if (!known) console.error(error);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.emulatorjs.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: blob: https://cdn.emulatorjs.org; worker-src 'self' blob: https://cdn.emulatorjs.org; font-src 'self' data:"
  );
}

const heartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  store.removeExpired();
}, 30000);
heartbeat.unref();

server.listen(port, () => {
  const address = server.address();
  console.log(`Sonic 1 Online is running at http://localhost:${address.port}`);
});

export { server, store };
