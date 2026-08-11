/**
 * Shared HTML / text helpers used by RSS rendering and fingerprints.
 */

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strip HTML tags, leaving spaces where tags were. */
export function stripTags(html) {
  let s = String(html || "");
  for (;;) {
    const start = s.indexOf("<");
    if (start < 0) break;
    const end = s.indexOf(">", start);
    if (end < 0) break;
    s = `${s.slice(0, start)} ${s.slice(end + 1)}`;
  }
  return s;
}

export function uniqueNonEmpty(list) {
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

export function normalizeVideos(videos) {
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

/** First line of text, clipped to maxChars (default 100) with ellipsis. */
export function clipTitleLine(text, maxChars = 100) {
  let line = String(text || "").trim();
  const nl = line.indexOf("\n");
  if (nl >= 0) line = line.slice(0, nl);
  line = line.trim();
  const chars = [...line];
  if (chars.length > maxChars) {
    line = `${chars.slice(0, Math.max(0, maxChars - 3)).join("")}...`;
  }
  return line;
}

/** Prefix a title with a name when the line does not already start with it. */
export function prefixTitle(name, line) {
  const n = String(name || "").trim();
  const l = String(line || "").trim();
  if (!l) return n;
  if (!n) return l;
  if (l.toLowerCase().startsWith(n.toLowerCase())) return l;
  return `${n}: ${l}`;
}

export function renderTextParagraphs(text) {
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

/**
 * Render video + image blocks for RSS content:encoded.
 * @param {string[]} images
 * @param {Array|{url:string,poster?:string,type?:string}|string[]} videos
 */
export function renderMediaBlocks(images, videos) {
  let out = "";
  const vidList = normalizeVideos(videos);
  const imgList = uniqueNonEmpty(images);
  const posterSet = new Set(vidList.map((v) => v.poster).filter(Boolean));

  for (const v of vidList) {
    const poster = v.poster ? ` poster="${escapeHtml(v.poster)}"` : "";
    out += `<p><video controls playsinline preload="metadata"${poster} style="max-width:100%;height:auto">`;
    out += `<source src="${escapeHtml(v.url)}" type="${escapeHtml(v.type || "video/mp4")}" />`;
    out += `</video></p>\n`;
    out += `<p><a href="${escapeHtml(v.url)}">Direct video</a></p>\n`;
  }

  for (const img of imgList) {
    if (posterSet.has(img) && vidList.length) continue;
    out += `<p><img src="${escapeHtml(img)}" alt="" style="max-width:100%;height:auto" /></p>\n`;
  }
  return out;
}

/**
 * Full post/thread HTML body: text + media + footer link.
 * @param {string} text
 * @param {string[]} images
 * @param {Array|string[]} videos
 * @param {string} permalink
 * @param {string} viewLabel e.g. "View on Facebook"
 */
export function renderPostBody(text, images, videos, permalink, viewLabel) {
  let out = renderTextParagraphs(text);
  out += renderMediaBlocks(images, videos);
  if (permalink) {
    out += `<p><a href="${escapeHtml(permalink)}">${escapeHtml(viewLabel || "View post")}</a></p>`;
  }
  return out;
}
