import assert from "node:assert/strict";
import test from "node:test";
import { genesisChecksum, recolorSonicRom } from "../public/js/sonic-rom-palette.js";

const STOCK_PALETTES = [
  bytes("0000000008220a440c660e880eee0aaa0888044408ae046a000e0008000400ee"),
  bytes("0000000002200442066208840eee0aaa0888044406aa026600480024000200ee"),
  bytes("000000000a260c480e6a0e8c0ece0cac086806460cae086c060c0426000400ee")
];

const EXPECTED_FUR = {
  2: bytes("0228044a066c088e"),
  3: bytes("028804aa06cc08ee"),
  4: bytes("028204a406c608e8")
};

const PALETTE_OFFSETS = [0x220, 0x280, 0x2e0, 0x340];

test("player 1 keeps an unchanged stock ROM", () => {
  const source = exampleRom();
  assert.deepEqual(recolorSonicRom(source, 1), source);
});

for (const slot of [2, 3, 4]) {
  test(`player ${slot} gets native fur palette colors without changing the source`, () => {
    const source = exampleRom();
    const original = new Uint8Array(source);
    const output = recolorSonicRom(source, slot);

    assert.deepEqual(source, original);
    for (const offset of PALETTE_OFFSETS) {
      assert.deepEqual(output.slice(offset + 4, offset + 12), EXPECTED_FUR[slot]);
      assert.deepEqual(output.slice(offset, offset + 4), source.slice(offset, offset + 4));
      assert.deepEqual(output.slice(offset + 12, offset + 32), source.slice(offset + 12, offset + 32));
    }

    const storedChecksum = (output[0x18e] << 8) | output[0x18f];
    assert.equal(storedChecksum, genesisChecksum(output));
  });
}

test("palette patch refuses data that is not the expected Sonic ROM layout", () => {
  assert.throws(
    () => recolorSonicRom(new Uint8Array(0x400), 2),
    /missing an expected Sonic palette/
  );
});

function exampleRom() {
  const rom = new Uint8Array(0x400);
  rom.set(STOCK_PALETTES[0], PALETTE_OFFSETS[0]);
  rom.set(STOCK_PALETTES[1], PALETTE_OFFSETS[1]);
  rom.set(STOCK_PALETTES[2], PALETTE_OFFSETS[2]);
  rom.set(STOCK_PALETTES[0], PALETTE_OFFSETS[3]);
  return rom;
}

function bytes(hex) {
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}
