import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { contentFingerprint } from "./store.js";
import { handleFromUrl } from "./config.js";
import {
  buildAuthorThread,
  groupAuthorThreads,
  linkReplyChain,
  normalizeHandle,
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

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export class TwitterScraper {
  /** @param {object} cfg full app config or twitter source + headless/maxPosts */
  constructor(cfg) {
    this.cfg = cfg;
    this.twitter = cfg.twitter || cfg;
    this.headless = cfg.headless ?? true;
    this.maxPosts = cfg.maxPosts || this.twitter.maxPosts || 15;
    this.sessionPath = this.twitter.sessionPath || cfg.sessionPath || "session-twitter.json";
    this.profiles = this.twitter.profiles || cfg.profiles || [];
  }

  async login() {
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({
        locale: "en-US",
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      await page.goto("https://x.com/i/flow/login", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      console.log("twitter-rss: Log in to X/Twitter in the opened browser window.");
      console.log("twitter-rss: When your home timeline is visible, return here and press Enter.");
      await waitForEnter();

      await context.storageState({ path: this.sessionPath });
      console.log(`twitter-rss: Session saved to ${this.sessionPath}`);
      await context.close();
    } finally {
      await browser.close();
    }
  }

  async fetchLatest() {
    if (!existsSync(this.sessionPath)) {
      throw new Error(
        `twitter session not found at ${this.sessionPath}; run: node bin/cli.js login twitter`,
      );
    }

    const browser = await chromium.launch({ headless: this.headless });
    try {
      const context = await browser.newContext({
        storageState: this.sessionPath,
        locale: "en-US",
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();

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

      await context.close();
      return all;
    } finally {
      await browser.close();
    }
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
        else {
          // Prefer richer copy.
          const prev = tweetMap.get(t.id);
          tweetMap.set(t.id, mergeTweet(prev, t));
        }
      }
    }

    const allTweets = [...tweetMap.values()];
    const groups = groupAuthorThreads(allTweets, handle);
    if (!groups.length) throw new Error("no author-involved threads after filtering");

    // Prefer newest author activity first; cap at maxPosts threads.
    const ranked = groups
      .map((g) => ({
        ...g,
        publishedAt: threadPublishedAt(g.tweets, handle) || "",
      }))
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
      .slice(0, limit);

    const now = Date.now();
    const posts = [];
    const seenContent = new Set();

    for (let i = 0; i < ranked.length; i++) {
      const thread = ranked[i].tweets;
      const filtered = buildAuthorThread(thread, handle);
      if (!filtered.length) continue;

      const useful = filtered.some((t) => isUsefulTweet(t.text, t.images, t.videos));
      if (!useful) {
        console.warn(`twitter-rss: warn: skip empty thread ${ranked[i].rootId}`);
        continue;
      }

      const permalink = threadPermalink(filtered, handle) || statusUrlFromTweet(filtered.at(-1));
      const title = makeThreadTitle(filtered, handle, profile.name);
      const content = renderThreadHTML(filtered, handle, permalink);
      const contentKey = contentFingerprint(title, content);
      if (contentKey && seenContent.has(contentKey)) continue;
      if (contentKey) seenContent.add(contentKey);

      const publishedAt =
        threadPublishedAt(filtered, handle) ||
        new Date(now - i * 60_000).toISOString();

      // Stable id: conversation root + author leaf so reply-context updates refresh.
      const leaf =
        [...filtered].reverse().find((t) => normalizeHandle(t.handle) === handle) ||
        filtered[filtered.length - 1];
      const idKey = `tw:${ranked[i].rootId}:${leaf.id}`;

      posts.push({
        id: hashID(idKey),
        profileUrl: profile.url,
        profileName: profile.name.trim(),
        title,
        content,
        url: permalink,
        contentKey,
        publishedAt,
        fetchedAt: new Date(now).toISOString(),
      });
    }

    if (!posts.length) throw new Error("no usable twitter threads after filtering");
    return posts;
  }

  async #collectStatusURLs(page, handle, profileName) {
    // with_replies includes posts the author made as replies to others.
    const timelineUrl = `https://x.com/${handle}/with_replies`;
    await page.goto(timelineUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3500);

    const want = this.maxPosts || 15;
    const target = Math.max(want + 5, 20);
    const ordered = [];
    const seen = new Set();
    let stagnant = 0;

    const harvest = async () => {
      const found = await page.evaluate(collectStatusUrlsJS, handle);
      for (const u of found || []) {
        const permalink = normalizeStatusURL(u);
        if (!permalink || seen.has(permalink)) continue;
        seen.add(permalink);
        ordered.push(permalink);
      }
    };

    await harvest();
    for (let i = 0; i < 20 && ordered.length < target; i++) {
      const before = ordered.length;
      await page.mouse.wheel(0, 3200);
      await page.waitForTimeout(1400);
      await harvest();
      if (ordered.length === before) stagnant++;
      else stagnant = 0;
      if (stagnant >= 4) break;
    }

    console.log(
      `twitter-rss: ${profileName || handle}: discovered ${ordered.length} status urls`,
    );
    return ordered;
  }

  /**
   * Open a status page and extract the ancestor→focus chain involving the author.
   * Does not pull unrelated sibling replies.
   */
  async #fetchStatusThread(page, statusUrl, authorHandle) {
    await page.goto(statusUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    // Expand truncated text.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-testid="tweet-text-show-more-link"], span')) {
        const t = (el.innerText || "").trim().toLowerCase();
        if (t === "show more" || t === "show more…") {
          try {
            el.click();
          } catch (_) {}
        }
      }
    });
    await page.waitForTimeout(500);

    const focusId = statusIdFromUrl(statusUrl);
    const raw = await page.evaluate(extractConversationJS, {
      authorHandle,
      focusId,
    });

    let tweets = (raw || [])
      .map(normalizeExtractedTweet)
      .filter(Boolean);

    // Only keep the focused conversation column: ancestors + focus (+ author self-replies directly under).
    tweets = selectAuthorConversation(tweets, authorHandle, focusId);
    tweets = linkReplyChain(tweets);

    return tweets;
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
      // Prefer the timestamp permalink (often contains /status/ and time child).
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
      // Prefer larger variants.
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

    // Social context: "Replying to @foo" — useful but parent id comes from chain order.
    let inReplyToId = null;
    const social = art.querySelector('[data-testid="socialContext"]');
    const socialText = social ? (social.innerText || "").toLowerCase() : "";
    const isReplyContext = /replying to/.test(socialText);

    tweets.push({
      id,
      handle,
      name,
      text,
      url,
      publishedAt,
      inReplyToId,
      images,
      videos,
      isReplyContext,
      isFocus: focus && id === focus,
      isAuthor: handle.toLowerCase() === author,
    });
  }

  return tweets;
}

/**
 * From a status page extraction, keep:
 * - the focus tweet
 * - all tweets above it (ancestors shown by X)
 * - continuous author self-replies immediately below the focus
 * Then filter with buildAuthorThread semantics via selectAuthorConversation.
 */
export function selectAuthorConversation(tweets, authorHandle, focusId) {
  const list = Array.isArray(tweets) ? tweets : [];
  if (!list.length) return [];

  const author = normalizeHandle(authorHandle);
  const focus = String(focusId || "");
  let focusIdx = list.findIndex((t) => t.id === focus);
  if (focusIdx < 0) {
    // Fall back to first author tweet, else last tweet.
    focusIdx = list.findIndex((t) => normalizeHandle(t.handle) === author);
    if (focusIdx < 0) focusIdx = Math.max(0, list.length - 1);
  }

  // Ancestors + focus.
  const chain = list.slice(0, focusIdx + 1).map((t) => ({ ...t }));

  // Extend with contiguous author self-replies directly under the focus.
  for (let i = focusIdx + 1; i < list.length; i++) {
    if (normalizeHandle(list[i].handle) !== author) break;
    chain.push({ ...list[i] });
  }

  const linked = linkReplyChain(chain);
  const filtered = buildAuthorThread(linked, author);
  if (filtered.length) return filtered;

  // Fallback: keep author tweets and anything they directly reply to.
  return linked.filter(
    (t) =>
      normalizeHandle(t.handle) === author ||
      linked.some(
        (a) => normalizeHandle(a.handle) === author && a.inReplyToId === t.id,
      ),
  );
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
    publishedAt: normalizeIso(raw.publishedAt),
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
    images: uniqueStrings([...(a.images || []), ...(b.images || [])]),
    videos: [...(a.videos || []), ...(b.videos || [])].filter(
      (v, i, arr) => arr.findIndex((x) => x.url === v.url) === i,
    ),
  };
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    const v = String(s || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
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
  const okHost = !host || host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
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

function hashID(u) {
  return createHash("sha1").update(String(u)).digest("hex");
}

function waitForEnter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}
