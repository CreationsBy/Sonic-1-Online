import { stageFromZoneAct } from "./protocol-constants.js";

const SIGNATURE = new TextEncoder().encode("GENPLUS-GX");
const WORK_RAM_BYTES = 0x10000;

// Sonic 1 (REV00/REV01) RAM labels from the game's 68K work RAM map.
export const RAM = Object.freeze({
  sonicObject: 0xd000,
  sonicX: 0xd008,
  sonicY: 0xd00c,
  sonicStatus: 0xd022,
  gameMode: 0xf600,
  cameraX: 0xf700,
  cameraY: 0xf704,
  zoneAct: 0xfe10
});

/**
 * Pull the 64 KiB Genesis work-RAM block out of a Genesis Plus GX state.
 * The core serializes: 16-byte "GENPLUS-GX ..." version, then work_ram.
 * We search the first 128 bytes as a guard against a frontend prefix.
 */
export function findWorkRam(stateLike) {
  const state = asBytes(stateLike);
  if (!state) return null;

  const signatureAt = findSequence(state, SIGNATURE, 128);
  if (signatureAt < 0) return null;
  const start = signatureAt + 16;
  if (start + WORK_RAM_BYTES > state.byteLength) return null;
  return state.subarray(start, start + WORK_RAM_BYTES);
}

export function readSonicTelemetry(stateLike) {
  const ram = findWorkRam(stateLike);
  if (!ram) return null;

  // Genesis Plus GX stores 16-bit 68000 words in host (little-endian WASM)
  // order. Byte accesses therefore use address XOR 1.
  const word = (address) => ram[address] | (ram[address + 1] << 8);
  const byte = (address) => ram[address ^ 1];

  const mode = byte(RAM.gameMode);
  const zoneAct = word(RAM.zoneAct);
  const x = word(RAM.sonicX);
  const y = word(RAM.sonicY);
  const cameraX = word(RAM.cameraX);
  const cameraY = word(RAM.cameraY);
  const objectId = byte(RAM.sonicObject);
  const status = byte(RAM.sonicStatus);
  const stage = stageFromZoneAct(zoneAct);

  return {
    x,
    y,
    cameraX,
    cameraY,
    zoneAct,
    mode,
    status,
    visible: mode === 0x0c && objectId !== 0 && Boolean(stage),
    stage
  };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function findSequence(haystack, needle, maxStart) {
  const limit = Math.min(maxStart, haystack.byteLength - needle.byteLength);
  outer: for (let index = 0; index <= limit; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
