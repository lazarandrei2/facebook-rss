/**
 * Facebook profile scraper (Playwright).
 *
 * Takes a shared runtime config + facebook source block:
 *   new Scraper({ headless, maxPosts, source: cfg.facebook })
 */

import { contentFingerprint } from "./store.js";
import {
  hashID,
  interactiveLogin,
  scrollHarvest,
  withSessionPage,
} from "./browser.js";
import {
  belongsToProfile,
  cleanText,
  collectPostURLsJS,
  extractPostPageJS,
  makeFacebookTitle,
  normalizePostURL,
  parsePublishedAt,
  postIdentity,
  profileSlug,
} from "./facebook-extract.js";
import {
  extractMediaFromHtml,
  isBadImageUrl,
  isBadVideoUrl,
  isUsefulPost,
  renderPostHTML,
} from "./media.js";
import { normalizeVideos, uniqueNonEmpty } from "./html.js";

export { parsePublishedAt, postIdentity } from "./facebook-extract.js";

export class Scraper {
  /**
   * @param {{ headless?: boolean, maxPosts?: number, source: object }} cfg
   */
  constructor(cfg) {
    this.headless = cfg.headless ?? true;
    this.maxPosts = cfg.maxPosts || 15;
    this.source = cfg.source || cfg;
    this.sessionPath = this.source.sessionPath || "session-facebook.json";
    this.profiles = this.source.profiles || [];
  }

  async login() {
    await interactiveLogin({
      loginUrl: "https://www.facebook.com/login",
      sessionPath: this.sessionPath,
      prompt: [
        "facebook-rss: Log in to Facebook in the opened browser window.",
        "facebook-rss: When your news feed is visible, return here and press Enter.",
      ],
    });
  }

  async fetchLatest() {
    return withSessionPage(
      {
        sessionPath: this.sessionPath,
        headless: this.headless,
        missingSessionError: `session not found at ${this.sessionPath}; run: node bin/cli.js login facebook`,
      },
      async (page) => {
        const all = [];
        const seenContent = new Set();

        for (const profile of this.profiles) {
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
        return all;
      },
    );
  }

  async #fetchProfile(page, profile) {
    const urls = await this.#collectPostURLs(page, profile);
    if (!urls.length) {
      throw new Error("no posts found (login expired, profile private, or DOM changed)");
    }

    const limit = this.maxPosts || 15;
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
      const videos = normalizeVideos(full.videos);
      if (!isUsefulPost(text, images, videos, permalink, profile.name)) {
        console.warn(`facebook-rss: warn: skip thin post ${permalink}`);
        continue;
      }

      const title = makeFacebookTitle(text, profile.name, images, videos);
      const content = renderPostHTML(text, images, videos, permalink);
      const contentKey = contentFingerprint(title, content);
      if (contentKey && seenContent.has(contentKey)) {
        console.log(`facebook-rss: skip duplicate content: ${permalink}`);
        continue;
      }
      if (contentKey) seenContent.add(contentKey);
      if (postKey) seenIDs.add(postKey);

      const publishedAt = parsePublishedAt(full.publishedAt);
      if (!publishedAt) {
        console.warn(`facebook-rss: warn: no post date for ${permalink}`);
      }

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

    const want = this.maxPosts || 15;
    const target = Math.max(want + 5, 20);
    const harvested = await scrollHarvest(page, {
      target,
      maxRounds: 25,
      waitMs: 1500,
      evaluate: async () => {
        const found = await page.evaluate(collectPostURLsJS, slug);
        const out = [];
        for (const u of found || []) {
          const permalink = normalizePostURL(u);
          if (!permalink || !belongsToProfile(permalink, slug)) continue;
          out.push(permalink);
        }
        return out;
      },
      onRound: async () => {
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
      },
    });

    console.log(`facebook-rss: ${profile.name}: discovered ${harvested.length} post urls`);
    return harvested;
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
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1000);

    if (/\/reel\/|\/videos\//i.test(permalink)) {
      await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('div[role="button"], div[aria-label], i, span'),
        );
        for (const el of candidates) {
          const label = (
            el.getAttribute("aria-label") ||
            el.innerText ||
            ""
          )
            .trim()
            .toLowerCase();
          if (label === "play" || label === "play video" || label.includes("play")) {
            try {
              el.click();
            } catch (_) {}
            break;
          }
        }
        const video = document.querySelector("video");
        if (video) {
          try {
            video.muted = true;
            video.play().catch(() => {});
          } catch (_) {}
        }
      });
      await page.waitForTimeout(1500);
    }

    const result = await page.evaluate(extractPostPageJS, profile.name);
    const pageHtml = await page.content();
    const postId =
      (permalink.match(/pfbid[A-Za-z0-9]+/) || [])[0] ||
      (permalink.match(/\/reel\/(\d+)/) || [])[1] ||
      (permalink.match(/\/posts\/(\d+)/) || [])[1] ||
      "";
    const fromHtml = extractMediaFromHtml(pageHtml, { postId });

    const images = uniqueNonEmpty([
      ...(Array.isArray(result?.images) ? result.images : []),
      ...fromHtml.images,
    ]).filter((src) => !isBadImageUrl(src));

    const videos = normalizeVideos([
      ...(Array.isArray(result?.videos) ? result.videos : []),
      ...fromHtml.videos,
    ]).filter((v) => !isBadVideoUrl(v.url));

    return {
      url: permalink,
      text: result?.text || "",
      images,
      videos,
      publishedAt: result?.publishedAt || "",
    };
  }
}
