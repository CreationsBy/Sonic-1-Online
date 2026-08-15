// Leave blank when the Node server also hosts the website.
// For GitHub Pages, set this to the public HTTPS URL of src/server.js, e.g.
// window.SONIC_SERVER_URL = "https://your-sonic-server.example.com";
let storedSonicServer = "";
try {
  storedSonicServer = localStorage.getItem("sonic-race-server") || "";
} catch {
  // Storage can be unavailable in strict/private browser contexts.
}
window.SONIC_SERVER_URL = window.SONIC_SERVER_URL || storedSonicServer;
