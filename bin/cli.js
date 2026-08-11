#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { writeFileSync } from "node:fs";
import { loadConfig, requireAnyProfiles, requireProfiles } from "../lib/config.js";
import { openStore } from "../lib/store.js";
import { Scraper } from "../lib/scraper.js";
import { TwitterScraper } from "../lib/twitter-scraper.js";
import { buildFeed } from "../lib/rssfeed.js";
import { publishFeed } from "../lib/publish.js";
import { startServer } from "../lib/server.js";

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

function resolveSources(token, cfg) {
  const t = (token || "all").toLowerCase();
  if (t === "facebook" || t === "fb") return ["facebook"];
  if (t === "twitter" || t === "x") return ["twitter"];
  if (t === "all" || t === "both") {
    const out = [];
    if (cfg.facebook?.profiles?.length) out.push("facebook");
    if (cfg.twitter?.profiles?.length) out.push("twitter");
    // If neither configured yet, still allow explicit empty all for clean.
    return out.length ? out : ["facebook", "twitter"];
  }
  return null;
}

function writeFacebookFeed(cfg, store) {
  const posts = store.list(50);
  const body = buildFeed(cfg.facebook.feed, posts);
  writeFileSync("facebook.xml", body, "utf8");
  console.log("feeds: wrote facebook.xml");
}

function writeTwitterFeed(cfg, store) {
  const posts = store.list(50);
  const body = buildFeed(cfg.twitter.feed, posts);
  writeFileSync("twitter.xml", body, "utf8");
  console.log("feeds: wrote twitter.xml");
}

function writeEmptyFeed(feedCfg, path) {
  const body = buildFeed(feedCfg, []);
  writeFileSync(path, body, "utf8");
}

function facebookScraperConfig(cfg) {
  return {
    ...cfg,
    sessionPath: cfg.facebook.sessionPath,
    databasePath: cfg.facebook.databasePath,
    feed: cfg.facebook.feed,
    profiles: cfg.facebook.profiles,
  };
}

async function fetchFacebook(cfg) {
  requireProfiles(cfg, "facebook");
  const store = openStore(cfg.facebook.databasePath);
  try {
    const posts = await new Scraper(facebookScraperConfig(cfg)).fetchLatest();
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
    writeFacebookFeed(cfg, store);
  } finally {
    store.close();
  }
}

async function fetchTwitter(cfg) {
  requireProfiles(cfg, "twitter");
  const store = openStore(cfg.twitter.databasePath);
  try {
    const posts = await new TwitterScraper(cfg).fetchLatest();
    let added = 0;
    for (const p of posts) {
      const ok = store.upsert(p);
      if (ok) {
        added++;
        console.log(`twitter-rss: new: ${p.title} (${p.url})`);
      } else {
        console.log(`twitter-rss: updated/skipped: ${p.title} (${p.url})`);
      }
    }
    console.log(`twitter-rss: fetched ${posts.length} threads, ${added} new`);
    writeTwitterFeed(cfg, store);
  } finally {
    store.close();
  }
}

async function cleanSource(cfg, source) {
  if (source === "facebook") {
    const store = openStore(cfg.facebook.databasePath);
    try {
      store.clear();
      writeFacebookFeed(cfg, store);
      console.log("facebook-rss: cleared all posts and rewrote facebook.xml");
    } finally {
      store.close();
    }
    return;
  }
  if (source === "twitter") {
    const store = openStore(cfg.twitter.databasePath);
    try {
      store.clear();
      writeTwitterFeed(cfg, store);
      console.log("twitter-rss: cleared all posts and rewrote twitter.xml");
    } finally {
      store.close();
    }
  }
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
      const source = (args._[1] || "facebook").toLowerCase();
      const cfg = loadConfig(args.config);
      if (source === "twitter" || source === "x") {
        await new TwitterScraper(cfg).login();
      } else if (source === "facebook" || source === "fb") {
        await new Scraper(facebookScraperConfig(cfg)).login();
      } else {
        console.error(`unknown login source: ${source} (use facebook or twitter)`);
        process.exit(2);
      }
      break;
    }
    case "fetch": {
      const cfg = loadConfig(args.config);
      const sources = resolveSources(args._[1], cfg);
      if (!sources) {
        console.error(`unknown fetch source: ${args._[1]} (use facebook, twitter, or all)`);
        process.exit(2);
      }
      if (args._[1] && args._[1] !== "all") {
        // explicit source
      } else {
        requireAnyProfiles(cfg);
      }
      for (const source of sources) {
        if (source === "facebook") await fetchFacebook(cfg);
        else if (source === "twitter") await fetchTwitter(cfg);
      }
      if (args.push) {
        publishFeed();
        console.log("feeds: pushed xml to GitHub");
      }
      break;
    }
    case "clean": {
      const cfg = loadConfig(args.config);
      const sources = resolveSources(args._[1] || "all", cfg);
      if (!sources) {
        console.error(`unknown clean source: ${args._[1]}`);
        process.exit(2);
      }
      for (const source of sources) {
        await cleanSource(cfg, source);
      }
      // Ensure empty files exist even if a source had no DB yet.
      if (sources.includes("facebook") && !cfg.facebook?.profiles?.length) {
        writeEmptyFeed(cfg.facebook.feed, "facebook.xml");
      }
      if (sources.includes("twitter")) {
        // cleanSource already writes when DB opens; ensure file for empty config
      }
      if (args.push) {
        publishFeed();
        console.log("feeds: pushed xml to GitHub");
      }
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
