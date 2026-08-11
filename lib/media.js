/**
 * Media helpers for Facebook post photos/videos in RSS content.
 */

import { normalizeVideos, renderPostBody, uniqueNonEmpty } from "./html.js";

export { normalizeVideos, uniqueNonEmpty } from "./html.js";

const MAX_IMAGES = 10;
const MAX_VIDEOS = 3;

/** Decode Facebook JSON string escapes commonly seen in page payloads. */
export function decodeFbUrl(raw) {
  return String(raw || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0025/g, "%")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u002F/g, "/")
    .trim();
}

export function isBadImageUrl(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
  if (!/scontent|fbcdn|external\.f/.test(src)) return true;
  if (/emoji|static\.xx|rsrc\.php|t1\.30497-1|\/t39\.30808-1\//.test(src)) return true;
  // Profile / avatar sized CDN thumbs.
  if (/ctp=s(32|40|50|64|80|100|120)x/.test(src)) return true;
  if (/p\d+x\d+/.test(src) && /scontent/.test(src) && /_(?:s|q|t)\./.test(src)) return true;
  if (/_[sn]\.|\/s\d+x\d+\//.test(src) && !/\/s\d{3,}x\d{3,}\//.test(src)) return true;
  return false;
}

export function isBadVideoUrl(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
  // Prefer real progressive MP4 / FB video CDN URLs.
  if (/fbcdn\.net|facebook\.com\/.*\.mp4|\.mp4(\?|$)/i.test(src)) return false;
  if (/video\.xx\.fbcdn|video-.*\.fbcdn|scontent.*\/v\//i.test(src)) return false;
  return true;
}

/**
 * Extract image + video URLs from a Facebook page HTML payload (JSON blobs).
 * Pure / Node-safe — no DOM access.
 * @param {string} html
 * @param {{ postId?: string, maxImages?: number, maxVideos?: number }} [opts]
 */
export function extractMediaFromHtml(html, opts = {}) {
  const pageHtml = String(html || "");
  const postId = opts.postId || "";
  const maxImages = opts.maxImages ?? MAX_IMAGES;
  const maxVideos = opts.maxVideos ?? MAX_VIDEOS;

  const idx = postId ? pageHtml.indexOf(postId) : -1;
  const windowHtml =
    idx >= 0 ? pageHtml.slice(Math.max(0, idx - 40_000), idx + 80_000) : pageHtml;

  const images = [];
  const seenImg = new Set();
  const pushImg = (raw) => {
    const src = decodeFbUrl(raw);
    if (!src || isBadImageUrl(src)) return;
    const key = src
      .replace(/[?#].*$/, "")
      .replace(/\/s\d+x\d+\//g, "/")
      .replace(/\/[sp]\d+x\d+\//g, "/");
    if (seenImg.has(key) || seenImg.has(src)) return;
    seenImg.add(key);
    seenImg.add(src);
    images.push(src);
  };

  const videos = [];
  const seenVid = new Set();
  const pushVid = (raw, poster) => {
    const src = decodeFbUrl(raw);
    if (!src || isBadVideoUrl(src) || seenVid.has(src)) return;
    // Prefer HD: if we already have an SD sibling, replace it.
    const base = src.replace(/[?#].*$/, "").replace(/_(?:sd|hd|n)\./i, ".");
    const existingIdx = videos.findIndex(
      (v) => v.url.replace(/[?#].*$/, "").replace(/_(?:sd|hd|n)\./i, ".") === base,
    );
    const item = {
      url: src,
      poster: poster ? decodeFbUrl(poster) : "",
      type: "video/mp4",
    };
    if (existingIdx >= 0) {
      const prev = videos[existingIdx].url;
      const preferNew =
        /hd|_hd\.|quality_hd|browser_native_hd/i.test(src) &&
        !/hd|_hd\.|quality_hd|browser_native_hd/i.test(prev);
      if (preferNew) videos[existingIdx] = item;
      return;
    }
    seenVid.add(src);
    videos.push(item);
  };

  const imageRes = [
    /"(?:uri|url|image_uri|photo_image|preview_image|src)"\s*:\s*"(https:\\\/\\\/[^"]+(?:scontent|fbcdn)[^"]+)"/g,
    /"(?:uri|url|image_uri|photo_image|preview_image|src)"\s*:\s*"(https:\/\/[^"]+(?:scontent|fbcdn)[^"]+)"/g,
  ];
  for (const re of imageRes) {
    let m;
    while ((m = re.exec(windowHtml)) !== null && images.length < maxImages) {
      pushImg(m[1]);
    }
  }

  const videoRes = [
    /"playable_url(?:_quality_hd)?"\s*:\s*"(https:\\\/\\\/[^"]+)"/g,
    /"browser_native_(?:hd|sd)_url"\s*:\s*"(https:\\\/\\\/[^"]+)"/g,
    /"video_url"\s*:\s*"(https:\\\/\\\/[^"]+)"/g,
    /"playable_url(?:_quality_hd)?"\s*:\s*"(https:\/\/[^"]+)"/g,
    /"browser_native_(?:hd|sd)_url"\s*:\s*"(https:\/\/[^"]+)"/g,
  ];
  for (const re of videoRes) {
    let m;
    while ((m = re.exec(windowHtml)) !== null && videos.length < maxVideos) {
      pushVid(m[1]);
    }
  }

  if (videos.length) {
    for (const v of videos) {
      if (v.poster) continue;
      const vIdx = windowHtml.indexOf(v.url.replace(/\//g, "\\/").slice(0, 48));
      const around =
        vIdx >= 0
          ? windowHtml.slice(Math.max(0, vIdx - 8_000), vIdx + 8_000)
          : windowHtml;
      const posterMatch = around.match(
        /"(?:preferred_thumbnail|thumbnail|image|poster_image|video_thumbnail)"\s*:\s*\{[^}]{0,400}?"uri"\s*:\s*"(https:\\\/\\\/[^"]+scontent[^"]+)"/,
      );
      if (posterMatch) {
        const poster = decodeFbUrl(posterMatch[1]);
        if (!isBadImageUrl(poster)) {
          v.poster = poster;
          pushImg(poster);
        }
      }
    }
  }

  return {
    images: images.slice(0, maxImages),
    videos: videos.slice(0, maxVideos),
  };
}

/**
 * Pull media URLs already embedded in post HTML content (for RSS enclosures).
 * @param {string} html
 */
export function mediaFromContentHtml(html) {
  const body = String(html || "");
  const images = [];
  const videos = [];
  const seenImg = new Set();
  const seenVid = new Set();

  for (const m of body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (!src || seenImg.has(src)) continue;
    seenImg.add(src);
    images.push(src);
  }

  for (const m of body.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const posterMatch = attrs.match(/\bposter=["']([^"']+)["']/i);
    const poster = posterMatch?.[1] || "";
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    const sourceMatch = inner.match(/<source\b[^>]*\bsrc=["']([^"']+)["']/i);
    const url = sourceMatch?.[1] || srcMatch?.[1] || "";
    if (!url || seenVid.has(url)) continue;
    seenVid.add(url);
    videos.push({ url, type: "video/mp4", poster });
    if (poster && !seenImg.has(poster)) {
      seenImg.add(poster);
      images.push(poster);
    }
  }

  return { images, videos };
}

/**
 * Build HTML body for an RSS item including photos and videos.
 * @param {string} text
 * @param {string[]} images
 * @param {Array<{url:string,poster?:string,type?:string}>|string[]} videos
 * @param {string} permalink
 */
export function renderPostHTML(text, images, videos, permalink) {
  return renderPostBody(text, images, videos, permalink, "View on Facebook");
}

export function isUsefulPost(text, images, videos, permalink, profileName) {
  if (!permalink) return false;
  const trimmed = String(text || "").trim();
  const hasMedia = (images && images.length > 0) || (videos && videos.length > 0);
  if (!trimmed && !hasMedia) return false;
  if (
    profileName &&
    trimmed.toLowerCase() === profileName.trim().toLowerCase() &&
    !hasMedia
  ) {
    return false;
  }
  if ([...trimmed].length < 12 && !hasMedia) return false;
  return true;
}

export function guessMimeFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (/\.png(\?|$)/.test(u)) return "image/png";
  if (/\.webp(\?|$)/.test(u)) return "image/webp";
  if (/\.gif(\?|$)/.test(u)) return "image/gif";
  if (/\.mp4(\?|$)/.test(u) || /video/.test(u)) return "video/mp4";
  if (/\.(jpe?g)(\?|$)/.test(u) || /scontent|fbcdn/.test(u)) return "image/jpeg";
  return "application/octet-stream";
}
