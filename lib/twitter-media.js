/**
 * HTML rendering helpers for Twitter/X thread RSS items.
 */

import {
  clipTitleLine,
  escapeHtml,
  prefixTitle,
  renderMediaBlocks,
  renderTextParagraphs,
} from "./html.js";
import { normalizeHandle, threadPermalink } from "./twitter-thread.js";

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
    parts.push(renderTextParagraphs(t.text));
    parts.push(renderMediaBlocks(t.images, t.videos));
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

  const line = clipTitleLine(text);

  if (!line) {
    if (hasContext) return name ? `${name} (reply)` : "X reply";
    return name ? `${name} (post)` : "X post";
  }

  const prefix = hasContext ? `${name} reply` : name;
  return prefixTitle(prefix, line);
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
