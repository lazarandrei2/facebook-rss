import assert from "node:assert/strict";
import {
  buildAuthorThread,
  groupAuthorThreads,
  linkReplyChain,
  normalizeHandle,
  selectAuthorConversation,
  threadPermalink,
  threadPublishedAt,
} from "../lib/twitter-thread.js";
import { snowflakeToIso } from "../lib/twitter-scraper.js";
import { makeThreadTitle, renderThreadHTML } from "../lib/twitter-media.js";
import { buildFeed } from "../lib/rssfeed.js";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function tw(id, handle, opts = {}) {
  return {
    id: String(id),
    handle,
    name: opts.name || handle,
    text: opts.text || `text-${id}`,
    url: `https://x.com/${handle}/status/${id}`,
    publishedAt: opts.publishedAt || "",
    inReplyToId: opts.inReplyToId ?? null,
    images: opts.images || [],
    videos: opts.videos || [],
  };
}

test("normalizeHandle strips @ and lowercases", () => {
  assert.equal(normalizeHandle("@Alice"), "alice");
});

test("buildAuthorThread keeps only ancestors author replied through", () => {
  // Root by other → sibling comments → author replies to one of them
  const root = tw(1, "other", { text: "root post" });
  const sibling = tw(2, "rando", { inReplyToId: "1", text: "noise" });
  const context = tw(3, "friend", { inReplyToId: "1", text: "context" });
  const authorReply = tw(4, "me", { inReplyToId: "3", text: "my reply" });
  const otherNoise = tw(5, "noise", { inReplyToId: "1", text: "more noise" });

  const thread = buildAuthorThread(
    [root, sibling, context, authorReply, otherNoise],
    "me",
  );

  assert.deepEqual(
    thread.map((t) => t.id),
    ["1", "3", "4"],
    "includes root + replied-to comment + author reply; drops siblings",
  );
});

test("buildAuthorThread includes author original posts with no parents", () => {
  const post = tw(10, "me", { text: "hello" });
  const thread = buildAuthorThread([post], "me");
  assert.equal(thread.length, 1);
  assert.equal(thread[0].id, "10");
});

test("buildAuthorThread includes author self-reply chains", () => {
  const a = tw(1, "me", { text: "one" });
  const b = tw(2, "me", { inReplyToId: "1", text: "two" });
  const c = tw(3, "me", { inReplyToId: "2", text: "three" });
  const thread = buildAuthorThread([a, b, c], "me");
  assert.deepEqual(
    thread.map((t) => t.id),
    ["1", "2", "3"],
  );
});

test("even when root is not the author, thread includes root + author reply", () => {
  const root = tw(100, "elon", { text: "big claim" });
  const reply = tw(101, "me", { inReplyToId: "100", text: "counterpoint" });
  const thread = buildAuthorThread([root, reply], "me");
  assert.deepEqual(
    thread.map((t) => t.id),
    ["100", "101"],
  );
  assert.match(renderThreadHTML(thread, "me"), /@elon/);
  assert.match(renderThreadHTML(thread, "me"), /counterpoint/);
  assert.match(makeThreadTitle(thread, "me", "Me"), /reply/i);
});

test("groupAuthorThreads splits separate conversations", () => {
  const r1 = tw(1, "a", { text: "root1" });
  const a1 = tw(2, "me", { inReplyToId: "1", text: "reply1" });
  const r2 = tw(3, "b", { text: "root2" });
  const a2 = tw(4, "me", { inReplyToId: "3", text: "reply2" });
  const groups = groupAuthorThreads([r1, a1, r2, a2], "me");
  assert.equal(groups.length, 2);
  const ids = groups.map((g) => g.tweets.map((t) => t.id).join(",")).sort();
  assert.deepEqual(ids, ["1,2", "3,4"]);
});

test("linkReplyChain fills missing inReplyToId from order", () => {
  const linked = linkReplyChain([tw(1, "a"), tw(2, "me"), tw(3, "me")]);
  assert.equal(linked[0].inReplyToId, null);
  assert.equal(linked[1].inReplyToId, "1");
  assert.equal(linked[2].inReplyToId, "2");
});

test("selectAuthorConversation drops unrelated replies below focus", () => {
  const extracted = [
    tw(1, "other", { text: "root" }),
    tw(2, "me", { text: "my reply" }),
    tw(3, "rando", { text: "unrelated" }),
    tw(4, "me", { text: "self continue" }), // not contiguous after focus if rando in between — focus is 2
  ];
  // Simulate focus on author reply id=2: should keep 1,2 only (rando breaks self-chain)
  const selected = selectAuthorConversation(extracted, "me", "2");
  assert.deepEqual(
    selected.map((t) => t.id),
    ["1", "2"],
  );
});

test("selectAuthorConversation keeps contiguous author self-replies under focus", () => {
  const extracted = [
    tw(1, "other", { text: "root" }),
    tw(2, "me", { text: "reply" }),
    tw(3, "me", { text: "followup" }),
    tw(4, "rando", { text: "noise" }),
  ];
  const selected = selectAuthorConversation(extracted, "me", "2");
  assert.deepEqual(
    selected.map((t) => t.id),
    ["1", "2", "3"],
  );
});

test("threadPublishedAt prefers author tweet timestamps", () => {
  const thread = [
    tw(1, "other", { publishedAt: "2020-01-01T00:00:00.000Z" }),
    tw(2, "me", { inReplyToId: "1", publishedAt: "2024-06-01T12:00:00.000Z" }),
  ];
  assert.equal(threadPublishedAt(thread, "me"), "2024-06-01T12:00:00.000Z");
  assert.match(threadPermalink(thread, "me"), /\/status\/2$/);
});

test("twitter feed xml builds with thread item", () => {
  const thread = buildAuthorThread(
    [
      tw(1, "other", { text: "hello world from other" }),
      tw(2, "me", { inReplyToId: "1", text: "hi back from me" }),
    ],
    "me",
  );
  const xml = buildFeed(
    {
      title: "Twitter / X RSS",
      link: "https://example.com/twitter.xml",
      description: "test",
    },
    [
      {
        id: "abc",
        profileName: "Me",
        title: makeThreadTitle(thread, "me", "Me"),
        content: renderThreadHTML(thread, "me"),
        url: threadPermalink(thread, "me"),
        publishedAt: "2024-06-01T12:00:00.000Z",
      },
    ],
  );
  assert.match(xml, /<title>Twitter \/ X RSS<\/title>/);
  assert.match(xml, /hi back from me/);
  assert.match(xml, /View on X/);
  assert.match(xml, /<pubDate>Sat, 01 Jun 2024 12:00:00 GMT<\/pubDate>/);
  assert.match(xml, /<lastBuildDate>/);
});

test("snowflakeToIso decodes tweet create time", () => {
  assert.equal(snowflakeToIso("2086493299469406339"), "2026-08-09T16:42:22.421Z");
  assert.equal(snowflakeToIso(""), "");
});
