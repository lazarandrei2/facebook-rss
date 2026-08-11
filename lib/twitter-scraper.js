/**
 * X/Twitter profile scraper (Playwright).
 *
 * Takes a shared runtime config + twitter source block:
 *   new TwitterScraper({ headless, maxPosts, source: cfg.twitter })
 */

import { contentFingerprint } from "./store.js";
import { handleFromUrl } from "./config.js";
import {
  hashID,
  interactiveLogin,
  scrollHarvest,
  withSessionPage,
} from "./browser.js";
import { uniqueNonEmpty } from "./html.js";
import {
  groupAuthorThreads,
  normalizeHandle,
  selectAuthorConversation,
  threadPermalink,
  threadPublishedAt,
} from "./twitter-thread.js";
import {
  isBadTwitterImage,
  isBadTwitterVideo,
  isUsefulTweet,
  makeThreadTitle,
  renderThreadHTML,
} from "./twitter-media.js";

export class TwitterScraper {
  /**
   * @param {{ headless?: boolean, maxPosts?: number, source: object }} cfg
   */
  constructor(cfg) {
    this.headless = cfg.headless ?? true;
    this.source = cfg.source || cfg.twitter || cfg;
    this.maxPosts = cfg.maxPosts || this.source.maxPosts || 15;
    this.sessionPath = this.source.sessionPath || "session-twitter.json";
    this.profiles = this.source.profiles || [];
  }

  async login() {
    await interactiveLogin({
      loginUrl: "https://x.com/i/flow/login",
      sessionPath: this.sessionPath,
      prompt: [
        "twitter-rss: Log in to X/Twitter in the opened browser window.",
        "twitter-rss: When your home timeline is visible, return here and press Enter.",
      ],
    });
  }

  async fetchLatest() {
    return withSessionPage(
      {
        sessionPath: this.sessionPath,
        headless: this.headless,
        missingSessionError: `twitter session not found at ${this.sessionPath}; run: node bin/cli.js login twitter`,
      },
      async (page) => {
        const all = [];
        const seenContent = new Set();

        for (const profile of this.profiles) {
          let posts;
          try {
            posts = await this.#fetchProfile(page, profile);
          } catch (err) {
            console.warn(`twitter-rss: warn: ${profile.url}: ${err.message}`);
            continue;
          }
          for (const p of posts) {
            const key = p.contentKey || contentFingerprint(p.title, p.content);
            if (key && seenContent.has(key)) {
              console.log(`twitter-rss: skip duplicate content: ${p.url}`);
              continue;
            }
            if (key) seenContent.add(key);
            all.push(p);
          }
        }
        return all;
      },
    );
  }

  async #fetchProfile(page, profile) {
    const handle = normalizeHandle(profile.handle || handleFromUrl(profile.url));
    if (!handle) throw new Error("missing twitter handle");

    const statusUrls = await this.#collectStatusURLs(page, handle, profile.name);
    if (!statusUrls.length) {
      throw new Error("no tweets found (login expired, profile private, or DOM changed)");
    }

    const limit = this.maxPosts || 15;
    const selected = statusUrls.slice(0, Math.max(limit * 2, limit));
    console.log(`twitter-rss: ${profile.name}: opening ${selected.length} statuses`);

    /** @type {Map<string, import('./twitter-thread.js').Tweet>} */
    const tweetMap = new Map();

    for (const statusUrl of selected) {
      let chain;
      try {
        chain = await this.#fetchStatusThread(page, statusUrl, handle);
      } catch (err) {
        console.warn(`twitter-rss: warn: open ${statusUrl}: ${err.message}`);
        continue;
      }
      for (const t of chain) {
        if (!tweetMap.has(t.id)) tweetMap.set(t.id, t);
        else tweetMap.set(t.id, mergeTweet(tweetMap.get(t.id), t));
      }
    }

    const allTweets = [...tweetMap.values()];
    const groups = groupAuthorThreads(allTweets, handle);
    if (!groups.length) throw new Error("no author-involved threads after filtering");

    const ranked = groups
      .map((g) => ({
        ...g,
        publishedAt: threadPublishedAt(g.tweets, handle) || "",
      }))
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
      .slice(0, limit);

    const fetchedAt = new Date().toISOString();
    const posts = [];
    const seenContent = new Set();

    for (const group of ranked) {
      const filtered = group.tweets;
      if (!filtered.length) continue;

      const useful = filtered.some((t) => isUsefulTweet(t.text, t.images, t.videos));
      if (!useful) {
        console.warn(`twitter-rss: warn: skip empty thread ${group.rootId}`);
        continue;
      }

      const permalink = threadPermalink(filtered, handle) || statusUrlFromTweet(filtered.at(-1));
      const title = makeThreadTitle(filtered, handle, profile.name);
      const content = renderThreadHTML(filtered, handle, permalink);
      const contentKey = contentFingerprint(title, content);
      if (contentKey && seenContent.has(contentKey)) continue;
      if (contentKey) seenContent.add(contentKey);

      const leaf =
        [...filtered].reverse().find((t) => normalizeHandle(t.handle) === handle) ||
        filtered[filtered.length - 1];
      const publishedAt =
        threadPublishedAt(filtered, handle) ||
        snowflakeToIso(leaf?.id) ||
        snowflakeToIso(group.rootId) ||
        "";
      if (!publishedAt) {
        console.warn(`twitter-rss: warn: no post date for thread ${group.rootId}`);
      }

      const idKey = `tw:${group.rootId}:${leaf.id}`;

      posts.push({
        id: hashID(idKey),
        profileUrl: profile.url,
        profileName: profile.name.trim(),
        title,
        content,
        url: permalink,
        contentKey,
        publishedAt,
        fetchedAt,
      });
    }

    if (!posts.length) throw new Error("no usable twitter threads after filtering");
    return posts;
  }

  async #collectStatusURLs(page, handle, profileName) {
    const timelineUrl = `https://x.com/${handle}/with_replies`;
    await page.goto(timelineUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3500);

    const want = this.maxPosts || 15;
    const target = Math.max(want + 5, 20);
    const harvested = await scrollHarvest(page, {
      target,
      maxRounds: 20,
      waitMs: 1400,
      evaluate: async () => {
        const found = await page.evaluate(collectStatusUrlsJS, handle);
        return (found || []).map(normalizeStatusURL).filter(Boolean);
      },
    });

    console.log(
      `twitter-rss: ${profileName || handle}: discovered ${harvested.length} status urls`,
    );
    return harvested;
  }

  /**
   * Open a status page and extract the ancestor→focus chain involving the author.
   */
  async #fetchStatusThread(page, statusUrl, authorHandle) {
    await page.goto(statusUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      for (const el of document.querySelectorAll(
        'article[data-testid="tweet"] [data-testid="tweet-text-show-more-link"]',
      )) {
        try {
          el.click();
        } catch (_) {}
      }
    });
    await page.waitForTimeout(500);

    if (!page.url().includes("/status/")) {
      throw new Error(`navigated away from status page to ${page.url()}`);
    }

    const focusId = statusIdFromUrl(statusUrl);
    const raw = await page.evaluate(extractConversationJS, {
      authorHandle,
      focusId,
    });

    const tweets = (raw || []).map(normalizeExtractedTweet).filter(Boolean);
    // One pipeline: status order → select chain → link → author filter.
    return selectAuthorConversation(tweets, authorHandle, focusId);
  }
}

/** Collect status URLs belonging to the profile from the timeline DOM. */
function collectStatusUrlsJS(handle) {
  const out = [];
  const seen = new Set();
  const h = String(handle || "").toLowerCase().replace(/^@/, "");
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  for (const art of articles) {
    const links = Array.from(art.querySelectorAll('a[href*="/status/"]'));
    let statusHref = "";
    for (const a of links) {
      const href = a.href || "";
      const m = href.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/i);
      if (!m) continue;
      if (m[1].toLowerCase() !== h) continue;
      statusHref = `https://x.com/${m[1]}/status/${m[2]}`;
      if (a.querySelector("time")) break;
    }
    if (!statusHref) continue;
    if (seen.has(statusHref)) continue;
    seen.add(statusHref);
    out.push(statusHref);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Extract tweets visible in a status conversation.
 * Returns ancestors (above) and the focus tweet; includes immediate author
 * self-replies that appear as a continuous author chain under the focus.
 */
function extractConversationJS({ authorHandle, focusId }) {
  const author = String(authorHandle || "")
    .toLowerCase()
    .replace(/^@/, "");
  const focus = String(focusId || "");

  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const tweets = [];

  for (const art of articles) {
    const links = Array.from(art.querySelectorAll('a[href*="/status/"]'));
    let id = "";
    let handle = "";
    let url = "";
    for (const a of links) {
      const href = a.href || "";
      const m = href.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/i);
      if (!m) continue;
      handle = m[1];
      id = m[2];
      url = `https://x.com/${handle}/status/${id}`;
      if (a.querySelector("time")) break;
    }
    if (!id) continue;

    let name = "";
    const userName = art.querySelector('[data-testid="User-Name"]');
    if (userName) {
      const spans = Array.from(userName.querySelectorAll("span"))
        .map((s) => (s.innerText || "").trim())
        .filter(Boolean);
      name = spans[0] || "";
      if (!handle) {
        const at = spans.find((s) => s.startsWith("@"));
        if (at) handle = at.slice(1);
      }
    }

    const textEl = art.querySelector('[data-testid="tweetText"]');
    const text = textEl ? (textEl.innerText || "").trim() : "";

    let publishedAt = "";
    const timeEl = art.querySelector("time");
    if (timeEl?.dateTime) publishedAt = timeEl.dateTime;

    const images = [];
    const seenImg = new Set();
    for (const img of art.querySelectorAll('img[src*="twimg.com"]')) {
      const src = img.currentSrc || img.src || "";
      if (!src || seenImg.has(src)) continue;
      if (/profile_images|emoji/i.test(src)) continue;
      seenImg.add(src);
      const big = src.replace(/&name=\w+/i, "&name=large").replace(/\?format=\w+/i, (m) => m);
      images.push(big || src);
    }

    const videos = [];
    const seenVid = new Set();
    for (const video of art.querySelectorAll("video")) {
      const poster = video.getAttribute("poster") || "";
      const sources = [];
      if (video.currentSrc) sources.push(video.currentSrc);
      if (video.src) sources.push(video.src);
      for (const source of video.querySelectorAll("source[src]")) {
        sources.push(source.src || source.getAttribute("src") || "");
      }
      for (const src of sources) {
        if (!src || seenVid.has(src)) continue;
        if (!/\.mp4|video\.twimg\.com/i.test(src)) continue;
        seenVid.add(src);
        videos.push({ url: src, poster, type: "video/mp4" });
      }
    }

    tweets.push({
      id,
      handle,
      name,
      text,
      url,
      publishedAt,
      inReplyToId: null,
      images,
      videos,
      isReplyContext: false,
      isFocus: focus && id === focus,
      isAuthor: handle.toLowerCase() === author,
    });
  }

  return tweets;
}

function normalizeExtractedTweet(raw) {
  if (!raw?.id) return null;
  const images = (raw.images || []).filter((u) => !isBadTwitterImage(u));
  const videos = (raw.videos || [])
    .map((v) =>
      typeof v === "string"
        ? { url: v, poster: "", type: "video/mp4" }
        : {
            url: String(v.url || ""),
            poster: String(v.poster || ""),
            type: String(v.type || "video/mp4"),
          },
    )
    .filter((v) => v.url && !isBadTwitterVideo(v.url));

  return {
    id: String(raw.id),
    handle: normalizeHandle(raw.handle),
    name: String(raw.name || "").trim(),
    text: String(raw.text || "").trim(),
    url: normalizeStatusURL(raw.url) || `https://x.com/${normalizeHandle(raw.handle)}/status/${raw.id}`,
    publishedAt: normalizeIso(raw.publishedAt) || snowflakeToIso(raw.id),
    inReplyToId: raw.inReplyToId ? String(raw.inReplyToId) : null,
    images,
    videos,
  };
}

function mergeTweet(a, b) {
  return {
    ...a,
    ...b,
    text: (b.text && b.text.length >= (a.text || "").length ? b.text : a.text) || "",
    name: a.name || b.name,
    publishedAt: a.publishedAt || b.publishedAt,
    inReplyToId: a.inReplyToId || b.inReplyToId || null,
    images: uniqueNonEmpty([...(a.images || []), ...(b.images || [])]),
    videos: [...(a.videos || []), ...(b.videos || [])].filter(
      (v, i, arr) => arr.findIndex((x) => x.url === v.url) === i,
    ),
  };
}

export function normalizeStatusURL(raw) {
  raw = String(raw || "").trim();
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw, "https://x.com");
  } catch {
    return "";
  }
  const host = String(u.hostname || "").toLowerCase();
  const okHost =
    !host ||
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com");
  if (!okHost) return "";
  const m = u.pathname.match(/\/([^\/]+)\/status\/(\d+)/);
  if (!m) return "";
  return `https://x.com/${m[1]}/status/${m[2]}`;
}

export function statusIdFromUrl(raw) {
  const u = normalizeStatusURL(raw);
  const m = u.match(/\/status\/(\d+)/);
  return m ? m[1] : "";
}

function statusUrlFromTweet(t) {
  if (!t) return "";
  return t.url || (t.handle && t.id ? `https://x.com/${t.handle}/status/${t.id}` : "");
}

function normalizeIso(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** Twitter/X snowflake → ISO (ms since Twitter epoch). */
export function snowflakeToIso(id) {
  const s = String(id || "").trim();
  if (!/^\d{5,22}$/.test(s)) return "";
  try {
    const ms = Number((BigInt(s) >> 22n) + 1288834974657n);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  } catch {
    return "";
  }
}