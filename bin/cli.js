#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { writeFileSync } from "node:fs";
import {
  loadConfig,
  requireAnyProfiles,
  requireProfiles,
  resolveSourceKeys,
  SOURCES,
} from "../lib/config.js";
import { openStore } from "../lib/store.js";
import { Scraper } from "../lib/scraper.js";
import { TwitterScraper } from "../lib/twitter-scraper.js";
import { buildFeed } from "../lib/rssfeed.js";
import { publishFeed } from "../lib/publish.js";
import { startServer } from "../lib/server.js";

const SCRAPERS = {
  facebook: (cfg) =>
    new Scraper({ headless: cfg.headless, maxPosts: cfg.maxPosts, source: cfg.facebook }),
  twitter: (cfg) =>
    new TwitterScraper({ headless: cfg.headless, maxPosts: cfg.maxPosts, source: cfg.twitter }),
};

function usage() {
  console.error(`Usage:
  node bin/cli.js login  [facebook|twitter] [--config config.yaml]
      Interactive login; saves session cookies for that source
  node bin/cli.js fetch  [facebook|twitter|all] [--config config.yaml] [--push]
      Scrape profiles and update SQLite + facebook.xml / twitter.xml
  node bin/cli.js clean  [facebook|twitter|all] [--config config.yaml] [--push]
      Delete stored posts and rewrite feed xml
  node bin/cli.js publish
      Commit and push facebook.xml and twitter.xml
  node bin/cli.js serve  [--config config.yaml]
      Serve GET /facebook.xml and /twitter.xml

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

function writeSourceFeed(cfg, key, store) {
  const meta = SOURCES[key];
  const source = cfg[key];
  const posts = store.list(50);
  const body = buildFeed(source.feed, posts);
  writeFileSync(meta.xmlFile, body, "utf8");
  console.log(`feeds: wrote ${meta.xmlFile}`);
}

function writeEmptyFeed(feedCfg, path) {
  const body = buildFeed(feedCfg, []);
  writeFileSync(path, body, "utf8");
}

async function fetchSource(cfg, key) {
  const meta = SOURCES[key];
  requireProfiles(cfg, key);
  const source = cfg[key];
  const store = openStore(source.databasePath);
  try {
    const posts = await SCRAPERS[key](cfg).fetchLatest();
    let added = 0;
    for (const p of posts) {
      const ok = store.upsert(p);
      if (ok) {
        added++;
        console.log(`${meta.logPrefix}: new: ${p.title} (${p.url})`);
      } else {
        console.log(`${meta.logPrefix}: updated/skipped: ${p.title} (${p.url})`);
      }
    }
    const unit = key === "twitter" ? "threads" : "posts";
    console.log(`${meta.logPrefix}: fetched ${posts.length} ${unit}, ${added} new`);
    writeSourceFeed(cfg, key, store);
  } finally {
    store.close();
  }
}

async function cleanSource(cfg, key) {
  const meta = SOURCES[key];
  const source = cfg[key];
  if (!source) return;
  const store = openStore(source.databasePath);
  try {
    store.clear();
    writeSourceFeed(cfg, key, store);
    console.log(`${meta.logPrefix}: cleared all posts and rewrote ${meta.xmlFile}`);
  } finally {
    store.close();
  }
}

function maybePush(doPush) {
  if (!doPush) return;
  publishFeed();
  console.log("feeds: pushed xml to GitHub");
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
      const token = (args._[1] || "facebook").toLowerCase();
      let key = null;
      if (SOURCES.facebook.aliases.includes(token)) key = "facebook";
      else if (SOURCES.twitter.aliases.includes(token)) key = "twitter";
      if (!key) {
        console.error(`unknown login source: ${token} (use facebook or twitter)`);
        process.exit(2);
      }
      const cfg = loadConfig(args.config);
      await SCRAPERS[key](cfg).login();
      break;
    }
    case "fetch": {
      const cfg = loadConfig(args.config);
      const sources = resolveSourceKeys(args._[1], cfg);
      if (!sources) {
        console.error(`unknown fetch source: ${args._[1]} (use facebook, twitter, or all)`);
        process.exit(2);
      }
      const explicit = Boolean(args._[1] && args._[1] !== "all" && args._[1] !== "both");
      if (!explicit) requireAnyProfiles(cfg);
      for (const key of sources) {
        await fetchSource(cfg, key);
      }
      maybePush(args.push);
      break;
    }
    case "clean": {
      const cfg = loadConfig(args.config);
      const sources = resolveSourceKeys(args._[1] || "all", cfg);
      if (!sources) {
        console.error(`unknown clean source: ${args._[1]}`);
        process.exit(2);
      }
      for (const key of sources) {
        await cleanSource(cfg, key);
        // Ensure empty xml exists even when the source had no profiles yet.
        if (!cfg[key]?.profiles?.length) {
          writeEmptyFeed(cfg[key].feed, SOURCES[key].xmlFile);
        }
      }
      maybePush(args.push);
      break;
    }
    case "publish": {
      publishFeed();
      console.log("feeds: pushed xml to GitHub");
      break;
    }
    case "serve": {
      const cfg = loadConfig(args.config);
      const stores = {};
      if (cfg.facebook) stores.facebook = openStore(cfg.facebook.databasePath);
      if (cfg.twitter) stores.twitter = openStore(cfg.twitter.databasePath);
      await startServer(cfg, stores);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`feeds: ${err.stack || err.message || err}`);
  process.exit(1);
});
