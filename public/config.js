// The Node app uses its own origin automatically during local development.
// The published GitHub Pages client uses this owner-managed Cloudflare Worker;
// visitors are never asked for a server address.
window.SONIC_SERVER_URL = window.SONIC_SERVER_URL || (
  location.hostname.endsWith(".github.io")
    ? "https://sonic-1-online.spaghettijedi.workers.dev"
    : ""
);
