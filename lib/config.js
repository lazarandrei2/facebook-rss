import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const defaultFacebookFeed = {
  title: "Facebook",
  link: "http://localhost:8080/facebook.xml",
  description: "Latest posts from watched Facebook profiles",
};

const defaultTwitterFeed = {
  title: "Twitter / X",
  link: "http://localhost:8080/twitter.xml",
  description: "Latest posts and author-involved threads from watched X profiles",
};

/**
 * Normalize a source block (facebook or twitter) with defaults.
 * @param {object|undefined} raw
 * @param {object} defaults
 */
function normalizeSource(raw, defaults) {
  const src = raw && typeof raw === "object" ? raw : {};
  const profiles = Array.isArray(src.profiles) ? src.profiles : defaults.profiles || [];
  return {
    sessionPath: src.session_path ?? src.sessionPath ?? defaults.sessionPath,
    databasePath: src.database_path ?? src.databasePath ?? defaults.databasePath,
    feed: {
      title: src.feed?.title ?? defaults.feed.title,
      link: src.feed?.link ?? defaults.feed.link,
      description: src.feed?.description ?? defaults.feed.description,
    },
    profiles: profiles.map((p, i) => {
      if (!p?.url && !p?.handle) {
        throw new Error(`config: ${defaults.key}.profiles[${i}] needs url or handle`);
      }
      const url = String(p.url || `https://x.com/${String(p.handle).replace(/^@/, "")}`).trim();
      return {
        name: String(p.name || p.handle || url).trim(),
        url,
        handle: p.handle ? String(p.handle).replace(/^@/, "").trim() : "",
      };
    }),
  };
}

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

  const maxPosts = parsed.max_posts ?? 15;
  const headless = parsed.headless ?? true;
  const listen = parsed.listen ?? ":8080";

  // Legacy flat config (profiles / session_path / feed at top level) → Facebook.
  const legacyProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : null;
  const facebookRaw = parsed.facebook || {};
  if (legacyProfiles && !parsed.facebook) {
    facebookRaw.profiles = legacyProfiles;
    if (parsed.session_path) facebookRaw.session_path = parsed.session_path;
    if (parsed.database_path) facebookRaw.database_path = parsed.database_path;
    if (parsed.feed) facebookRaw.feed = parsed.feed;
  } else if (legacyProfiles && parsed.facebook && !facebookRaw.profiles) {
    facebookRaw.profiles = legacyProfiles;
  }

  // Legacy feed.link pointing at feed.xml → prefer facebook.xml in defaults only;
  // explicit config values are preserved as-is.
  const facebook = normalizeSource(facebookRaw, {
    key: "facebook",
    sessionPath: "session-facebook.json",
    databasePath: "data/facebook.db",
    feed: defaultFacebookFeed,
    profiles: [],
  });

  // If someone still uses session.json at top level without facebook.session_path
  if (!parsed.facebook?.session_path && !facebookRaw.session_path && parsed.session_path) {
    facebook.sessionPath = parsed.session_path;
  }
  if (!parsed.facebook?.database_path && !facebookRaw.database_path && parsed.database_path) {
    facebook.databasePath = parsed.database_path;
  }

  const twitter = normalizeSource(parsed.twitter || {}, {
    key: "twitter",
    sessionPath: "session-twitter.json",
    databasePath: "data/twitter.db",
    feed: defaultTwitterFeed,
    profiles: [],
  });

  // Derive twitter handles from profile URLs when missing.
  twitter.profiles = twitter.profiles.map((p) => ({
    ...p,
    handle: p.handle || handleFromUrl(p.url),
  }));

  const cfg = {
    listen,
    headless,
    maxPosts: maxPosts > 0 ? maxPosts : 15,
    facebook,
    twitter,
    // Convenience aliases used by the existing Facebook scraper.
    sessionPath: facebook.sessionPath,
    databasePath: facebook.databasePath,
    feed: facebook.feed,
    profiles: facebook.profiles,
  };

  return cfg;
}

export function requireProfiles(cfg, source = "facebook") {
  const src = source === "twitter" ? cfg.twitter : cfg.facebook;
  if (!src?.profiles?.length) {
    throw new Error(`config: at least one ${source} profile is required`);
  }
}

export function requireAnyProfiles(cfg) {
  const hasFb = cfg.facebook?.profiles?.length > 0;
  const hasTw = cfg.twitter?.profiles?.length > 0;
  if (!hasFb && !hasTw) {
    throw new Error("config: at least one facebook or twitter profile is required");
  }
}

/** @param {string} raw */
export function handleFromUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^(www\.)?(x|twitter)\.com$/i.test(u.hostname)) return "";
    const part = u.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
    if (!part || /^(home|explore|search|i|settings|intent)$/i.test(part)) return "";
    return part.replace(/^@/, "");
  } catch {
    return String(raw || "")
      .replace(/^@/, "")
      .trim();
  }
}
