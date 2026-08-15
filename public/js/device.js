export function detectDevice(navigatorLike = globalThis.navigator ?? {}, matchMediaLike = globalThis.matchMedia) {
  const userAgent = String(navigatorLike.userAgent ?? "");
  const platform = String(navigatorLike.platform ?? "");
  const touchPoints = Number(navigatorLike.maxTouchPoints ?? 0);
  let coarsePointer = false;
  if (typeof matchMediaLike === "function") {
    try {
      coarsePointer = Boolean(matchMediaLike.call(globalThis, "(pointer: coarse)").matches);
    } catch {
      coarsePointer = false;
    }
  }
  const reportedMobile = navigatorLike.userAgentData?.mobile;

  // Modern iPadOS can identify itself as Macintosh, so touch points matter.
  const isIPad = /iPad/i.test(userAgent) || (platform === "MacIntel" && touchPoints > 1);
  const isIOS = /iPhone|iPod/i.test(userAgent) || isIPad;
  const isMac = /Mac/i.test(platform) || /Macintosh/i.test(userAgent);
  const isApple = isIOS || isMac;
  const isTouch = isIOS || touchPoints > 0 || coarsePointer;
  const isMobile = typeof reportedMobile === "boolean"
    ? reportedMobile || isIPad
    : /Android|iPhone|iPod|Mobile/i.test(userAgent) || isIPad || (isTouch && !isMac);

  return Object.freeze({ isApple, isIOS, isIPad, isMac, isTouch, isMobile });
}

export const deviceProfile = detectDevice();

export function applyDeviceClasses(root = document.documentElement, profile = deviceProfile) {
  root.classList.toggle("apple-device", profile.isApple);
  root.classList.toggle("ios-device", profile.isIOS);
  root.classList.toggle("touch-device", profile.isTouch);
  root.classList.toggle("mobile-device", profile.isMobile);
  root.dataset.device = profile.isIOS ? "ios" : profile.isMac ? "mac" : profile.isMobile ? "mobile" : "desktop";
  return profile;
}
