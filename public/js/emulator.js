import { PLAYER_COLORS, colorForSlot, stageFromZoneAct } from "./protocol-constants.js";
import { readSonicTelemetry } from "./sonic-memory.js";
import { deviceProfile } from "./device.js";

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 224;
const TELEMETRY_INTERVAL_MS = 160;
const CHECKPOINT_INTERVAL_MS = 5000;
const SPECTATOR_FRAME_INTERVAL_MS = deviceProfile.isMobile ? 500 : 340;

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
    this.spriteVariants = new Map();
    this.spriteFacingLeft = false;
    this.spriteCapture = document.createElement("canvas");
    this.spriteCapture.width = 40;
    this.spriteCapture.height = 48;
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
    this.objectUrl = URL.createObjectURL(romFile);

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
    window.EJS_noAutoFocus = false;
    window.EJS_controlScheme = "segaMD";
    window.EJS_disableDatabases = true;
    window.EJS_disableLocalStorage = false;
    window.EJS_defaultOptions = {
      "save-state-location": "browser",
      rewindEnabled: "disabled"
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
        const pollInterval = deviceProfile.isMobile ? 240 : TELEMETRY_INTERVAL_MS;
        this.pollTimer = setInterval(() => this.#poll(), pollInterval);
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
        if (telemetry.visible) this.#refreshSpriteVariants(telemetry);
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
    const layer = document.querySelector("#ghost-layer");
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

    // Players 2–4 get their assigned color drawn over the native blue Sonic.
    if (self.slot > 1) {
      drawPlayerGhost(
        context,
        localX,
        localY,
        self.color,
        self.name,
        Boolean(local.status & 1),
        true,
        this.spriteVariants.get(self.color),
        this.spriteFacingLeft
      );
    } else {
      // Player 1 keeps the game's native blue sprite but still gets a live tag.
      drawNameTag(context, self.name, localX, localY - 23, self.color);
    }

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
        drawPlayerGhost(
          context,
          previous.x,
          previous.y,
          player.color ?? colorForSlot(player.slot),
          player.name,
          Boolean(remote.status & 1),
          false,
          this.spriteVariants.get(player.color ?? colorForSlot(player.slot)),
          this.spriteFacingLeft
        );
      } else {
        drawEdgeMarker(context, previous.x, previous.y, remote.x - local.x, player);
      }
    }
  }

  #refreshSpriteVariants(telemetry) {
    const source = this.gameCanvas;
    if (!source?.width || !source?.height) return;
    const screenX = telemetry.x - telemetry.cameraX;
    const screenY = telemetry.y - telemetry.cameraY;
    if (screenX < 12 || screenX > VIEW_WIDTH - 12 || screenY < 18 || screenY > VIEW_HEIGHT - 12) return;

    const context = this.spriteCapture.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, 40, 48);
    context.imageSmoothingEnabled = false;
    try {
      const scaleX = source.width / VIEW_WIDTH;
      const scaleY = source.height / VIEW_HEIGHT;
      context.drawImage(
        source,
        (screenX - 20) * scaleX,
        (screenY - 24) * scaleY,
        40 * scaleX,
        48 * scaleY,
        0,
        0,
        40,
        48
      );
      const sourceImage = context.getImageData(0, 0, 40, 48);
      const mask = makeSonicMask(sourceImage.data, 40, 48);
      if (mask.pixelCount < 45) return;

      this.spriteVariants.clear();
      for (const color of PLAYER_COLORS) {
        this.spriteVariants.set(color, recolorSprite(sourceImage, mask.keep, color));
      }
      this.spriteFacingLeft = Boolean(telemetry.status & 1);
    } catch {
      // Some WebGL configurations disallow readback; the vector fallback remains available.
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
      const overlay = document.querySelector("#ghost-layer");
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

function drawPlayerGhost(context, x, y, color, name, facingLeft, localSkin, sprite, spriteFacingLeft) {
  if (!sprite) {
    drawGhostSonic(context, x, y, color, name, facingLeft, localSkin);
    return;
  }

  context.save();
  context.translate(Math.round(x), Math.round(y));
  if (facingLeft !== spriteFacingLeft) context.scale(-1, 1);
  context.globalAlpha = localSkin ? 1 : 0.88;
  context.strokeStyle = `${color}99`;
  context.lineWidth = 2;
  context.beginPath();
  context.ellipse(0, 15, 13, 4, 0, 0, Math.PI * 2);
  context.stroke();
  context.drawImage(sprite, -20, -24);
  context.restore();
  drawNameTag(context, name, x, y - 23, color);
}

function drawGhostSonic(context, x, y, color, name, facingLeft, localSkin) {
  context.save();
  context.translate(Math.round(x), Math.round(y));
  context.scale(facingLeft ? -1 : 1, 1);
  context.globalAlpha = localSkin ? 0.98 : 0.88;
  context.lineJoin = "round";
  context.lineCap = "round";

  // Aura separates a shared player from the native game pixels.
  context.strokeStyle = `${color}88`;
  context.lineWidth = 2;
  context.beginPath();
  context.ellipse(0, 14, 12, 4, 0, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = color;
  context.strokeStyle = "#07152d";
  context.lineWidth = 1.5;

  // Quills, head, and body form a compact Sonic-like live marker.
  context.beginPath();
  context.moveTo(-6, -13);
  context.lineTo(-16, -18);
  context.lineTo(-11, -9);
  context.lineTo(-19, -8);
  context.lineTo(-10, -2);
  context.lineTo(-17, 2);
  context.lineTo(-6, 3);
  context.closePath();
  context.fill();
  context.stroke();
  context.beginPath();
  context.ellipse(0, -8, 9, 10, -0.12, 0, Math.PI * 2);
  context.ellipse(-1, 4, 8, 10, 0.12, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.fillStyle = "#f4bd72";
  context.beginPath();
  context.ellipse(5, -5, 5.5, 6, -0.2, 0, Math.PI * 2);
  context.ellipse(2, 4, 4.5, 6, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "white";
  context.beginPath();
  context.ellipse(3, -12, 2.6, 4.8, -0.1, 0, Math.PI * 2);
  context.ellipse(7, -11.5, 2.4, 4.5, 0.1, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#07152d";
  context.fillRect(6, -12, 1.5, 3);
  context.beginPath();
  context.arc(10, -5, 1.3, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = color;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(-5, 2);
  context.lineTo(-10, 7);
  context.moveTo(5, 2);
  context.lineTo(10, 7);
  context.stroke();
  context.fillStyle = "white";
  context.beginPath();
  context.arc(-11, 8, 3, 0, Math.PI * 2);
  context.arc(11, 8, 3, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "#f4bd72";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(-3, 10);
  context.lineTo(-4, 15);
  context.moveTo(3, 10);
  context.lineTo(5, 15);
  context.stroke();
  context.fillStyle = "#ef334d";
  context.strokeStyle = "white";
  context.lineWidth = 1.5;
  context.beginPath();
  context.ellipse(-7, 16, 6, 2.8, -0.08, 0, Math.PI * 2);
  context.ellipse(8, 16, 6, 2.8, 0.08, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();

  drawNameTag(context, name, x, y - 21, color);
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

function makeSonicMask(pixels, width, height) {
  const base = new Uint8Array(width * height);
  const keep = new Uint8Array(width * height);
  let pixelCount = 0;

  for (let index = 0; index < base.length; index += 1) {
    const offset = index * 4;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (alpha > 80 && isSonicColor(r, g, b)) base[index] = 1;
  }

  // Retain dark outline pixels immediately around recognizable sprite colors.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const dark = pixels[offset] < 72 && pixels[offset + 1] < 72 && pixels[offset + 2] < 90;
      let nearSprite = Boolean(base[index]);
      if (!nearSprite && dark) {
        for (let dy = -2; dy <= 2 && !nearSprite; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const neighborX = x + dx;
            const neighborY = y + dy;
            if (
              neighborX >= 0 && neighborX < width && neighborY >= 0 && neighborY < height &&
              base[neighborY * width + neighborX]
            ) {
              nearSprite = true;
              break;
            }
          }
        }
      }
      if (nearSprite) {
        keep[index] = 1;
        pixelCount += 1;
      }
    }
  }
  return { keep, pixelCount };
}

function isSonicColor(r, g, b) {
  const blueFur = b > 75 && b > r * 1.25 && b > g * 1.08;
  const gloveWhite = r > 165 && g > 165 && b > 165 && Math.max(r, g, b) - Math.min(r, g, b) < 75;
  const skin = r > 125 && g > 55 && g < 215 && b < 155 && r > g * 1.04;
  const shoeRed = r > 105 && r > g * 1.3 && r > b * 1.18;
  return blueFur || gloveWhite || skin || shoeRed;
}

function recolorSprite(sourceImage, keep, color) {
  const output = new ImageData(new Uint8ClampedArray(sourceImage.data), sourceImage.width, sourceImage.height);
  const [targetR, targetG, targetB] = hexToRgb(color);
  for (let index = 0; index < keep.length; index += 1) {
    const offset = index * 4;
    if (!keep[index]) {
      output.data[offset + 3] = 0;
      continue;
    }
    const r = output.data[offset];
    const g = output.data[offset + 1];
    const b = output.data[offset + 2];
    if (b > 75 && b > r * 1.25 && b > g * 1.08) {
      const light = Math.max(0.45, Math.min(1.15, b / 210));
      output.data[offset] = targetR * light;
      output.data[offset + 1] = targetG * light;
      output.data[offset + 2] = targetB * light;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  canvas.getContext("2d").putImageData(output, 0, 0);
  return canvas;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
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
