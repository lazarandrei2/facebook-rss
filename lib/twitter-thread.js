/**
 * Pure helpers for reconstructing X/Twitter conversation threads
 * that involve a subscribed author.
 *
 * Rules:
 * - Include every tweet by the author.
 * - Include ancestors the author replied to (walk in_reply_to).
 * - Exclude sibling/unrelated comments the author never engaged with.
 */

/** @param {string} handle */
export function normalizeHandle(handle) {
  return String(handle || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

/**
 * @typedef {object} Tweet
 * @property {string} id
 * @property {string} handle
 * @property {string} [name]
 * @property {string} [text]
 * @property {string} [url]
 * @property {string} [publishedAt]
 * @property {string|null|undefined} inReplyToId
 * @property {string[]} [images]
 * @property {Array<{url:string,poster?:string,type?:string}>|string[]} [videos]
 */

/**
 * Filter a conversation down to the author-involved chain.
 * Preserves input order among included tweets.
 *
 * @param {Tweet[]} tweets
 * @param {string} authorHandle
 * @returns {Tweet[]}
 */
export function buildAuthorThread(tweets, authorHandle) {
  const list = Array.isArray(tweets) ? tweets.filter((t) => t && t.id) : [];
  if (!list.length) return [];

  const author = normalizeHandle(authorHandle);
  if (!author) return [];

  const byId = new Map();
  for (const t of list) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  const authorTweets = list.filter((t) => normalizeHandle(t.handle) === author);
  if (!authorTweets.length) return [];

  const include = new Set();
  for (const at of authorTweets) {
    include.add(at.id);
    let cur = at.inReplyToId || null;
    const seen = new Set();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      include.add(cur);
      cur = byId.get(cur).inReplyToId || null;
    }
  }

  // Preserve first-seen order from the input list.
  const out = [];
  const emitted = new Set();
  for (const t of list) {
    if (!include.has(t.id) || emitted.has(t.id)) continue;
    emitted.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Walk up in_reply_to links to the conversation root id.
 * @param {Tweet} tweet
 * @param {Map<string, Tweet>} byId
 */
export function conversationRootId(tweet, byId) {
  if (!tweet?.id) return "";
  let cur = tweet;
  const seen = new Set();
  while (cur?.inReplyToId && byId.has(cur.inReplyToId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.inReplyToId);
  }
  return cur?.id || tweet.id;
}

/**
 * Group tweets into author-involved threads keyed by conversation root.
 * Each group is filtered with buildAuthorThread.
 *
 * @param {Tweet[]} tweets
 * @param {string} authorHandle
 * @returns {Array<{ rootId: string, tweets: Tweet[] }>}
 */
export function groupAuthorThreads(tweets, authorHandle) {
  const list = Array.isArray(tweets) ? tweets.filter((t) => t && t.id) : [];
  const author = normalizeHandle(authorHandle);
  if (!list.length || !author) return [];

  const byId = new Map();
  for (const t of list) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  const authorTweets = list.filter((t) => normalizeHandle(t.handle) === author);
  const groups = new Map();

  for (const at of authorTweets) {
    const rootId = conversationRootId(at, byId);
    if (!groups.has(rootId)) groups.set(rootId, []);
    groups.get(rootId).push(at.id);
  }

  const results = [];
  for (const rootId of groups.keys()) {
    // Collect every tweet that belongs to this root (among known tweets).
    const related = list.filter((t) => conversationRootId(t, byId) === rootId);
    const thread = buildAuthorThread(related, author);
    if (thread.length) results.push({ rootId, tweets: thread });
  }

  return results;
}

/**
 * Infer reply edges for an ordered ancestor→focus chain (status page order).
 * Sets inReplyToId when missing: each tweet replies to the previous one.
 * @param {Tweet[]} ordered
 * @returns {Tweet[]}
 */
export function linkReplyChain(ordered) {
  const out = [];
  for (let i = 0; i < ordered.length; i++) {
    const t = { ...ordered[i] };
    if (!t.inReplyToId && i > 0) t.inReplyToId = out[i - 1].id;
    out.push(t);
  }
  return out;
}

/**
 * Pick the primary permalink for an author thread (latest author tweet).
 * @param {Tweet[]} thread
 * @param {string} authorHandle
 */
export function threadPermalink(thread, authorHandle) {
  const author = normalizeHandle(authorHandle);
  const authorTweets = (thread || []).filter((t) => normalizeHandle(t.handle) === author);
  const pick = authorTweets[authorTweets.length - 1] || thread?.[0];
  return pick?.url || "";
}

/**
 * Latest publishedAt among author tweets in the thread (else first tweet).
 * @param {Tweet[]} thread
 * @param {string} authorHandle
 */
export function threadPublishedAt(thread, authorHandle) {
  const author = normalizeHandle(authorHandle);
  const authorTweets = (thread || []).filter((t) => normalizeHandle(t.handle) === author);
  const candidates = authorTweets.length ? authorTweets : thread || [];
  let best = "";
  let bestMs = -Infinity;
  for (const t of candidates) {
    if (!t.publishedAt) continue;
    const ms = Date.parse(t.publishedAt);
    if (!Number.isNaN(ms) && ms >= bestMs) {
      bestMs = ms;
      best = t.publishedAt;
    }
  }
  return best;
}
