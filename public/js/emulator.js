import { colorForSlot, stageFromZoneAct } from "./protocol-constants.js";
import { readSonicTelemetry } from "./sonic-memory.js";
import { createPlayerRomBlob } from "./sonic-rom-palette.js";
import { deviceProfile } from "./device.js";

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 224;
export const TELEMETRY_INTERVAL_MS = 250;
const CHECKPOINT_INTERVAL_MS = 5000;
const SPECTATOR_FRAME_INTERVAL_MS = deviceProfile.isMobile ? 500 : 340;

export const NATIVE_SPEED_OPTIONS = Object.freeze({
  vsync: "enabled",
  fastForward: "disabled",
  slowMotion: "disabled",
  rewindEnabled: "disabled",
  shader: "disabled",
  fps: "hide"
});

export class SonicEmulator {
  constructor({ onTelemetry, onCheckpoint, onReady, getPlayers, getSelf }) {
    this.onTelemetry = onTelemetry;
    this.onCheckpoint = onCheckpoint;
    this.onReady = onReady;
    this.getPlayers = getPlayers;
    this.getSelf = getSelf;
    this.started = false;
    this.ready = false;
    this.pendingResumeState = null;
    this.latestState = null;
    this.localTelemetry = null;
    this.visualPositions = new Map();
    this.objectUrl = null;
    this.pollBusy = false;
    this.lastCheckpointAt = 0;
    this.gameCanvas = null;
    this.spectatorFrameCanvas = document.createElement("canvas");
    this.spectatorFrameCanvas.width = VIEW_WIDTH;
    this.spectatorFrameCanvas.height = VIEW_HEIGHT;
    this.spectatorFrameTimer = null;
    this.spectatorFrameCallback = null;
  }

  async start(romFile, resumeState = null) {
    if (this.started) return;
    if (!(romFile instanceof File)) throw new Error("Select the Sonic 1 ROM before starting.");
    this.started = true;
    this.pendingResumeState = resumeState;
    try {
      const playableRom = await createPlayerRomBlob(romFile, this.getSelf?.()?.slot ?? 1);
      this.objectUrl = URL.createObjectURL(playableRom);
    } catch (error) {
      this.started = false;
      throw error;
    }

    const emulatorHost = document.querySelector("#game");
    emulatorHost.replaceChildren();

    window.EJS_player = "#game";
    window.EJS_core = "segaMD";
    window.EJS_gameName = "Sonic 1 Online";
    window.EJS_gameID = 1009;
    window.EJS_gameUrl = this.objectUrl;
    window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
    window.EJS_startOnLoaded = true;
    window.EJS_threads = false;
    window.EJS_browserMode = deviceProfile.isTouch ? "mobile" : "desktop";
    window.EJS_noAutoFocus = false;
    window.EJS_controlScheme = "segaMD";
    window.EJS_disableDatabases = true;
    window.EJS_disableLocalStorage = true;
    window.EJS_defaultOptions = {
      ...NATIVE_SPEED_OPTIONS,
      "save-state-location": "browser",
    };
    window.EJS_Buttons = {
      saveState: false,
      loadState: false,
      quickSave: false,
      quickLoad: false,
      netplay: false,
      gamepad: deviceProfile.isTouch,
      exitEmulation: false
    };
    if (deviceProfile.isTouch) {
      window.EJS_VirtualGamepadSettings = genesisTouchLayout();
    }
    window.EJS_onGameStart = () => this.#gameStarted();

    await loadEmulatorJs();
  }

  queueResumeState(bytes) {
    if (!(bytes instanceof Uint8Array)) return;
    if (this.ready) this.#applyState(bytes);
    else this.pendingResumeState = bytes;
  }

  checkpointNow() {
    if (this.latestState) this.onCheckpoint?.(this.latestState);
  }

  pause() {
    window.EJS_emulator?.pause?.();
  }

  setSpectatorDemand(enabled, onFrame) {
    this.spectatorFrameCallback = onFrame;
    if (!enabled) {
      clearInterval(this.spectatorFrameTimer);
      this.spectatorFrameTimer = null;
      return;
    }
    if (this.spectatorFrameTimer) return;
    this.#sendSpectatorFrame();
    this.spectatorFrameTimer = setInterval(() => this.#sendSpectatorFrame(), SPECTATOR_FRAME_INTERVAL_MS);
  }

  #gameStarted() {
    this.#waitForManager()
      .then(async () => {
        if (this.pendingResumeState) {
          await delay(650);
          this.#applyState(this.pendingResumeState);
          this.pendingResumeState = null;
        }
        this.ready = true;
        this.onReady?.();
        this.#attachOverlay();
        this.pollTimer = setInterval(() => this.#poll(), TELEMETRY_INTERVAL_MS);
        this.#poll();
      })
      .catch((error) => this.onReady?.(error));
  }

  async #waitForManager(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const manager = window.EJS_emulator?.gameManager;
      if (manager?.getState && manager?.loadState) return manager;
      await delay(100);
    }
    throw new Error("The Genesis emulator did not finish loading.");
  }

  #applyState(bytes) {
    try {
      window.EJS_emulator?.gameManager?.loadState(new Uint8Array(bytes));
    } catch (error) {
      console.error("Could not restore reconnect checkpoint", error);
    }
  }

  async #poll() {
    if (this.pollBusy || !this.ready) return;
    this.pollBusy = true;
    try {
      const value = await Promise.resolve(window.EJS_emulator.gameManager.getState());
      const state = toUint8Array(value);
      if (!state) return;
      this.latestState = state;

      const telemetry = readSonicTelemetry(state);
      if (telemetry) {
        this.localTelemetry = telemetry;
        this.onTelemetry?.({
          x: telemetry.x,
          y: telemetry.y,
          cameraX: telemetry.cameraX,
          cameraY: telemetry.cameraY,
          zoneAct: telemetry.zoneAct,
          mode: telemetry.mode,
          status: telemetry.status,
          visible: telemetry.visible
        });
      }

      if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        this.lastCheckpointAt = Date.now();
        this.onCheckpoint?.(state);
      }
    } finally {
      this.pollBusy = false;
    }
  }

  #attachOverlay() {
    const layer = document.querySelector("#player-name-layer");
    const shell = document.querySelector("#game-shell");
    const context = layer.getContext("2d");
    layer.width = VIEW_WIDTH;
    layer.height = VIEW_HEIGHT;

    const align = () => {
      const candidates = [...document.querySelectorAll("#game canvas")]
        .filter((canvas) => canvas !== layer);
      const gameCanvas = candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];
      if (!gameCanvas) return;
      this.gameCanvas = gameCanvas;
      const gameRect = gameCanvas.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      Object.assign(layer.style, {
        left: `${gameRect.left - shellRect.left}px`,
        top: `${gameRect.top - shellRect.top}px`,
        width: `${gameRect.width}px`,
        height: `${gameRect.height}px`
      });
    };

    new ResizeObserver(align).observe(shell);
    window.addEventListener("resize", align);
    setTimeout(align, 100);

    const draw = () => {
      this.#drawOverlay(context);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  #drawOverlay(context) {
    context.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    const local = this.localTelemetry;
    const self = this.getSelf?.();
    if (!local || !self || !local.visible) return;

    const localX = local.x - local.cameraX;
    const localY = local.y - local.cameraY;

    drawNameTag(context, self.name, localX, localY - 23, self.color);

    for (const player of this.getPlayers?.() ?? []) {
      if (player.id === self.id || !player.connected || !player.telemetry?.visible) continue;
      const remote = player.telemetry;
      if (remote.zoneAct !== local.zoneAct || remote.mode !== 0x0c) continue;

      const targetX = remote.x - local.cameraX;
      const targetY = remote.y - local.cameraY;
      const previous = this.visualPositions.get(player.id) ?? { x: targetX, y: targetY };
      previous.x += (targetX - previous.x) * 0.32;
      previous.y += (targetY - previous.y) * 0.32;
      this.visualPositions.set(player.id, previous);

      if (previous.x > -24 && previous.x < VIEW_WIDTH + 24 && previous.y > -32 && previous.y < VIEW_HEIGHT + 28) {
        drawNameTag(
          context,
          player.name,
          previous.x,
          previous.y - 23,
          player.color ?? colorForSlot(player.slot)
        );
      } else {
        drawEdgeMarker(context, previous.x, previous.y, remote.x - local.x, player);
      }
    }
  }

  #sendSpectatorFrame() {
    const source = this.gameCanvas;
    if (!source?.width || !source?.height || !this.spectatorFrameCallback) return;
    const context = this.spectatorFrameCanvas.getContext("2d");
    try {
      context.fillStyle = "#000";
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      context.imageSmoothingEnabled = false;
      context.drawImage(source, 0, 0, this.spectatorFrameCanvas.width, this.spectatorFrameCanvas.height);
      const overlay = document.querySelector("#player-name-layer");
      if (overlay?.width && overlay?.height) {
        context.drawImage(overlay, 0, 0, this.spectatorFrameCanvas.width, this.spectatorFrameCanvas.height);
      }
      const dataUrl = this.spectatorFrameCanvas.toDataURL("image/jpeg", 0.58);
      this.spectatorFrameCallback(dataUrl);
    } catch {
      // WebGL readback can be unavailable on a minority of browser/GPU combinations.
    }
  }
}

function genesisTouchLayout() {
  return [
    {
      type: "dpad",
      location: "left",
      left: "50%",
      top: "50%",
      joystickInput: false,
      inputValues: [4, 5, 6, 7]
    },
    {
      type: "button",
      text: "A",
      id: "genesis-a",
      location: "right",
      left: 4,
      top: 72,
      bold: true,
      fontSize: 21,
      input_value: 1
    },
    {
      type: "button",
      text: "B",
      id: "genesis-b",
      location: "right",
      left: 54,
      top: 38,
      bold: true,
      fontSize: 21,
      input_value: 0
    },
    {
      type: "button",
      text: "C",
      id: "genesis-c",
      location: "right",
      left: 104,
      top: 4,
      bold: true,
      fontSize: 21,
      input_value: 8
    },
    {
      type: "button",
      text: "START",
      id: "genesis-start",
      location: "center",
      left: 0,
      top: 8,
      block: true,
      bold: true,
      fontSize: 12,
      input_value: 3
    }
  ];
}

export function drawNameTag(context, name, x, y, color) {
  context.save();
  context.font = "bold 8px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  const label = String(name ?? "").slice(0, 16);
  const halfWidth = Math.ceil(context.measureText(label).width / 2) + 3;
  const labelX = Math.max(halfWidth, Math.min(VIEW_WIDTH - halfWidth, Math.round(x)));
  const labelY = Math.max(10, Math.min(VIEW_HEIGHT - 2, Math.round(y)));
  context.lineWidth = 3;
  context.strokeStyle = "#061329";
  context.strokeText(label, labelX, labelY);
  context.fillStyle = color;
  context.fillText(label, labelX, labelY);
  context.restore();
}

function drawEdgeMarker(context, x, y, deltaX, player) {
  const edgeX = x < 0 ? 10 : x > VIEW_WIDTH ? VIEW_WIDTH - 10 : Math.max(10, Math.min(VIEW_WIDTH - 10, x));
  const edgeY = Math.max(18, Math.min(VIEW_HEIGHT - 14, y));
  const direction = x < 0 ? -1 : x > VIEW_WIDTH ? 1 : 0;

  context.save();
  context.translate(edgeX, edgeY);
  context.fillStyle = player.color;
  context.strokeStyle = "#061329";
  context.lineWidth = 1.5;
  context.beginPath();
  if (direction) {
    context.moveTo(direction * 7, 0);
    context.lineTo(-direction * 3, -6);
    context.lineTo(-direction * 3, 6);
  } else {
    context.arc(0, 0, 6, 0, Math.PI * 2);
  }
  context.closePath();
  context.fill();
  context.stroke();
  context.font = "bold 7px system-ui, sans-serif";
  context.textAlign = direction < 0 ? "left" : "right";
  context.fillStyle = player.color ?? colorForSlot(player.slot);
  context.strokeStyle = "#061329";
  const label = `${player.name} ${Math.abs(Math.round(deltaX))}px`;
  context.strokeText(label, direction < 0 ? 9 : -9, -7);
  context.fillText(label, direction < 0 ? 9 : -9, -7);
  context.restore();
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function loadEmulatorJs() {
  if (document.querySelector("script[data-emulatorjs-loader]")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.dataset.emulatorjsLoader = "true";
    script.src = "https://cdn.emulatorjs.org/stable/data/loader.js";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Could not download the EmulatorJS runtime.")), { once: true });
    document.body.appendChild(script);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatTelemetryStage(telemetry) {
  return stageFromZoneAct(telemetry?.zoneAct)?.label ?? "Waiting for stage";
}
