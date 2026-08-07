import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const defaults = {
  listen: ":8080",
  headless: true,
  session_path: "session.json",
  database_path: "data/posts.db",
  max_posts: 15,
  feed: {
    title: "Facebook RSS",
    link: "http://localhost:8080/feed.xml",
    description: "Latest posts from watched Facebook profiles",
  },
  profiles: [],
};

export function loadConfig(path = "config.yaml") {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`read config: ${err.message}`);
  }

  let parsed;
  try {
    parsed = yaml.load(raw) || {};
  } catch (err) {
    throw new Error(`parse config: ${err.message}`);
  }

  const cfg = {
    listen: parsed.listen ?? defaults.listen,
    headless: parsed.headless ?? defaults.headless,
    sessionPath: parsed.session_path ?? defaults.session_path,
    databasePath: parsed.database_path ?? defaults.database_path,
    maxPosts: parsed.max_posts ?? defaults.max_posts,
    feed: {
      title: parsed.feed?.title ?? defaults.feed.title,
      link: parsed.feed?.link ?? defaults.feed.link,
      description: parsed.feed?.description ?? defaults.feed.description,
    },
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
  };

  if (!cfg.maxPosts || cfg.maxPosts <= 0) cfg.maxPosts = 15;

  cfg.profiles = cfg.profiles.map((p, i) => {
    if (!p?.url) throw new Error(`config: profiles[${i}].url is required`);
    return {
      name: (p.name || p.url).trim(),
      url: String(p.url).trim(),
    };
  });

  return cfg;
}

export function requireProfiles(cfg) {
  if (!cfg.profiles.length) {
    throw new Error("config: at least one profile is required");
  }
}
