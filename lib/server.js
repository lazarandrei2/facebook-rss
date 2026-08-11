import http from "node:http";
import { buildFeed } from "./rssfeed.js";

/**
 * @param {object} cfg
 * @param {{ facebook?: import('./store.js').Store, twitter?: import('./store.js').Store }} stores
 */
export function startServer(cfg, stores = {}) {
  const listen = cfg.listen.startsWith(":") ? cfg.listen.slice(1) : cfg.listen;
  const port = Number(listen) || 8080;

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    const path = (req.url || "/").split("?")[0];

    if (path === "/facebook.xml" || path === "/") {
      return serveFeed(res, cfg.facebook?.feed, stores.facebook, "facebook");
    }

    if (path === "/twitter.xml") {
      return serveFeed(res, cfg.twitter?.feed, stores.twitter, "twitter");
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`feeds: Serving Facebook RSS at http://localhost:${port}/facebook.xml`);
      console.log(`feeds: Serving Twitter RSS at http://localhost:${port}/twitter.xml`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

function serveFeed(res, feedCfg, store, label) {
  try {
    if (!store || !feedCfg) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`${label} feed not configured`);
      return;
    }
    const posts = store.list(50);
    const body = buildFeed(feedCfg, posts);
    res.writeHead(200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    });
    res.end(body);
  } catch (err) {
    console.error("feeds:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("failed to build feed");
  }
}
