/**
 * Facebook page-evaluate extractors and URL helpers.
 *
 * In-page scripts (collectPostURLsJS / extractPostPageJS) must stay
 * self-contained — Playwright serializes them into the browser.
 * JSON media harvesting lives in media.extractMediaFromHtml.
 */

import { clipTitleLine, prefixTitle } from "./html.js";

/** Collect only real profile-owned anchors (no invented pfbid URLs). */
export function collectPostURLsJS(slug) {
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
 * Extract text + DOM/OG media + publishedAt for the opened permalink.
 * JSON CDN harvest runs in Node via extractMediaFromHtml(page.content()).
 */
export function extractPostPageJS(profileName) {
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

  // DOM/OG media only — JSON CDN harvest is done in Node via extractMediaFromHtml.
  const isBadImage = (src) => {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
    if (!/scontent|fbcdn|external\.f/.test(src)) return true;
    if (/emoji|static\.xx|rsrc\.php|t1\.30497-1|\/t39\.30808-1\//.test(src)) return true;
    if (/ctp=s(32|40|50|64|80|100|120)x/.test(src)) return true;
    if (/_[sn]\.|\/s\d+x\d+\//.test(src) && !/\/s\d{3,}x\d{3,}\//.test(src)) return true;
    return false;
  };

  const isBadVideo = (src) => {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
    if (/fbcdn\.net|facebook\.com\/.*\.mp4|\.mp4(\?|$)/i.test(src)) return false;
    if (/video\.xx\.fbcdn|video-.*\.fbcdn|scontent.*\/v\//i.test(src)) return false;
    return true;
  };

  const images = [];
  const seenImg = new Set();
  const pushImg = (src) => {
    if (!src || isBadImage(src) || seenImg.has(src)) return;
    const key = src.replace(/[?&](stp|oh|oe|_[a-z]+)=[^&]*/gi, "").split("&")[0];
    if (seenImg.has(key)) return;
    seenImg.add(src);
    seenImg.add(key);
    images.push(src);
  };

  const videos = [];
  const seenVid = new Set();
  const pushVid = (src, poster) => {
    if (!src || isBadVideo(src) || seenVid.has(src)) return;
    seenVid.add(src);
    videos.push({
      url: src,
      poster: poster && !isBadImage(poster) ? poster : "",
      type: "video/mp4",
    });
  };

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
      if (images.length >= 10) break;
    }
  }

  {
    const scope = article || document;
    for (const video of scope.querySelectorAll("video")) {
      const poster = video.getAttribute("poster") || "";
      const sources = [];
      if (video.currentSrc) sources.push(video.currentSrc);
      if (video.src) sources.push(video.src);
      for (const source of video.querySelectorAll("source[src]")) {
        sources.push(source.src || source.getAttribute("src") || "");
      }
      for (const src of sources) {
        pushVid(src, poster);
        if (poster) pushImg(poster);
        if (videos.length >= 3) break;
      }
      if (videos.length >= 3) break;
    }
  }

  if (!images.length) {
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) pushImg(og.content);
  }
  if (!videos.length) {
    for (const sel of [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
    ]) {
      const el = document.querySelector(sel);
      if (el?.content) {
        pushVid(el.content, document.querySelector('meta[property="og:image"]')?.content || "");
        if (videos.length) break;
      }
    }
  }

  const publishedAt = extractPublishedAt(pfbid, html);

  return {
    text,
    images: images.slice(0, 10),
    videos: videos.slice(0, 3),
    titleTeaser,
    publishedAt,
  };

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

    if (id) {
      let best = null;
      const cre = /"creation_time"\s*:\s*(\d{9,13})/g;
      let m;
      while ((m = cre.exec(pageHtml)) !== null) {
        const start = Math.max(0, m.index - 4000);
        const around = pageHtml.slice(start, Math.min(pageHtml.length, m.index + 4000));
        const at = around.indexOf(id);
        if (at < 0) continue;
        const dist = Math.abs(at - (m.index - start));
        const iso = toIso(m[1]);
        if (!iso) continue;
        if (!best || dist < best.dist) best = { iso, dist };
      }
      if (best) return best.iso;

      const urlRe = new RegExp(
        `"creation_time"\\s*:\\s*(\\d{9,13})[^]{0,400}"url"\\s*:\\s*"https:\\\\/\\\\/www\\.facebook\\.com[^"]*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );
      const um = pageHtml.match(urlRe);
      if (um) {
        const iso = toIso(um[1]);
        if (iso) return iso;
      }
    }

    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[property="og:published_time"]',
      'meta[name="publish_date"]',
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      if (el?.content) {
        const iso = toIso(el.content);
        if (iso) return iso;
      }
    }

    const art = findPostArticle(id);
    const scope = art || document;
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

    const candidates = [];
    for (const el of scope.querySelectorAll("a, abbr, span")) {
      const aria = (el.getAttribute("aria-label") || "").trim();
      const labelText = (el.innerText || "").trim();
      const href = el.href || "";
      const label = aria || labelText;
      if (!label) continue;
      if (id && href && !href.includes(id) && !/ago|yesterday|^\d+[smhdw]$/i.test(label)) continue;
      const iso = parseRelativeTime(label);
      if (iso) {
        const score = id && href.includes(id) ? 0 : aria ? 1 : 2;
        candidates.push({ iso, score });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    if (candidates[0]) return candidates[0].iso;

    return "";
  }

  function parseRelativeTime(label) {
    const s = String(label || "").trim().toLowerCase();
    if (!s) return "";
    const now = Date.now();
    if (s === "just now" || s === "acum") return new Date(now).toISOString();

    let m = s.match(/^(\d+)\s*([smhdwy])\b/);
    if (!m) m = s.match(/^(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\b/);
    if (!m) m = s.match(/^acum\s+(\d+)\s*(s|sec|secund[ae]|min|minute?|h|ore?|zile?|săptămâni?|luni|ani)/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      const mult =
        /^(s|sec|second)/i.test(unit) ? 1000 :
        /^(m|min)/i.test(unit) && !/^month/i.test(unit) ? 60_000 :
        /^(h|hr|hour|o)/i.test(unit) ? 3_600_000 :
        /^(d|day|z)/i.test(unit) ? 86_400_000 :
        /^(w|week|săpt)/i.test(unit) ? 604_800_000 :
        /^(month|luni)/i.test(unit) ? 2_592_000_000 :
        /^(y|year|ani)/i.test(unit) ? 31_536_000_000 :
        0;
      if (mult) return new Date(now - n * mult).toISOString();
    }

    if (/^yesterday\b/.test(s) || /^ieri\b/.test(s)) {
      const d = new Date(now - 86_400_000);
      const time = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
      if (time) {
        let h = Number(time[1]);
        const min = Number(time[2]);
        const ap = (time[3] || "").toLowerCase();
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        d.setHours(h, min, 0, 0);
      }
      return d.toISOString();
    }

    const cleaned = label.replace(/\bat\b/i, " ");
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime())) {
      if (Math.abs(d.getTime() - now) < 1000 * 60 * 60 * 24 * 365 * 5) return d.toISOString();
    }
    return "";
  }

  function findPostArticle(id) {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    if (!articles.length) return null;
    if (!id) return articles[0];
    const needle = String(id);
    for (const art of articles) {
      const artHtml = art.innerHTML || "";
      if (artHtml.includes(needle)) return art;
      const links = art.querySelectorAll("a[href]");
      for (const a of links) {
        if ((a.href || "").includes(needle)) return art;
      }
    }
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

export function profileSlug(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return "profile.php";
    return path.split("/")[0];
  } catch {
    return String(raw).replace(/^\/+|\/+$/g, "");
  }
}

export function belongsToProfile(permalink, slug) {
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

export function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/^unread\s*/i, "")
    .replace(/[\u200b\u200c\u200d\ufeff\u2060]/g, "")
    .trim();
}

export function normalizePostURL(raw) {
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

export function makeFacebookTitle(text, profileName, images = [], videos = []) {
  const name = String(profileName || "").trim();
  text = String(text || "").trim();
  if (!text) {
    if (videos?.length) return name ? `${name} (video)` : "Facebook video";
    if (images?.length) return name ? `${name} (photo)` : "Facebook photo";
    return name ? `${name} (photo/video)` : "Facebook post";
  }
  return prefixTitle(name, clipTitleLine(text));
}
