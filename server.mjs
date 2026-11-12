/**
 * FairPrice server: Next.js plus the Alex bridge (/ws/alex) on the same port. Next's API routes
 * can't hold the long-lived WebSocket Alex needs (mic in, avatar video out), so this small custom
 * server owns the HTTP server and hands every request to Next, and /ws/alex to the bridge.
 *
 *   node server.mjs                 dev (Turbopack, hot reload)
 *   node server.mjs --prod          production (after `next build`)
 *   --port 3100                     any port (default: $PORT or 3000)
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const portArg = args.indexOf("--port");
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 3000);
if (prod) process.env.NODE_ENV = "production";

const { default: next } = await import("next");
const { handleAlexUpgrade } = await import("./lib/alex/bridge.mjs");

const app = next({ dev: !prod, turbopack: !prod, port, hostname: "localhost" });
await app.prepare(); // also loads .env into process.env
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => handle(req, res));
server.on("upgrade", (req, socket, head) => {
  if (handleAlexUpgrade(req, socket, head, port)) return;
  nextUpgrade(req, socket, head); // Next's hot-reload socket in dev
});
server.listen(port, () => console.log(`> FairPrice ready on http://localhost:${port}${prod ? "" : " (dev)"}`));
