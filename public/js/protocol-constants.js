export const MAX_PLAYERS = 4;

// SHA-256 of rom/Sonic The Hedgehog (USA, Europe).md in this project.
// The ROM never leaves the player's browser; this digest only gates the one
// supported revision so that the RAM map below cannot be applied to a wrong ROM.
export const SONIC_ROM = Object.freeze({
  title: "Sonic the Hedgehog (USA, Europe)",
  size: 524288,
  sha256: "46160baa06362c711c9f1a5017cb7371026444936c8af5e93a78996cf32ff2a6"
});

export const PLAYER_COLORS = Object.freeze([
  "#168cff", // player 1: blue
  "#ff3d52", // player 2: red
  "#ffd83d", // player 3: yellow
  "#43df72"  // player 4: green
]);

const ZONE_NAMES = Object.freeze([
  "Green Hill Zone",
  "Labyrinth Zone",
  "Marble Zone",
  "Star Light Zone",
  "Spring Yard Zone",
  "Scrap Brain Zone",
  "Final Zone"
]);

export function stageFromZoneAct(zoneAct) {
  if (!Number.isInteger(zoneAct) || zoneAct < 0 || zoneAct > 0xffff) return null;
  const zone = (zoneAct >>> 8) & 0xff;
  const act = zoneAct & 0xff;
  const name = ZONE_NAMES[zone];
  if (!name) return null;

  if (zone === 6) {
    if (act !== 0) return null;
    return { key: "6:0", zone, act, name, label: name };
  }

  if (act > 2) return null;
  return {
    key: `${zone}:${act}`,
    zone,
    act,
    name,
    label: `${name} — Act ${act + 1}`
  };
}

export function colorForSlot(slot) {
  return PLAYER_COLORS[Math.max(0, Math.min(MAX_PLAYERS - 1, Number(slot) - 1))];
}
