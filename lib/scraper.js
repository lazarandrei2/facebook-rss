import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { contentFingerprint } from "./store.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export class Scraper {
  /** @param {object} cfg */
  constructor(cfg) {
    this.cfg = cfg;
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
      await page.goto("https://www.facebook.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      console.log("facebook-rss: Log in to Facebook in the opened browser window.");
      console.log("facebook-rss: When your news feed is visible, return here and press Enter.");
      await waitForEnter();

      await context.storageState({ path: this.cfg.sessionPath });
      console.log(`facebook-rss: Session saved to ${this.cfg.sessionPath}`);
      await context.close();
    } finally {
      await browser.close();
    }
  }

  async fetchLatest() {
    if (!existsSync(this.cfg.sessionPath)) {
      throw new Error(
        `session not found at ${this.cfg.sessionPath}; run: node bin/cli.js login`,
      );
    }

    const browser = await chromium.launch({ headless: this.cfg.headless });
    try {
      const context = await browser.newContext({
        storageState: this.cfg.sessionPath,
        locale: "en-US",
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();

      const all = [];
      const seenContent = new Set();

      for (const profile of this.cfg.profiles) {
        let posts;
        try {
          posts = await this.#fetchProfile(page, profile);
        } catch (err) {
          console.warn(`facebook-rss: warn: ${profile.url}: ${err.message}`);
          continue;
        }
        for (const p of posts) {
          const key = p.contentKey || contentFingerprint(p.title, p.content);
          if (key && seenContent.has(key)) {
            console.log(`facebook-rss: skip duplicate content: ${p.url}`);
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
    const urls = await this.#collectPostURLs(page, profile);
    if (!urls.length) {
      throw new Error("no posts found (login expired, profile private, or DOM changed)");
    }

    let limit = this.cfg.maxPosts || 15;
    const selected = urls.slice(0, limit);
    console.log(`facebook-rss: ${profile.name}: opening ${selected.length} posts`);

    const now = Date.now();
    const posts = [];
    const seenURL = new Set();
    const seenIDs = new Set();
    const seenContent = new Set();

    for (let i = 0; i < selected.length; i++) {
      const permalink = normalizePostURL(selected[i]);
      if (!permalink || seenURL.has(permalink)) continue;
      seenURL.add(permalink);

      const postKey = postIdentity(permalink);
      if (postKey && seenIDs.has(postKey)) {
        console.log(`facebook-rss: skip duplicate id ${postKey}: ${permalink}`);
        continue;
      }

      let full;
      try {
        full = await this.#fetchPostPage(page, permalink, profile);
      } catch (err) {
        console.warn(`facebook-rss: warn: open post ${permalink}: ${err.message}`);
        continue;
      }

      const text = cleanText(full.text);
      const images = uniqueNonEmpty(full.images);
      if (!isUsefulPost(text, images, permalink, profile.name)) {
        console.warn(`facebook-rss: warn: skip thin post ${permalink}`);
        continue;
      }

      const title = makeTitle(text, profile.name);
      const content = renderHTML(text, images, permalink);
      const contentKey = contentFingerprint(title, content);
      if (contentKey && seenContent.has(contentKey)) {
        console.log(`facebook-rss: skip duplicate content: ${permalink}`);
        continue;
      }
      if (contentKey) seenContent.add(contentKey);
      if (postKey) seenIDs.add(postKey);

      const publishedAt =
        parsePublishedAt(full.publishedAt) ||
        new Date(now - i * 60_000).toISOString();

      posts.push({
        id: hashID(postKey || permalink),
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

    if (!posts.length) throw new Error("no usable posts after filtering");
    return posts;
  }

  async #collectPostURLs(page, profile) {
    const slug = profileSlug(profile.url);
    await page.goto(profile.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const tabs = Array.from(
        document.querySelectorAll('a[role="tab"], div[role="tab"], span, a'),
      );
      for (const el of tabs) {
        const t = (el.innerText || "").trim().toLowerCase();
        if (t === "posts" || t === "postări") {
          try {
            el.click();
          } catch (_) {}
          break;
        }
      }
    });
    await page.waitForTimeout(2000);

    const want = this.cfg.maxPosts || 15;
    const target = Math.max(want + 5, 20);
    const ordered = [];
    const seen = new Set();
    let stagnant = 0;

    const harvest = async () => {
      const found = await page.evaluate(collectPostURLsJS, slug);
      for (const u of found || []) {
        const permalink = normalizePostURL(u);
        if (!permalink || seen.has(permalink)) continue;
        if (!belongsToProfile(permalink, slug)) continue;
        seen.add(permalink);
        ordered.push(permalink);
      }
    };

    await harvest();
    for (let i = 0; i < 25 && ordered.length < target; i++) {
      const before = ordered.length;
      await page.mouse.wheel(0, 3200);
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('div[role="button"], a, span')) {
          const t = (el.innerText || "").trim().toLowerCase();
          if (
            t === "see more" ||
            t === "vezi mai mult" ||
            t.includes("more posts") ||
            t.includes("mai multe")
          ) {
            try {
              el.click();
            } catch (_) {}
          }
        }
      });
      await harvest();
      if (ordered.length === before) stagnant++;
      else stagnant = 0;
      if (stagnant >= 4) break;
    }

    console.log(`facebook-rss: ${profile.name}: discovered ${ordered.length} post urls`);
    return ordered;
  }

  async #fetchPostPage(page, permalink, profile) {
    await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"], span'));
      for (const el of buttons) {
        const t = (el.innerText || "").trim().toLowerCase();
        if (t === "see more" || t === "vezi mai mult" || t === "see more…") {
          try {
            el.click();
          } catch (_) {}
        }
      }
    });
    await page.waitForTimeout(800);

    const result = await page.evaluate(extractPostPageJS, profile.name);
    return {
      url: permalink,
      text: result?.text || "",
      images: Array.isArray(result?.images) ? result.images.filter(Boolean) : [],
      publishedAt: result?.publishedAt || "",
    };
  }
}

/** Collect only real profile-owned anchors (no invented pfbid URLs). */
function collectPostURLsJS(slug) {
  const out = [];
  const seen = new Set();
  const slugLower = String(slug || "").toLowerCase();
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  for (const a of anchors) {
    let href = a.href || "";
    if (!/facebook\.com\//.test(href)) continue;
    try {
      href = href.split("#")[0];
    } catch (_) {}

    let path = "";
    const mPost = href.match(
      /facebook\.com\/([^\/?#]+)\/(?:posts|videos|permalink)\/(pfbid[A-Za-z0-9]+|\d+)/i,
    );
    const mReel = href.match(/facebook\.com\/reel\/(\d+)/i);

    if (mPost) {
      const owner = mPost[1].toLowerCase();
      if (owner !== slugLower) continue;
      path = `/${mPost[1]}/posts/${mPost[2]}`;
    } else if (mReel) {
      const article =
        a.closest('div[role="article"]') || a.closest("[data-pagelet]") || a.parentElement;
      const html = (article && article.innerHTML) || "";
      if (
        !new RegExp(`facebook\\.com\\/${slugLower}(\\/|"|\\?|#)`, "i").test(html) &&
        !new RegExp(`/${slugLower}(\\/|"|\\?|#)`, "i").test(html)
      ) {
        continue;
      }
      path = `/reel/${mReel[1]}`;
    } else {
      continue;
    }

    const canonical = `https://www.facebook.com${path}`.replace(/\/$/, "");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Extract text + images for the opened permalink only.
 * Images are scoped to this post's pfbid/reel id first so photos don't leak across posts.
 */
function extractPostPageJS(profileName) {
  const decode = (raw) =>
    raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
      .trim();

  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const author = norm(String(profileName || ""));

  const titleRaw = (document.title || "")
    .replace(/\s*\|\s*Facebook\s*$/i, "")
    .replace(/^\(\d+\)\s*/, "")
    .trim();

  let titleTeaser = titleRaw;
  const dash = titleRaw.indexOf(" - ");
  if (dash >= 0) {
    const left = titleRaw.slice(0, dash).trim();
    const right = titleRaw.slice(dash + 3).trim();
    if (author && norm(left) === author) titleTeaser = right;
    else if (author && norm(right) === author) titleTeaser = left;
    else if (right.length >= left.length) titleTeaser = right;
    else titleTeaser = left;
  }
  titleTeaser = titleTeaser.replace(/\.\.\.$/, "").trim();
  if (author && norm(titleTeaser) === author) titleTeaser = "";

  const html = document.documentElement.innerHTML;
  const pfbid =
    (location.pathname.match(/pfbid[A-Za-z0-9]+/) || [])[0] ||
    (location.pathname.match(/\/reel\/(\d+)/) || [])[1] ||
    "";

  const texts = [];
  const re = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = decode(match[1]);
    if (raw.length < 12) continue;
    if (/Meta AI|Privacy Policy|Remember password|By using Meta AI|Log into Facebook/i.test(raw)) {
      continue;
    }
    if (author && norm(raw) === author) continue;
    texts.push({ text: raw, index: match.index });
  }

  const teaser = norm(titleTeaser).slice(0, 48);
  let text = "";

  // 1) Messages that match the document title teaser.
  if (teaser.length >= 12) {
    const matched = texts
      .map((t) => t.text)
      .filter((t) => {
        const n = norm(t);
        return n.includes(teaser) || teaser.includes(n.slice(0, Math.min(40, teaser.length)));
      })
      .sort((a, b) => b.length - a.length);
    if (matched[0]) text = matched[0];
  }

  // 2) Messages near this post's id in the HTML payload.
  if (!text && pfbid) {
    const idx = html.indexOf(pfbid);
    if (idx >= 0) {
      const local = texts
        .filter((t) => Math.abs(t.index - idx) < 40000)
        .map((t) => t.text)
        .sort((a, b) => b.length - a.length);
      if (local[0] && local[0].length >= 20) text = local[0];
    }
  }

  // 3) Visible story text in the main article for this post.
  if (!text) {
    const article = findPostArticle(pfbid);
    const nodes = Array.from(
      (article || document).querySelectorAll(
        'div[data-ad-preview="message"], div[dir="auto"]',
      ),
    );
    const domTexts = nodes
      .map((el) => (el.innerText || "").replace(/\s*See more\s*$/i, "").trim())
      .filter((t) => t.length >= 40 && !(author && norm(t) === author));
    if (teaser.length >= 12) {
      const hit = domTexts
        .filter(
          (t) =>
            norm(t).includes(teaser) ||
            teaser.includes(norm(t).slice(0, Math.min(40, teaser.length))),
        )
        .sort((a, b) => b.length - a.length);
      if (hit[0]) text = hit[0];
    }
    if (!text && domTexts[0]) {
      domTexts.sort((a, b) => b.length - a.length);
      if (teaser.length < 12 || norm(domTexts[0]).includes(teaser.slice(0, 20))) {
        text = domTexts[0];
      }
    }
  }

  // 4) Longest JSON message that agrees with teaser; else teaser alone.
  if (!text) {
    const uniq = [];
    const seen = new Set();
    for (const t of texts) {
      const key = t.text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(t.text);
    }
    uniq.sort((a, b) => b.length - a.length);
    if (uniq[0] && (teaser.length < 12 || norm(uniq[0]).includes(teaser.slice(0, 20)))) {
      text = uniq[0];
    } else {
      text = titleTeaser || "";
    }
  }

  const isBadImage = (src) => {
    if (!src || src.startsWith("data:")) return true;
    if (!/scontent|fbcdn/.test(src)) return true;
    if (/emoji|static\.xx|rsrc\.php|t1\.30497-1|\/t39\.30808-1\//.test(src)) return true;
    // Profile / avatar sized CDN thumbs.
    if (/ctp=s(32|40|50|64|80|100|120)x/.test(src)) return true;
    if (/_[sn]\.|\/s\d+x\d+\//.test(src) && !/\/s\d{3,}x\d{3,}\//.test(src)) return true;
    return false;
  };

  const images = [];
  const seenImg = new Set();
  const pushImg = (src) => {
    if (!src || isBadImage(src) || seenImg.has(src)) return;
    // Strip size/query noise for dedupe while keeping original URL.
    const key = src.replace(/[?&](stp|oh|oe|_[a-z]+)=[^&]*/gi, "").split("&")[0];
    if (seenImg.has(key)) return;
    seenImg.add(src);
    seenImg.add(key);
    images.push(src);
  };

  // --- Images: bind to this post id first, never scoop the whole page. ---

  // 1) JSON photo URIs in a window around this post's pfbid/reel id.
  if (pfbid) {
    const idx = html.indexOf(pfbid);
    const windowHtml =
      idx >= 0 ? html.slice(Math.max(0, idx - 25000), idx + 50000) : "";
    if (windowHtml) {
      const uriRe =
        /"(?:uri|url|image_uri|photo_image|preview_image)"\s*:\s*"(https:\\\/\\\/[^"]+scontent[^"]+)"/g;
      let um;
      while ((um = uriRe.exec(windowHtml)) !== null) {
        const src = um[1].replace(/\\\//g, "/").replace(/\\u0025/g, "%");
        pushImg(src);
        if (images.length >= 4) break;
      }
    }
  }

  // 2) Large DOM images only inside the article that belongs to this post.
  if (images.length < 4) {
    const article = findPostArticle(pfbid);
    if (article) {
      const ranked = Array.from(article.querySelectorAll("img"))
        .map((img) => {
          const src = img.currentSrc || img.src || "";
          const w = Number(img.naturalWidth || img.width || 0);
          const h = Number(img.naturalHeight || img.height || 0);
          return { src, w, h, area: w * h };
        })
        .filter((x) => !isBadImage(x.src) && x.w >= 240 && x.h >= 240)
        .sort((a, b) => b.area - a.area);
      for (const x of ranked) {
        pushImg(x.src);
        if (images.length >= 4) break;
      }
    }
  }

  // 3) og:image only as a last resort (can be wrong on multi-story pages).
  if (!images.length) {
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) pushImg(og.content);
  }

  const publishedAt = extractPublishedAt(pfbid, html);

  return { text, images: images.slice(0, 4), titleTeaser, publishedAt };

  function extractPublishedAt(id, pageHtml) {
    const toIso = (value) => {
      if (value == null || value === "") return "";
      if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
      }
      const s = String(value).trim();
      if (/^\d{9,13}$/.test(s)) {
        const n = Number(s);
        const ms = n < 1e12 ? n * 1000 : n;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
      }
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
      return "";
    };

    // Prefer timestamps near this post id in the page payload.
    const idx = id ? pageHtml.indexOf(id) : -1;
    const windowHtml =
      idx >= 0 ? pageHtml.slice(Math.max(0, idx - 30000), idx + 60000) : pageHtml;

    const timeRes = [
      /"creation_time"\s*:\s*(\d{9,13})/,
      /"created_time"\s*:\s*(\d{9,13})/,
      /"publish_time"\s*:\s*(\d{9,13})/,
      /"published_time"\s*:\s*(\d{9,13})/,
      /"creation_time"\s*:\s*"(\d{9,13})"/,
      /"created_time"\s*:\s*"([^"]+)"/,
      /"publish_time"\s*:\s*"([^"]+)"/,
    ];
    for (const re of timeRes) {
      const m = windowHtml.match(re);
      if (m) {
        const iso = toIso(m[1]);
        if (iso) return iso;
      }
    }

    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[property="og:published_time"]',
      'meta[name="publish_date"]',
      'meta[property="og:updated_time"]',
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      if (el?.content) {
        const iso = toIso(el.content);
        if (iso) return iso;
      }
    }

    const article = findPostArticle(id);
    const scope = article || document;
    const utime = scope.querySelector("abbr[data-utime], span[data-utime], time[data-utime]");
    if (utime) {
      const iso = toIso(utime.getAttribute("data-utime"));
      if (iso) return iso;
    }
    const timeEl = scope.querySelector("time[datetime]");
    if (timeEl?.dateTime || timeEl?.getAttribute("datetime")) {
      const iso = toIso(timeEl.dateTime || timeEl.getAttribute("datetime"));
      if (iso) return iso;
    }

    // Permalink timestamp links often expose a full date via aria-label / title.
    const anchors = Array.from(scope.querySelectorAll("a[href*='/posts/'], a[href*='story_fbid'], a[role='link']"));
    for (const a of anchors) {
      const label = a.getAttribute("aria-label") || a.getAttribute("title") || "";
      if (!label) continue;
      // e.g. "August 7 at 10:30 PM" / "7 August 2026" / "Yesterday at 5:00 PM"
      if (/\d/.test(label) && /(am|pm|at|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|202\d)/i.test(label)) {
        const iso = toIso(label.replace(/\bat\b/i, " "));
        if (iso) return iso;
      }
    }

    return "";
  }

  function findPostArticle(id) {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    if (!articles.length) return null;
    if (!id) return articles[0];
    const needle = String(id);
    for (const art of articles) {
      const html = art.innerHTML || "";
      if (html.includes(needle)) return art;
      const links = art.querySelectorAll("a[href]");
      for (const a of links) {
        if ((a.href || "").includes(needle)) return art;
      }
    }
    // Permalink pages usually have one primary story article.
    return articles[0];
  }
}

/** Normalize FB timestamps (unix seconds/ms or date string) to ISO-8601 UTC. */
export function parsePublishedAt(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const s = String(raw).trim();
  if (!s) return "";
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return "";
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

function profileSlug(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return "profile.php";
    return path.split("/")[0];
  } catch {
    return String(raw).replace(/^\/+|\/+$/g, "");
  }
}

function belongsToProfile(permalink, slug) {
  try {
    const u = new URL(permalink);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!parts[0]) return false;
    if (parts[0] === "reel") return true;
    return parts[0].toLowerCase() === String(slug).toLowerCase();
  } catch {
    return false;
  }
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/^unread\s*/i, "")
    .replace(/[\u200b\u200c\u200d\ufeff\u2060]/g, "")
    .trim();
}

function normalizePostURL(raw) {
  raw = String(raw || "").trim();
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  if (!u.hostname.includes("facebook.com")) return "";
  let path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "/reel") return "";

  // Canonicalize /videos/ and /permalink/ → /posts/
  const m = path.match(/^\/([^/]+)\/(?:videos|permalink)\/((?:pfbid)?[A-Za-z0-9]+)$/i);
  if (m) return `https://www.facebook.com/${m[1]}/posts/${m[2]}`;

  if (path.includes("/posts/") || path.includes("/reel/")) {
    return `https://www.facebook.com${path}`;
  }
  return "";
}

/** Stable identity across /posts/, /videos/, /permalink/ URL forms. */
export function postIdentity(permalink) {
  try {
    const u = new URL(permalink);
    const path = u.pathname;
    const pfbid = path.match(/pfbid[A-Za-z0-9]+/);
    if (pfbid) return `pfbid:${pfbid[0]}`;
    const reel = path.match(/\/reel\/(\d+)/);
    if (reel) return `reel:${reel[1]}`;
    const num = path.match(/\/posts\/(\d+)/);
    if (num) return `post:${num[1]}`;
  } catch {
    /* ignore */
  }
  return "";
}

function isUsefulPost(text, images, permalink, profileName) {
  if (!permalink) return false;
  const trimmed = String(text || "").trim();
  if (!trimmed && !images.length) return false;
  if (
    profileName &&
    trimmed.toLowerCase() === profileName.trim().toLowerCase() &&
    !images.length
  ) {
    return false;
  }
  if ([...trimmed].length < 12 && !images.length) return false;
  return true;
}

function makeTitle(text, profileName) {
  const name = String(profileName || "").trim();
  text = String(text || "").trim();
  if (!text) {
    return name ? `${name} (photo/video)` : "Facebook post";
  }
  let line = text;
  const nl = line.indexOf("\n");
  if (nl >= 0) line = line.slice(0, nl);
  line = line.trim();
  const chars = [...line];
  if (chars.length > 100) line = `${chars.slice(0, 97).join("")}...`;
  if (name && !line.toLowerCase().startsWith(name.toLowerCase())) {
    return `${name}: ${line}`;
  }
  return line;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHTML(text, images, permalink) {
  let out = "";
  if (text) {
    for (const p of text.split("\n")) {
      const t = p.trim();
      if (!t) {
        out += "<br/>\n";
        continue;
      }
      out += `<p>${escapeHtml(t)}</p>\n`;
    }
  }
  for (const img of images) {
    out += `<p><img src="${escapeHtml(img)}" alt="" style="max-width:100%;height:auto" /></p>\n`;
  }
  out += `<p><a href="${escapeHtml(permalink)}">View on Facebook</a></p>`;
  return out;
}

function uniqueNonEmpty(list) {
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

function hashID(u) {
  return createHash("sha1").update(String(u)).digest("hex");
}
