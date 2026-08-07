#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { writeFileSync } from "node:fs";
import { loadConfig, requireProfiles } from "../lib/config.js";
import { openStore } from "../lib/store.js";
import { Scraper } from "../lib/scraper.js";
import { buildFeed } from "../lib/rssfeed.js";
import { publishFeed } from "../lib/publish.js";
import { startServer } from "../lib/server.js";

function usage() {
  console.error(`Usage:
  node bin/cli.js login   [--config config.yaml]           Interactive Facebook login; saves session.json
  node bin/cli.js fetch   [--config config.yaml] [--push]  Scrape profiles and update SQLite + feed.xml
  node bin/cli.js clean   [--config config.yaml] [--push]  Delete all stored posts and rewrite feed.xml
  node bin/cli.js publish                                  Commit and push feed.xml (GitHub Pages)
  node bin/cli.js serve   [--config config.yaml]           Serve GET /feed.xml for Tapestry

Typical cron (GitHub Pages):
  */15 * * * * cd /path/to/facebook-rss && node bin/cli.js fetch --push
`);
}

function parseArgs(argv) {
  const out = { config: "config.yaml", push: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-config") {
      out.config = argv[++i];
    } else if (a === "--push" || a === "-push") {
      out.push = true;
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function writeFeed(cfg, store) {
  const posts = store.list(50);
  const body = buildFeed(cfg.feed, posts);
  writeFileSync("feed.xml", body, "utf8");
  console.log("facebook-rss: wrote feed.xml");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || args.help || cmd === "help") {
    usage();
    process.exit(cmd ? 0 : 2);
  }

  switch (cmd) {
    case "login": {
      const cfg = loadConfig(args.config);
      await new Scraper(cfg).login();
      break;
    }
    case "fetch": {
      const cfg = loadConfig(args.config);
      requireProfiles(cfg);
      const store = openStore(cfg.databasePath);
      try {
        const posts = await new Scraper(cfg).fetchLatest();
        let added = 0;
        for (const p of posts) {
          const ok = store.upsert(p);
          if (ok) {
            added++;
            console.log(`facebook-rss: new: ${p.title} (${p.url})`);
          } else {
            console.log(`facebook-rss: updated/skipped: ${p.title} (${p.url})`);
          }
        }
        console.log(`facebook-rss: fetched ${posts.length} posts, ${added} new`);
        writeFeed(cfg, store);
        if (args.push) {
          publishFeed("Update feed.xml");
          console.log("facebook-rss: pushed feed.xml to GitHub");
        }
      } finally {
        store.close();
      }
      break;
    }
    case "clean": {
      const cfg = loadConfig(args.config);
      const store = openStore(cfg.databasePath);
      try {
        store.clear();
        writeFeed(cfg, store);
        console.log("facebook-rss: cleared all posts and rewrote empty feed.xml");
        if (args.push) {
          publishFeed("Clear feed.xml");
          console.log("facebook-rss: pushed feed.xml to GitHub");
        }
      } finally {
        store.close();
      }
      break;
    }
    case "publish": {
      publishFeed("Update feed.xml");
      console.log("facebook-rss: pushed feed.xml to GitHub");
      break;
    }
    case "serve": {
      const cfg = loadConfig(args.config);
      const store = openStore(cfg.databasePath);
      await startServer(cfg, store);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`facebook-rss: ${err.stack || err.message || err}`);
  process.exit(1);
});
