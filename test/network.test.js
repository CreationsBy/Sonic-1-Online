import assert from "node:assert/strict";
import test from "node:test";
import { buildSocketUrl } from "../public/js/network.js";

test("uses the same host WebSocket when the Node server serves the client", () => {
  assert.equal(buildSocketUrl("", "http://localhost:8080/public/"), "ws://localhost:8080/ws");
  assert.equal(buildSocketUrl("", "https://play.example.com/"), "wss://play.example.com/ws");
});

test("converts a GitHub Pages external HTTPS backend to WSS", () => {
  assert.equal(
    buildSocketUrl("https://sonic-server.example.com", "https://name.github.io/online-sonic/"),
    "wss://sonic-server.example.com/ws"
  );
  assert.equal(
    buildSocketUrl("https://sonic-server.example.com/app", "https://name.github.io/online-sonic/"),
    "wss://sonic-server.example.com/app/ws"
  );
});

test("preserves an explicit WSS endpoint without duplicating /ws", () => {
  assert.equal(
    buildSocketUrl("wss://sonic-server.example.com/ws", "https://name.github.io/online-sonic/"),
    "wss://sonic-server.example.com/ws"
  );
});
