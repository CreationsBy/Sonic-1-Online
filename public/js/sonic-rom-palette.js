const SONIC_PALETTES = Object.freeze([
  hexBytes("0000000008220a440c660e880eee0aaa0888044408ae046a000e0008000400ee"),
  hexBytes("0000000002200442066208840eee0aaa0888044406aa026600480024000200ee"),
  hexBytes("000000000a260c480e6a0e8c0ece0cac086806460cae086c060c0426000400ee")
]);

// Mega Drive CRAM colors use the $0BGR format. These four words replace only
// Sonic's four blue fur shades; his skin, eyes, gloves, and shoes stay stock.
const FUR_COLORS = Object.freeze({
  2: hexBytes("0228044a066c088e"), // red
  3: hexBytes("028804aa06cc08ee"), // yellow
  4: hexBytes("028204a406c608e8")  // green
});

const FUR_OFFSET = 4;
const GENESIS_HEADER_CHECKSUM = 0x18e;
const CHECKSUM_DATA_START = 0x200;

export async function createPlayerRomBlob(romFile, slot) {
  const playerSlot = checkedSlot(slot);
  if (playerSlot === 1) return romFile;

  const source = new Uint8Array(await romFile.arrayBuffer());
  const patched = recolorSonicRom(source, playerSlot);
  return new Blob([patched], { type: "application/octet-stream" });
}

export function recolorSonicRom(sourceBytes, slot) {
  const playerSlot = checkedSlot(slot);
  const source = asUint8Array(sourceBytes);
  const output = new Uint8Array(source);
  if (playerSlot === 1) return output;

  const fur = FUR_COLORS[playerSlot];
  for (const palette of SONIC_PALETTES) {
    const matches = findAll(source, palette);
    if (matches.length === 0) {
      throw new Error("The verified Sonic 1 ROM is missing an expected Sonic palette.");
    }
    for (const offset of matches) output.set(fur, offset + FUR_OFFSET);
  }

  updateGenesisChecksum(output);
  return output;
}

export function genesisChecksum(bytes) {
  const rom = asUint8Array(bytes);
  let checksum = 0;
  for (let offset = CHECKSUM_DATA_START; offset < rom.length; offset += 2) {
    const high = rom[offset];
    const low = offset + 1 < rom.length ? rom[offset + 1] : 0;
    checksum = (checksum + (high << 8) + low) & 0xffff;
  }
  return checksum;
}

function updateGenesisChecksum(rom) {
  if (rom.length < CHECKSUM_DATA_START) {
    throw new Error("The selected file is too small to be a Mega Drive ROM.");
  }
  const checksum = genesisChecksum(rom);
  rom[GENESIS_HEADER_CHECKSUM] = checksum >>> 8;
  rom[GENESIS_HEADER_CHECKSUM + 1] = checksum & 0xff;
}

function findAll(haystack, needle) {
  const matches = [];
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    let matchesAtOffset = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        matchesAtOffset = false;
        break;
      }
    }
    if (matchesAtOffset) matches.push(offset);
  }
  return matches;
}

function checkedSlot(slot) {
  const value = Number(slot);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new TypeError("Player slot must be an integer from 1 to 4.");
  }
  return value;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("ROM data must be an ArrayBuffer or typed array.");
}

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}
