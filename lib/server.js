import http from "node:http";
import { buildFeed } from "./rssfeed.js";

/**
 * @param {object} cfg
 * @param {import('./store.js').Store} store
 */
export function startServer(cfg, store) {
  const listen = cfg.listen.startsWith(":") ? cfg.listen.slice(1) : cfg.listen;
  const port = Number(listen) || 8080;

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/feed.xml" || req.url === "/") {
      try {
        const posts = store.list(50);
        const body = buildFeed(cfg.feed, posts);
        res.writeHead(200, {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        });
        res.end(body);
      } catch (err) {
        console.error("facebook-rss:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("failed to build feed");
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`facebook-rss: Serving RSS at http://localhost:${port}/feed.xml`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
