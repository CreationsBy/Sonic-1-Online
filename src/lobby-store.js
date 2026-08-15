import crypto from "node:crypto";
import {
  MAX_PLAYERS,
  SONIC_ROM,
  colorForSlot,
  stageFromZoneAct
} from "../public/js/protocol-constants.js";

const NAME_PATTERN = /^[\p{L}\p{N} _.-]+$/u;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const CODE_PATTERN = /^\d{4}$/;
const MIN_STAGE_CLEAR_MS = 8000;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

export class LobbyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LobbyError";
    this.code = code;
  }
}

export function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 16 || !NAME_PATTERN.test(name)) {
    throw new LobbyError(
      "BAD_NAME",
      "Names must be 1–16 letters, numbers, spaces, dots, dashes, or underscores."
    );
  }
  return name;
}

function assertToken(token) {
  if (!TOKEN_PATTERN.test(String(token ?? ""))) {
    throw new LobbyError("BAD_TOKEN", "Your reconnect token is invalid. Refresh and try again.");
  }
}

function assertRom(hash) {
  if (String(hash ?? "").toLowerCase() !== SONIC_ROM.sha256) {
    throw new LobbyError("WRONG_ROM", `Only ${SONIC_ROM.title} is supported.`);
  }
}

function publicPlayer(player, hostId) {
  return {
    id: player.id,
    name: player.name,
    slot: player.slot,
    color: colorForSlot(player.slot),
    connected: player.connected,
    host: player.id === hostId,
    telemetry: player.telemetry ?? null
  };
}

export class LobbyStore {
  constructor({ randomCode, now } = {}) {
    this.lobbies = new Map();
    this.randomCode = randomCode ?? (() => crypto.randomInt(0, 10000));
    this.now = now ?? (() => Date.now());
  }

  create({ name, token, romHash, socket }) {
    name = cleanName(name);
    assertToken(token);
    assertRom(romHash);

    const code = this.#newCode();
    const player = this.#newPlayer({ name, token, socket, slot: 1 });
    const lobby = {
      code,
      hostId: player.id,
      status: "lobby",
      startAt: null,
      players: [player],
      createdAt: this.now(),
      touchedAt: this.now()
    };
    this.lobbies.set(code, lobby);
    return { lobby, player, rejoined: false };
  }

  join({ code, name, token, romHash, socket }) {
    code = String(code ?? "").trim();
    if (!CODE_PATTERN.test(code)) {
      throw new LobbyError("BAD_CODE", "Enter a four-digit lobby code.");
    }

    name = cleanName(name);
    assertToken(token);
    assertRom(romHash);

    const lobby = this.lobbies.get(code);
    if (!lobby) throw new LobbyError("NOT_FOUND", "That lobby does not exist or has expired.");

    const returning = lobby.players.find((candidate) => candidate.token === token);
    if (returning) {
      if (lobby.players.some(
        (candidate) => candidate.id !== returning.id && candidate.name.toLowerCase() === name.toLowerCase()
      )) {
        throw new LobbyError("NAME_TAKEN", "That name is already reserved in this lobby.");
      }
      if (returning.connected && returning.socket && returning.socket !== socket) {
        returning.socket.close?.(4001, "Reconnected in another tab");
      }
      returning.socket = socket;
      returning.connected = true;
      returning.disconnectedAt = null;
      returning.name = name;
      lobby.touchedAt = this.now();
      return { lobby, player: returning, rejoined: true };
    }

    if (lobby.status !== "lobby") {
      throw new LobbyError("ALREADY_STARTED", "This race has already started.");
    }
    if (lobby.players.length >= MAX_PLAYERS) {
      throw new LobbyError("FULL", "This lobby already has four players.");
    }
    if (lobby.players.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())) {
      throw new LobbyError("NAME_TAKEN", "That name is already reserved in this lobby.");
    }

    const used = new Set(lobby.players.map((candidate) => candidate.slot));
    const slot = [1, 2, 3, 4].find((candidate) => !used.has(candidate));
    const player = this.#newPlayer({ name, token, socket, slot });
    lobby.players.push(player);
    lobby.touchedAt = this.now();
    return { lobby, player, rejoined: false };
  }

  beginStart(code, playerId, delayMs = 2500) {
    const lobby = this.requireLobby(code);
    if (lobby.hostId !== playerId) {
      throw new LobbyError("NOT_HOST", "Only the host can start the race.");
    }
    if (lobby.status !== "lobby") {
      throw new LobbyError("BAD_STATE", "The race is already starting or playing.");
    }
    if (!lobby.players.every((player) => player.connected)) {
      throw new LobbyError("PLAYER_OFFLINE", "Wait for disconnected players to rejoin before starting.");
    }

    lobby.status = "starting";
    lobby.startAt = this.now() + delayMs;
    lobby.touchedAt = this.now();
    return lobby;
  }

  markPlaying(code) {
    const lobby = this.lobbies.get(code);
    if (lobby?.status === "starting") {
      lobby.status = "playing";
      lobby.touchedAt = this.now();
    }
    return lobby;
  }

  updateTelemetry(code, playerId, input) {
    const lobby = this.requireLobby(code);
    const player = this.requirePlayer(lobby, playerId);
    const now = this.now();

    if (now - player.lastTelemetryAt < 70) return { accepted: false, clear: null };

    const telemetry = {
      x: integerInRange(input?.x, 0, 0xffff),
      y: integerInRange(input?.y, 0, 0xffff),
      cameraX: integerInRange(input?.cameraX, 0, 0xffff),
      cameraY: integerInRange(input?.cameraY, 0, 0xffff),
      zoneAct: integerInRange(input?.zoneAct, 0, 0xffff),
      mode: integerInRange(input?.mode, 0, 0xff),
      status: integerInRange(input?.status, 0, 0xff),
      visible: Boolean(input?.visible),
      sentAt: now
    };

    player.lastTelemetryAt = now;
    player.telemetry = telemetry;
    lobby.touchedAt = now;

    let clear = null;
    const stage = telemetry.mode === 0x0c ? stageFromZoneAct(telemetry.zoneAct) : null;
    if (stage && stage.key !== player.currentStageKey) {
      if (
        player.currentStage &&
        now - player.stageEnteredAt >= MIN_STAGE_CLEAR_MS &&
        !player.completedStages.has(player.currentStage.key)
      ) {
        player.completedStages.add(player.currentStage.key);
        clear = { player: publicPlayer(player, lobby.hostId), stage: player.currentStage };
      }
      player.currentStageKey = stage.key;
      player.currentStage = stage;
      player.stageEnteredAt = now;
    }

    // Final Zone changes directly into the ending mode instead of another act.
    if (
      telemetry.mode === 0x18 &&
      player.currentStage?.key === "6:0" &&
      now - player.stageEnteredAt >= MIN_STAGE_CLEAR_MS &&
      !player.completedStages.has("6:0")
    ) {
      player.completedStages.add("6:0");
      clear = { player: publicPlayer(player, lobby.hostId), stage: player.currentStage };
    }

    return { accepted: true, telemetry, clear };
  }

  saveCheckpoint(code, playerId, bytes) {
    const lobby = this.requireLobby(code);
    const player = this.requirePlayer(lobby, playerId);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 65552 || bytes.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new LobbyError("BAD_CHECKPOINT", "The emulator checkpoint size is invalid.");
    }
    player.checkpoint = Buffer.from(bytes);
    player.checkpointAt = this.now();
    lobby.touchedAt = this.now();
  }

  disconnect(socket) {
    for (const lobby of this.lobbies.values()) {
      const player = lobby.players.find((candidate) => candidate.socket === socket);
      if (!player) continue;
      player.connected = false;
      player.socket = null;
      player.disconnectedAt = this.now();
      lobby.touchedAt = this.now();
      return { lobby, player };
    }
    return null;
  }

  removeExpired(maxIdleMs = 30 * 60 * 1000) {
    const now = this.now();
    for (const [code, lobby] of this.lobbies) {
      if (!lobby.players.some((player) => player.connected) && now - lobby.touchedAt > maxIdleMs) {
        this.lobbies.delete(code);
      }
    }
  }

  snapshot(lobby, selfId = null) {
    return {
      code: lobby.code,
      status: lobby.status,
      startAt: lobby.startAt,
      hostId: lobby.hostId,
      selfId,
      players: lobby.players.map((player) => publicPlayer(player, lobby.hostId))
    };
  }

  requireLobby(code) {
    const lobby = this.lobbies.get(code);
    if (!lobby) throw new LobbyError("NOT_FOUND", "The lobby has expired.");
    return lobby;
  }

  requirePlayer(lobby, playerId) {
    const player = lobby.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new LobbyError("NOT_IN_LOBBY", "You are not in this lobby.");
    return player;
  }

  #newPlayer({ name, token, socket, slot }) {
    return {
      id: crypto.randomUUID(),
      token,
      name,
      slot,
      socket,
      connected: true,
      disconnectedAt: null,
      checkpoint: null,
      checkpointAt: null,
      telemetry: null,
      lastTelemetryAt: 0,
      currentStageKey: null,
      currentStage: null,
      stageEnteredAt: 0,
      completedStages: new Set()
    };
  }

  #newCode() {
    for (let attempt = 0; attempt < 10000; attempt += 1) {
      const code = String(this.randomCode()).padStart(4, "0");
      if (!this.lobbies.has(code)) return code;
    }
    throw new LobbyError("NO_CODES", "All lobby codes are currently in use.");
  }
}

function integerInRange(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new LobbyError("BAD_TELEMETRY", "Invalid emulator telemetry.");
  }
  return number;
}
