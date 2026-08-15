export class LobbyConnection extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.joinRequest = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.connectedOnce = false;
  }

  connect(request) {
    this.intentionalClose = false;
    this.joinRequest = { ...request };
    return this.#open();
  }

  send(type, extra = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (type === "spectator-frame" && this.socket.bufferedAmount > 500_000) return false;
    this.socket.send(JSON.stringify({ type, ...extra }));
    return true;
  }

  sendCheckpoint(bytes) {
    if (this.socket?.readyState !== WebSocket.OPEN || !(bytes instanceof Uint8Array)) return false;
    this.socket.send(bytes);
    return true;
  }

  rememberLobby(code) {
    if (!this.joinRequest) return;
    this.joinRequest = { ...this.joinRequest, type: "join", code };
  }

  close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Left lobby");
  }

  #open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(resolveSocketUrl());
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let settled = false;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(this.joinRequest));
        this.#emit("connection", { state: this.connectedOnce ? "reconnected" : "connected" });
      });

      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.#emit("checkpoint", new Uint8Array(event.data));
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        this.#emit("message", message);
        if (message.type === "session") {
          this.connectedOnce = true;
          settled = true;
          resolve(message);
        } else if (message.type === "error" && !settled) {
          settled = true;
          reject(new Error(message.message));
        }
      });

      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.#emit("connection", { state: "disconnected", code: event.code });
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the lobby server."));
        }
        if (!this.intentionalClose && this.joinRequest?.type === "join") {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.#emit("connection", { state: "reconnecting" });
            this.#open().catch(() => {});
          }, 1800);
        }
      });

      socket.addEventListener("error", () => {
        // The close event owns retry and user-facing state.
      });
    });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export function getConfiguredServerUrl() {
  return String(window.SONIC_SERVER_URL || "").trim();
}

export function resolveSocketUrl() {
  return buildSocketUrl(getConfiguredServerUrl(), location.href);
}

export function buildSocketUrl(configured, pageHref) {
  configured = String(configured || "").trim();
  const page = new URL(pageHref);
  if (!configured) {
    if (page.hostname.toLowerCase().endsWith(".github.io")) {
      throw new Error(
        "Online lobbies are not configured for this GitHub Pages deployment. The site owner must deploy the multiplayer service."
      );
    }
    page.protocol = page.protocol === "https:" ? "wss:" : "ws:";
    page.pathname = "/ws";
    page.search = "";
    page.hash = "";
    return page.href;
  }

  const url = new URL(configured, page);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("The multiplayer server must use HTTPS, HTTP, WSS, or WS.");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  else if (!url.pathname.endsWith("/ws")) url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.href;
}
