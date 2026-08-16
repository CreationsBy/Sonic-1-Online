import { DurableObject } from "cloudflare:workers";
import { LobbyError, LobbyStore } from "../src/lobby-store.js";

const LOBBY_IDLE_MS = 30 * 60 * 1000;
const MAX_SPECTATOR_FRAME_LENGTH = 250000;
const MIN_SPECTATOR_FRAME_INTERVAL_MS = 280;
const OPEN = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/api/config") {
      return Response.json({ ok: true, service: "Sonic 1 Online multiplayer" });
    }

    if (url.pathname !== "/ws") {
      return new Response("Sonic 1 Online multiplayer service", { status: 200 });
    }
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    return env.LOBBIES.getByName("sonic-1-online").fetch(request);
  }
};

export class SonicLobbyHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new LobbyStore();
    this.ready = this.ctx.blockConcurrencyWhile(() => this.#restore());
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ code: null, playerId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, payload) {
    await this.ready;
    try {
      const session = socket.deserializeAttachment();
      if (typeof payload !== "string") {
        if (!session?.code || !session?.playerId) {
          throw new LobbyError("NO_SESSION", "Join a lobby before saving a checkpoint.");
        }
        const bytes = toUint8Array(payload);
        this.store.saveCheckpoint(session.code, session.playerId, bytes);
        const lobby = this.store.requireLobby(session.code);
        await Promise.all([
          this.ctx.storage.put(checkpointKey(session.code, session.playerId), bytes),
          this.#persistLobby(lobby)
        ]);
        return;
      }

      const message = JSON.parse(payload);
      if (!session?.code || !session?.playerId) {
        await this.#joinSocket(socket, message);
      } else {
        await this.#handleMessage(socket, session, message);
      }
    } catch (error) {
      this.#sendError(socket, error);
    }
  }

  async webSocketClose(socket) {
    await this.ready;
    await this.#disconnect(socket);
  }

  async webSocketError(socket) {
    await this.ready;
    await this.#disconnect(socket);
  }

  async alarm() {
    await this.ready;
    const now = Date.now();
    for (const [code, lobby] of this.store.lobbies) {
      if (lobby.status === "starting" && lobby.startAt <= now) {
        this.store.markPlaying(code);
        this.#broadcastRoster(lobby);
        await this.#persistLobby(lobby);
      }

      if (!lobby.players.some((player) => player.connected) && now - lobby.touchedAt >= LOBBY_IDLE_MS) {
        this.store.lobbies.delete(code);
        const checkpointKeys = lobby.players.map((player) => checkpointKey(code, player.id));
        await this.ctx.storage.delete([lobbyKey(code), ...checkpointKeys]);
      }
    }
    await this.#scheduleAlarm();
  }

  async #joinSocket(socket, message) {
    if (!message || !["create", "join"].includes(message.type)) {
      throw new LobbyError("NO_SESSION", "Create or join a lobby first.");
    }

    const result = message.type === "create"
      ? this.store.create({ ...message, socket })
      : this.store.join({ ...message, socket });
    socket.serializeAttachment({ code: result.lobby.code, playerId: result.player.id });

    this.#send(socket, {
      type: "session",
      lobby: this.store.snapshot(result.lobby, result.player.id),
      rejoined: result.rejoined,
      hasCheckpoint: Boolean(result.player.checkpoint)
    });

    if (result.rejoined) {
      this.#broadcast(result.lobby, {
        type: "presence",
        action: "rejoined",
        player: this.#publicPlayer(result.lobby, result.player.id)
      }, result.player.id);
      if (result.player.checkpoint) {
        this.#send(socket, { type: "checkpoint", bytes: result.player.checkpoint.byteLength });
        socket.send(result.player.checkpoint);
      }
    } else if (result.lobby.players.length > 1) {
      this.#broadcast(result.lobby, {
        type: "presence",
        action: "joined",
        player: this.#publicPlayer(result.lobby, result.player.id)
      }, result.player.id);
    }

    this.#broadcastRoster(result.lobby);
    this.#updateSpectatorDemand(result.lobby);
    await this.#persistLobby(result.lobby);
  }

  async #handleMessage(socket, session, message) {
    if (!message || typeof message.type !== "string") {
      throw new LobbyError("BAD_MESSAGE", "Invalid message.");
    }
    const lobby = this.store.requireLobby(session.code);
    const player = this.store.requirePlayer(lobby, session.playerId);
    if (player.socket !== socket) {
      throw new LobbyError("STALE_SESSION", "This lobby is open in another tab.");
    }

    switch (message.type) {
      case "start": {
        const started = this.store.beginStart(lobby.code, player.id);
        this.#broadcast(started, { type: "starting", startAt: started.startAt });
        await this.#persistLobby(started);
        await this.#scheduleAlarm();
        break;
      }
      case "telemetry": {
        const update = this.store.updateTelemetry(lobby.code, player.id, message.data);
        if (!update.accepted) return;
        this.#broadcast(lobby, {
          type: "telemetry",
          playerId: player.id,
          data: update.telemetry
        }, player.id);
        if (update.clear) this.#broadcast(lobby, { type: "stage-clear", ...update.clear });
        if (update.finished) {
          this.#broadcast(lobby, { type: "game-finished", ...update.finished });
          this.#broadcastRoster(lobby);
          this.#updateSpectatorDemand(lobby);
        }
        if (update.clear || update.finished) await this.#persistLobby(lobby);
        break;
      }
      case "spectate": {
        const selection = this.store.setSpectating(lobby.code, player.id, message.targetId);
        this.#send(socket, {
          type: "spectating",
          target: selection.target ? this.#publicPlayer(lobby, selection.target.id) : null
        });
        this.#broadcastRoster(lobby);
        this.#updateSpectatorDemand(lobby);
        await this.#persistLobby(lobby);
        break;
      }
      case "spectator-frame":
        this.#relaySpectatorFrame(lobby, player, message.dataUrl);
        break;
      case "ping":
        this.#send(socket, { type: "pong", now: Date.now() });
        break;
      default:
        throw new LobbyError("UNKNOWN_MESSAGE", "Unknown message type.");
    }
  }

  async #disconnect(socket) {
    const result = this.store.disconnect(socket);
    if (!result) return;
    this.#broadcast(result.lobby, {
      type: "presence",
      action: "left",
      player: this.#publicPlayer(result.lobby, result.player.id)
    });
    this.#broadcastRoster(result.lobby);
    this.#updateSpectatorDemand(result.lobby);
    await this.#persistLobby(result.lobby);
    await this.#scheduleAlarm();
  }

  async #restore() {
    const socketsByPlayer = new Map();
    for (const socket of this.ctx.getWebSockets()) {
      const session = socket.deserializeAttachment();
      if (session?.playerId) socketsByPlayer.set(session.playerId, socket);
    }

    const stored = await this.ctx.storage.list({ prefix: "lobby:" });
    for (const savedLobby of stored.values()) {
      const lobby = {
        ...savedLobby,
        players: await Promise.all(savedLobby.players.map(async (savedPlayer) => {
          const socket = socketsByPlayer.get(savedPlayer.id) ?? null;
          const checkpoint = await this.ctx.storage.get(checkpointKey(savedLobby.code, savedPlayer.id));
          return {
            ...savedPlayer,
            socket,
            connected: Boolean(socket),
            disconnectedAt: socket ? null : (savedPlayer.disconnectedAt ?? Date.now()),
            checkpoint: checkpoint ? toUint8Array(checkpoint) : null,
            completedStages: new Set(savedPlayer.completedStages ?? [])
          };
        }))
      };
      this.store.lobbies.set(lobby.code, lobby);
    }
  }

  async #persistLobby(lobby) {
    const savedLobby = {
      ...lobby,
      players: lobby.players.map((player) => {
        const savedPlayer = {
          ...player,
          completedStages: [...player.completedStages]
        };
        delete savedPlayer.socket;
        delete savedPlayer.checkpoint;
        return savedPlayer;
      })
    };
    await this.ctx.storage.put(lobbyKey(lobby.code), savedLobby);
  }

  async #scheduleAlarm() {
    const deadlines = [];
    for (const lobby of this.store.lobbies.values()) {
      if (lobby.status === "starting") deadlines.push(lobby.startAt);
      if (!lobby.players.some((player) => player.connected)) deadlines.push(lobby.touchedAt + LOBBY_IDLE_MS);
    }
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }

  #broadcastRoster(lobby) {
    for (const player of lobby.players) {
      if (player.connected) {
        this.#send(player.socket, { type: "roster", lobby: this.store.snapshot(lobby, player.id) });
      }
    }
  }

  #broadcast(lobby, message, exceptPlayerId = null) {
    for (const player of lobby.players) {
      if (player.connected && player.id !== exceptPlayerId) this.#send(player.socket, message);
    }
  }

  #updateSpectatorDemand(lobby) {
    for (const target of lobby.players) {
      if (!target.connected) continue;
      const count = lobby.players.filter(
        (spectator) => spectator.connected && spectator.completedGame && spectator.spectatingId === target.id
      ).length;
      this.#send(target.socket, { type: "spectator-demand", enabled: count > 0, count });
    }
  }

  #relaySpectatorFrame(lobby, player, dataUrl) {
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
        spectator.socket?.bufferedAmount <= 500000
      ) {
        this.#send(spectator.socket, { type: "spectator-frame", targetId: player.id, dataUrl });
      }
    }
  }

  #publicPlayer(lobby, playerId) {
    return this.store.snapshot(lobby).players.find((player) => player.id === playerId);
  }

  #send(socket, message) {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  }

  #sendError(socket, error) {
    const known = error instanceof LobbyError;
    this.#send(socket, {
      type: "error",
      code: known ? error.code : "SERVER_ERROR",
      message: known ? error.message : "The multiplayer service could not process that request."
    });
    if (!known) console.error(error);
  }
}

function lobbyKey(code) {
  return `lobby:${code}`;
}

function checkpointKey(code, playerId) {
  return `checkpoint:${code}:${playerId}`;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new LobbyError("BAD_CHECKPOINT", "The emulator checkpoint is invalid.");
}
