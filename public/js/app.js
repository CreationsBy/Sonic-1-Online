import { SonicEmulator, formatTelemetryStage } from "./emulator.js";
import { LobbyConnection, getConfiguredServerUrl } from "./network.js";
import { MAX_PLAYERS, SONIC_ROM, colorForSlot } from "./protocol-constants.js";
import { applyDeviceClasses } from "./device.js";

const device = applyDeviceClasses();

const elements = Object.fromEntries(
  [
    "menu-view", "game-view", "setup-card", "lobby-card", "player-name", "rom-file",
    "rom-drop", "rom-status", "room-code", "create-room", "join-room", "setup-error",
    "lobby-code", "lobby-players", "lobby-hint", "start-race", "copy-code", "game-code",
    "connection-state", "race-hud", "launch-cover", "countdown", "toast-stack",
    "device-note", "server-config", "server-url", "save-server", "rotate-hint"
  ].map((id) => [id, document.getElementById(id)])
);

const app = {
  config: { maxPlayers: MAX_PLAYERS, rom: SONIC_ROM },
  romFile: null,
  romHash: null,
  validatingRom: false,
  session: null,
  lobby: null,
  players: new Map(),
  pendingCheckpoint: null,
  busy: false,
  scheduledStart: null,
  hudRenderAt: 0
};

const connection = new LobbyConnection();
const emulator = new SonicEmulator({
  onTelemetry: (data) => {
    const self = getSelf();
    if (self) self.telemetry = data;
    connection.send("telemetry", { data });
    scheduleHudRender();
  },
  onCheckpoint: (bytes) => connection.sendCheckpoint(bytes),
  onReady: (error) => {
    if (error) {
      notify(error.message, "error", 9000);
      return;
    }
    app.pendingCheckpoint = null;
    setTimeout(() => elements["launch-cover"].classList.add("done"), 400);
    notify("Emulator ready — race!", "success");
  },
  getPlayers: () => [...app.players.values()],
  getSelf
});

boot();

async function boot() {
  applyServerQueryParameter();
  configureDeviceUi();
  configureStaticHostingUi();

  try {
    const response = await fetch("/api/config");
    if (response.ok) app.config = await response.json();
  } catch {
    // Static constants match the server and keep the setup screen usable.
  }

  const rememberedName = storageGet("sonic-race-name");
  if (rememberedName) elements["player-name"].value = rememberedName;

  elements["rom-file"].addEventListener("change", () => validateRom(elements["rom-file"].files[0]));
  elements["player-name"].addEventListener("input", refreshButtons);
  elements["room-code"].addEventListener("input", () => {
    elements["room-code"].value = elements["room-code"].value.replace(/\D/g, "").slice(0, 4);
    refreshButtons();
  });
  elements["create-room"].addEventListener("click", () => enterLobby("create"));
  elements["join-room"].addEventListener("click", () => enterLobby("join"));
  elements["start-race"].addEventListener("click", () => connection.send("start"));
  elements["copy-code"].addEventListener("click", copyLobbyCode);
  elements["save-server"].addEventListener("click", saveServerUrl);

  for (const eventName of ["dragenter", "dragover"]) {
    elements["rom-drop"].addEventListener(eventName, (event) => {
      event.preventDefault();
      elements["rom-drop"].classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements["rom-drop"].addEventListener(eventName, (event) => {
      event.preventDefault();
      elements["rom-drop"].classList.remove("dragging");
    });
  }
  elements["rom-drop"].addEventListener("drop", (event) => validateRom(event.dataTransfer.files[0]));

  connection.addEventListener("message", (event) => handleServerMessage(event.detail));
  connection.addEventListener("checkpoint", (event) => {
    if (emulator.ready) return; // Do not rewind an emulator that survived a short network drop.
    app.pendingCheckpoint = event.detail;
    emulator.queueResumeState(event.detail);
    notify("Your last checkpoint is ready to restore.", "success");
  });
  connection.addEventListener("connection", (event) => setConnectionState(event.detail.state));
  window.addEventListener("pagehide", () => emulator.checkpointNow());
  refreshButtons();
}

async function validateRom(file) {
  if (!file || app.validatingRom) return;
  app.validatingRom = true;
  app.romFile = null;
  app.romHash = null;
  elements["rom-drop"].classList.remove("valid", "invalid");
  elements["rom-status"].textContent = "Checking ROM revision…";
  refreshButtons();

  try {
    if (file.size !== app.config.rom.size) throw new Error(`Expected a ${formatBytes(app.config.rom.size)} Sonic 1 ROM.`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const hash = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== app.config.rom.sha256) throw new Error(`This is not the supported ${app.config.rom.title} ROM.`);

    app.romFile = file;
    app.romHash = hash;
    elements["rom-drop"].classList.add("valid");
    elements["rom-status"].textContent = `${file.name} • verified`;
    elements["setup-error"].textContent = "";
  } catch (error) {
    elements["rom-drop"].classList.add("invalid");
    elements["rom-status"].textContent = error.message;
  } finally {
    app.validatingRom = false;
    refreshButtons();
  }
}

async function enterLobby(type) {
  if (app.busy || !app.romFile) return;
  const name = elements["player-name"].value.trim();
  const code = elements["room-code"].value;
  if (!name) return showSetupError("Choose a display name first.");
  if (type === "join" && !/^\d{4}$/.test(code)) return showSetupError("Enter a four-digit lobby code.");

  app.busy = true;
  refreshButtons();
  showSetupError("");
  storageSet("sonic-race-name", name);

  const storageKey = type === "join" ? `sonic-race-token:${code}` : null;
  const token = (storageKey && storageGet(storageKey)) || newToken();
  try {
    await connection.connect({ type, code, name, token, romHash: app.romHash });
  } catch (error) {
    showSetupError(error.message);
    app.busy = false;
    refreshButtons();
  }
}

function handleServerMessage(message) {
  switch (message.type) {
    case "session": {
      app.session = message.lobby;
      applyLobby(message.lobby);
      connection.rememberLobby(message.lobby.code);
      storageSet(`sonic-race-token:${message.lobby.code}`, connection.joinRequest.token);
      elements["setup-card"].classList.add("hidden");
      elements["lobby-card"].classList.remove("hidden");
      elements["lobby-code"].textContent = message.lobby.code;
      elements["game-code"].textContent = message.lobby.code;
      app.busy = false;
      if (message.rejoined) notify("You rejoined and kept your original player slot.", "success");
      respondToLobbyStatus(message.lobby);
      break;
    }
    case "roster":
      applyLobby(message.lobby);
      respondToLobbyStatus(message.lobby);
      break;
    case "presence":
      if (message.action === "joined") notify(`${message.player.name} joined as Player ${message.player.slot}.`, "success");
      if (message.action === "left") notify(`${message.player.name} left the lobby.`, "warning");
      if (message.action === "rejoined") notify(`${message.player.name} joined again and resumed their game.`, "success");
      break;
    case "starting":
      scheduleRaceStart(message.startAt);
      break;
    case "telemetry": {
      const player = app.players.get(message.playerId);
      if (player) {
        player.telemetry = message.data;
        scheduleHudRender();
      }
      break;
    }
    case "stage-clear":
      notify(`${message.player.name} cleared ${message.stage.label}!`, "success", 6500);
      break;
    case "error":
      notify(message.message, "error", 7000);
      showSetupError(message.message);
      break;
    default:
      break;
  }
}

function applyLobby(lobby) {
  app.lobby = lobby;
  const previousTelemetry = new Map([...app.players].map(([id, player]) => [id, player.telemetry]));
  app.players = new Map(lobby.players.map((player) => [
    player.id,
    { ...player, telemetry: player.telemetry ?? previousTelemetry.get(player.id) ?? null }
  ]));
  renderLobby();
  renderHud();
}

function respondToLobbyStatus(lobby) {
  if (lobby.status === "starting") scheduleRaceStart(lobby.startAt);
  if (lobby.status === "playing") launchGame();
}

function renderLobby() {
  if (!app.lobby) return;
  elements["lobby-players"].replaceChildren();
  const bySlot = new Map([...app.players.values()].map((player) => [player.slot, player]));

  for (let slot = 1; slot <= app.config.maxPlayers; slot += 1) {
    const player = bySlot.get(slot);
    const card = document.createElement("div");
    card.className = `player-card${player ? "" : " empty"}${player && !player.connected ? " offline" : ""}`;
    if (player) {
      const orb = document.createElement("span");
      orb.className = "player-orb";
      orb.style.background = player.color || colorForSlot(slot);
      orb.textContent = `P${slot}`;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = player.name;
      const meta = document.createElement("small");
      meta.textContent = `${player.host ? "Host • " : ""}${player.connected ? "Ready" : "Disconnected — seat saved"}`;
      copy.append(title, meta);
      card.append(orb, copy);
    } else {
      const orb = document.createElement("span");
      orb.className = "player-orb";
      orb.style.background = "#294467";
      orb.textContent = `P${slot}`;
      const text = document.createElement("span");
      text.textContent = "Open slot";
      card.append(orb, text);
    }
    elements["lobby-players"].append(card);
  }

  const self = getSelf();
  const allConnected = [...app.players.values()].every((player) => player.connected);
  elements["start-race"].classList.toggle("hidden", !self?.host || app.lobby.status !== "lobby");
  elements["start-race"].disabled = !allConnected;
  elements["lobby-hint"].textContent = self?.host
    ? (allConnected ? "Everyone shown here will launch together." : "A player's saved seat is currently disconnected.")
    : "Waiting for the host to start…";
}

function renderHud() {
  if (!app.players.size) return;
  elements["race-hud"].replaceChildren();
  const players = [...app.players.values()].sort((a, b) => a.slot - b.slot);
  for (const player of players) {
    const row = document.createElement("div");
    row.className = `race-row${player.connected ? "" : " offline"}`;
    row.style.setProperty("--player-color", player.color || colorForSlot(player.slot));

    const top = document.createElement("div");
    top.className = "race-row-top";
    const dot = document.createElement("i");
    const name = document.createElement("strong");
    name.textContent = player.name;
    const slot = document.createElement("b");
    slot.textContent = `P${player.slot}`;
    top.append(dot, name, slot);

    const status = document.createElement("p");
    if (!player.connected) status.textContent = "Disconnected • checkpoint saved";
    else if (!player.telemetry) status.textContent = "Starting emulator…";
    else status.textContent = `${formatTelemetryStage(player.telemetry)} • X ${player.telemetry.x}`;
    row.append(top, status);
    elements["race-hud"].append(row);
  }
}

function scheduleHudRender() {
  const now = performance.now();
  if (now - app.hudRenderAt < 180) return;
  app.hudRenderAt = now;
  requestAnimationFrame(renderHud);
}

function scheduleRaceStart(startAt) {
  if (app.scheduledStart || emulator.started) return;
  app.scheduledStart = startAt;
  elements["menu-view"].classList.add("hidden");
  elements["game-view"].classList.remove("hidden");
  elements["launch-cover"].classList.remove("done");

  const tick = () => {
    const remaining = Math.max(0, startAt - Date.now());
    elements.countdown.textContent = remaining > 0 ? String(Math.max(1, Math.ceil(remaining / 1000))) : "GO!";
    if (remaining > 0) requestAnimationFrame(tick);
    else launchGame();
  };
  tick();
}

async function launchGame() {
  if (emulator.started) return;
  elements["menu-view"].classList.add("hidden");
  elements["game-view"].classList.remove("hidden");
  elements.countdown.textContent = "GO!";
  renderHud();
  try {
    await emulator.start(app.romFile, app.pendingCheckpoint);
  } catch (error) {
    notify(error.message, "error", 9000);
  }
}

function getSelf() {
  return app.lobby ? app.players.get(app.lobby.selfId) : null;
}

function refreshButtons() {
  const backendReady = !requiresExternalServer() || Boolean(getConfiguredServerUrl());
  const ready = Boolean(
    backendReady && elements["player-name"].value.trim() && app.romFile && !app.validatingRom && !app.busy
  );
  elements["create-room"].disabled = !ready;
  elements["join-room"].disabled = !ready || !/^\d{4}$/.test(elements["room-code"].value);
}

function configureDeviceUi() {
  if (!device.isTouch) return;
  elements["device-note"].classList.remove("hidden");
  elements["device-note"].textContent = device.isIOS
    ? "Apple touch device detected — Genesis D-pad, A, B, C, and Start controls will appear in-game."
    : "Touch device detected — Genesis D-pad, A, B, C, and Start controls will appear in-game.";
  elements["rotate-hint"].classList.remove("hidden");
}

function configureStaticHostingUi() {
  if (!requiresExternalServer()) return;
  elements["server-config"].classList.remove("hidden");
  elements["server-url"].value = getConfiguredServerUrl();
  if (!getConfiguredServerUrl()) {
    showSetupError("GitHub Pages needs the public URL of your separately deployed multiplayer server.");
  }
}

function applyServerQueryParameter() {
  const fromQuery = new URLSearchParams(location.search).get("server");
  if (!fromQuery) return;
  try {
    const validated = validateServerUrl(fromQuery);
    window.SONIC_SERVER_URL = validated;
    storageSet("sonic-race-server", validated);
  } catch {
    // The visible server field lets the user correct an invalid query value.
  }
}

function saveServerUrl() {
  try {
    const value = validateServerUrl(elements["server-url"].value);
    window.SONIC_SERVER_URL = value;
    storageSet("sonic-race-server", value);
    elements["server-url"].value = value;
    showSetupError("");
    notify("Multiplayer server saved on this device.", "success");
    refreshButtons();
  } catch (error) {
    showSetupError(error.message);
  }
}

function validateServerUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Enter the full multiplayer server URL, including https://.");
  }
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) {
    throw new Error("Use an HTTPS or WSS multiplayer server URL.");
  }
  if (location.protocol === "https:" && ["http:", "ws:"].includes(url.protocol)) {
    throw new Error("An HTTPS GitHub Page requires an HTTPS or WSS server URL.");
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

function requiresExternalServer() {
  return location.hostname.endsWith("github.io") || location.protocol === "file:";
}

function setConnectionState(state) {
  const element = elements["connection-state"];
  const label = element.querySelector("span");
  element.classList.remove("warning", "offline");
  if (state === "connected" || state === "reconnected") {
    label.textContent = "Connected";
    if (state === "reconnected") notify("Connection restored.", "success");
  } else if (state === "reconnecting") {
    element.classList.add("warning");
    label.textContent = "Reconnecting";
  } else {
    element.classList.add("offline");
    label.textContent = "Offline";
  }
}

async function copyLobbyCode() {
  if (!app.lobby) return;
  try {
    await navigator.clipboard.writeText(app.lobby.code);
    notify("Lobby code copied.", "success");
  } catch {
    notify(`Lobby code: ${app.lobby.code}`);
  }
}

function notify(text, tone = "info", duration = 4300) {
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = text;
  elements["toast-stack"].append(toast);
  setTimeout(() => toast.remove(), duration);
}

function showSetupError(message) {
  elements["setup-error"].textContent = message;
}

function newToken() {
  return crypto.randomUUID().replaceAll("-", "_");
}

function formatBytes(bytes) {
  return `${Math.round(bytes / 1024)} KiB`;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The active tab still works; only cross-refresh reconnect memory is unavailable.
  }
}
