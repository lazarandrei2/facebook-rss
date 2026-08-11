import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stripTags } from "./html.js";

export class Store {
  /** @param {string} path */
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        profile_url TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC);
    `);
    this.#ensureContentKeyColumn();
  }

  #ensureContentKeyColumn() {
    const cols = this.db.prepare(`PRAGMA table_info(posts)`).all();
    if (!cols.some((c) => c.name === "content_key")) {
      this.db.exec(`ALTER TABLE posts ADD COLUMN content_key TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_content_key ON posts(content_key)`);
  }

  close() {
    this.db.close();
  }

  /**
   * Insert or refresh a post. Returns true when newly inserted.
   * Skips insert when another row already has the same content_key (duplicate body).
   * @param {object} p
   */
  upsert(p) {
    const now = new Date().toISOString();
    const fetchedAt = p.fetchedAt || now;
    const contentKey = p.contentKey || contentFingerprint(p.title, p.content);
    const incomingPub = String(p.publishedAt || "").trim();

    const byId = this.db
      .prepare(`SELECT id, content_key, published_at FROM posts WHERE id = ?`)
      .get(p.id);
    if (byId) {
      // Never replace a real post timestamp with fetch-time / empty on re-scrape.
      const publishedAt = incomingPub || byId.published_at || fetchedAt;
      this.db
        .prepare(
          `UPDATE posts
           SET profile_url = ?, profile_name = ?, title = ?, content = ?, url = ?,
               content_key = ?, published_at = ?, fetched_at = ?
           WHERE id = ?`,
        )
        .run(
          p.profileUrl,
          p.profileName,
          p.title,
          p.content,
          p.url,
          contentKey,
          publishedAt,
          fetchedAt,
          p.id,
        );
      return false;
    }

    const publishedAt = incomingPub || fetchedAt;

    // Same body under a different URL/id → treat as duplicate, do not insert.
    if (contentKey) {
      const byContent = this.db
        .prepare(`SELECT id FROM posts WHERE content_key = ? LIMIT 1`)
        .get(contentKey);
      if (byContent) {
        return false;
      }
    }

    this.db
      .prepare(
        `INSERT INTO posts (
          id, profile_url, profile_name, title, content, url, content_key, published_at, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.profileUrl,
        p.profileName,
        p.title,
        p.content,
        p.url,
        contentKey,
        publishedAt,
        fetchedAt,
      );
    return true;
  }

  clear() {
    this.db.prepare(`DELETE FROM posts`).run();
  }

  /** @param {number} limit */
  list(limit = 50) {
    if (limit <= 0) limit = 50;
    const fetchLimit = Math.max(limit * 3, 50);
    const rows = this.db
      .prepare(
        `SELECT id, profile_url, profile_name, title, content, url, content_key, published_at, fetched_at
         FROM posts
         ORDER BY published_at DESC
         LIMIT ?`,
      )
      .all(fetchLimit);

    const posts = [];
    const seenKeys = new Set();
    for (const row of rows) {
      const key =
        row.content_key ||
        contentFingerprint(row.title, row.content) ||
        normalizeTitle(row.title);
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      posts.push({
        id: row.id,
        profileUrl: row.profile_url,
        profileName: row.profile_name,
        title: row.title,
        content: row.content,
        url: row.url,
        contentKey: row.content_key,
        publishedAt: row.published_at,
        fetchedAt: row.fetched_at,
      });
      if (posts.length >= limit) break;
    }
    return posts;
  }
}

export function openStore(path) {
  return new Store(path);
}

export function contentFingerprint(title, content) {
  // Strip platform footer links ("View on Facebook", "View on X", …) neutrally.
  const plain = stripTags(content)
    .toLowerCase()
    .replace(/\bview on \w+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const t = normalizeTitle(title);
  // Ignore generic media/post titles so identical empty captions collapse on body alone.
  const titlePart =
    /^(?:.+ \((?:photo|video|photo\/video|post|reply)\)|(?:facebook|x) (?:post|photo|video|reply))$/i.test(
      t,
    )
      ? ""
      : t;
  if (!titlePart && !plain) return "";
  return createHash("sha1").update(`${titlePart}|${plain}`).digest("hex").slice(0, 16);
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
