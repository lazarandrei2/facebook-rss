/**
 * HTML rendering helpers for Twitter/X thread RSS items.
 */

import { normalizeHandle, threadPermalink } from "./twitter-thread.js";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeVideos(videos) {
  const out = [];
  const seen = new Set();
  for (const v of videos || []) {
    if (!v) continue;
    if (typeof v === "string") {
      const url = v.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, poster: "", type: "video/mp4" });
      continue;
    }
    const url = String(v.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      poster: String(v.poster || "").trim(),
      type: String(v.type || "video/mp4"),
    });
  }
  return out;
}

function renderText(text) {
  let out = "";
  for (const p of String(text || "").split("\n")) {
    const t = p.trim();
    if (!t) {
      out += "<br/>\n";
      continue;
    }
    out += `<p>${escapeHtml(t)}</p>\n`;
  }
  return out;
}

function renderMedia(images, videos) {
  let out = "";
  const vidList = normalizeVideos(videos);
  const posterSet = new Set(vidList.map((v) => v.poster).filter(Boolean));

  for (const v of vidList) {
    const poster = v.poster ? ` poster="${escapeHtml(v.poster)}"` : "";
    out += `<p><video controls playsinline preload="metadata"${poster} style="max-width:100%;height:auto">`;
    out += `<source src="${escapeHtml(v.url)}" type="${escapeHtml(v.type || "video/mp4")}" />`;
    out += `</video></p>\n`;
    out += `<p><a href="${escapeHtml(v.url)}">Direct video</a></p>\n`;
  }

  for (const img of images || []) {
    const src = String(img || "").trim();
    if (!src || posterSet.has(src)) continue;
    out += `<p><img src="${escapeHtml(src)}" alt="" style="max-width:100%;height:auto" /></p>\n`;
  }
  return out;
}

/**
 * Render an author-involved thread as HTML for content:encoded.
 * @param {import('./twitter-thread.js').Tweet[]} thread
 * @param {string} authorHandle
 * @param {string} [permalink]
 */
export function renderThreadHTML(thread, authorHandle, permalink) {
  const author = normalizeHandle(authorHandle);
  const link = permalink || threadPermalink(thread, authorHandle);
  const parts = [];

  for (let i = 0; i < (thread || []).length; i++) {
    const t = thread[i];
    const handle = normalizeHandle(t.handle);
    const isAuthor = handle === author;
    const label = t.name
      ? `${escapeHtml(t.name)} (@${escapeHtml(handle)})`
      : `@${escapeHtml(handle)}`;
    const kind =
      i === 0 && !t.inReplyToId
        ? isAuthor
          ? "post"
          : "original"
        : isAuthor
          ? "reply"
          : "context";

    parts.push(`<p><strong>${label}</strong> · ${kind}</p>\n`);
    parts.push(renderText(t.text));
    parts.push(renderMedia(t.images, t.videos));
    if (i < thread.length - 1) parts.push("<hr/>\n");
  }

  if (link) {
    parts.push(`<p><a href="${escapeHtml(link)}">View on X</a></p>`);
  }
  return parts.join("");
}

/**
 * Build a short RSS title for a thread.
 * @param {import('./twitter-thread.js').Tweet[]} thread
 * @param {string} authorHandle
 * @param {string} [profileName]
 */
export function makeThreadTitle(thread, authorHandle, profileName) {
  const author = normalizeHandle(authorHandle);
  const name = String(profileName || authorHandle || author).trim();
  const authorTweets = (thread || []).filter((t) => normalizeHandle(t.handle) === author);
  const focus = authorTweets[authorTweets.length - 1] || thread?.[0];
  const text = String(focus?.text || "").trim();
  const hasContext = (thread || []).some((t) => normalizeHandle(t.handle) !== author);

  let line = text;
  const nl = line.indexOf("\n");
  if (nl >= 0) line = line.slice(0, nl);
  line = line.trim();
  const chars = [...line];
  if (chars.length > 100) line = `${chars.slice(0, 97).join("")}...`;

  if (!line) {
    if (hasContext) return name ? `${name} (reply)` : "X reply";
    return name ? `${name} (post)` : "X post";
  }

  const prefix = hasContext ? `${name} reply` : name;
  if (prefix && !line.toLowerCase().startsWith(String(prefix).toLowerCase())) {
    return `${prefix}: ${line}`;
  }
  return line;
}

export function isUsefulTweet(text, images, videos) {
  const trimmed = String(text || "").trim();
  const hasMedia =
    (images && images.length > 0) || (videos && videos.length > 0);
  if (!trimmed && !hasMedia) return false;
  return true;
}

export function isBadTwitterImage(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
  if (/profile_images|emoji|ext_tw_video_thumb.*name=thumb/i.test(src)) return true;
  if (/\/profile_banners\//i.test(src)) return true;
  return false;
}

export function isBadTwitterVideo(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return true;
  if (/\.mp4(\?|$)/i.test(src)) return false;
  if (/video\.twimg\.com/i.test(src)) return false;
  return true;
}
