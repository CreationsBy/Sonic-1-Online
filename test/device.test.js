import assert from "node:assert/strict";
import test from "node:test";
import { detectDevice } from "../public/js/device.js";

const media = (coarse) => () => ({ matches: coarse });

test("detects iPhone as Apple, iOS, mobile, and touch", () => {
  const result = detectDevice({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    platform: "iPhone",
    maxTouchPoints: 5
  }, media(true));
  assert.deepEqual(result, {
    isApple: true,
    isIOS: true,
    isIPad: false,
    isMac: false,
    isTouch: true,
    isMobile: true
  });
});

test("keeps touch controls enabled for an iPhone UA even before touch-point reporting is available", () => {
  const result = detectDevice({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    platform: "iPhone",
    maxTouchPoints: 0
  }, media(false));
  assert.equal(result.isIOS, true);
  assert.equal(result.isTouch, true);
});

test("detects modern iPadOS when Safari reports MacIntel", () => {
  const result = detectDevice({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5
  }, media(true));
  assert.equal(result.isApple, true);
  assert.equal(result.isIOS, true);
  assert.equal(result.isIPad, true);
  assert.equal(result.isTouch, true);
  assert.equal(result.isMobile, true);
});

test("detects a desktop Mac without enabling touch/mobile mode", () => {
  const result = detectDevice({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    platform: "MacIntel",
    maxTouchPoints: 0
  }, media(false));
  assert.equal(result.isApple, true);
  assert.equal(result.isMac, true);
  assert.equal(result.isIOS, false);
  assert.equal(result.isTouch, false);
  assert.equal(result.isMobile, false);
});

test("detects Android as mobile touch but not Apple", () => {
  const result = detectDevice({
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile",
    platform: "Linux armv8l",
    maxTouchPoints: 5
  }, media(true));
  assert.equal(result.isApple, false);
  assert.equal(result.isTouch, true);
  assert.equal(result.isMobile, true);
});
