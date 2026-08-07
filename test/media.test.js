import assert from "node:assert/strict";
import {
  decodeFbUrl,
  extractMediaFromHtml,
  isBadImageUrl,
  isBadVideoUrl,
  isUsefulPost,
  mediaFromContentHtml,
  renderPostHTML,
} from "../lib/media.js";
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

test("decodeFbUrl unescapes facebook JSON urls", () => {
  assert.equal(
    decodeFbUrl("https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t.jpg"),
    "https://scontent.xx.fbcdn.net/v/t.jpg",
  );
});

test("extractMediaFromHtml finds photos and videos near post id", () => {
  const html = `
    noise "uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t39.30808-6\\/photoA.jpg"
    pfbidABC123
    "full_image":{"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t39.30808-6\\/photoB.jpg"}
    "playable_url_quality_hd":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42.1790-2\\/clip.mp4"
    "browser_native_sd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42.1790-2\\/clip_sd.mp4"
    "preferred_thumbnail":{"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t15.5256-10\\/poster.jpg"}
  `;
  const media = extractMediaFromHtml(html, { postId: "pfbidABC123" });
  assert.ok(media.images.some((u) => u.includes("photoB.jpg")));
  assert.equal(media.videos.length, 1);
  assert.match(media.videos[0].url, /\.mp4/);
  assert.ok(
    /hd|quality_hd|clip\.mp4/i.test(media.videos[0].url),
    "prefers HD playable url",
  );
});

test("isBadImageUrl filters avatars and emoji", () => {
  assert.equal(isBadImageUrl("https://static.xx.fbcdn.net/emoji.png"), true);
  assert.equal(
    isBadImageUrl("https://scontent.xx.fbcdn.net/v/t39.30808-6/big.jpg"),
    false,
  );
});

test("isBadVideoUrl accepts fbcdn mp4", () => {
  assert.equal(
    isBadVideoUrl("https://video.xx.fbcdn.net/v/t42.1790-2/x.mp4?_nc=1"),
    false,
  );
  assert.equal(isBadVideoUrl("blob:https://www.facebook.com/abc"), true);
});

test("renderPostHTML embeds video and photos", () => {
  const html = renderPostHTML(
    "Hello\nWorld",
    ["https://scontent.xx.fbcdn.net/photo.jpg"],
    [
      {
        url: "https://video.xx.fbcdn.net/clip.mp4",
        poster: "https://scontent.xx.fbcdn.net/poster.jpg",
      },
    ],
    "https://www.facebook.com/x/posts/pfbid1",
  );
  assert.match(html, /<video controls/);
  assert.match(html, /poster="https:\/\/scontent\.xx\.fbcdn\.net\/poster\.jpg"/);
  assert.match(html, /<source src="https:\/\/video\.xx\.fbcdn\.net\/clip\.mp4"/);
  assert.match(html, /<img src="https:\/\/scontent\.xx\.fbcdn\.net\/photo\.jpg"/);
  // Poster should not also appear as a duplicate standalone image.
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /View on Facebook/);
});

test("isUsefulPost accepts media-only posts", () => {
  assert.equal(
    isUsefulPost("", ["https://scontent.xx.fbcdn.net/a.jpg"], [], "https://fb.com/p", "Name"),
    true,
  );
  assert.equal(
    isUsefulPost("", [], [{ url: "https://video.xx.fbcdn.net/a.mp4" }], "https://fb.com/p", "Name"),
    true,
  );
  assert.equal(isUsefulPost("hi", [], [], "https://fb.com/p", "Name"), false);
});

test("buildFeed emits enclosure and media:content", () => {
  const content = renderPostHTML(
    "Clip",
    ["https://scontent.xx.fbcdn.net/photo.jpg"],
    [{ url: "https://video.xx.fbcdn.net/clip.mp4", poster: "https://scontent.xx.fbcdn.net/poster.jpg" }],
    "https://www.facebook.com/x/reel/1",
  );
  const xml = buildFeed(
    { title: "T", link: "https://example.com/feed.xml", description: "D" },
    [
      {
        id: "abc",
        url: "https://www.facebook.com/x/reel/1",
        title: "Name: Clip",
        profileName: "Name",
        content,
        publishedAt: "2026-08-07T12:00:00.000Z",
      },
    ],
  );
  assert.match(xml, /xmlns:media=/);
  assert.match(xml, /<enclosure url="https:\/\/video\.xx\.fbcdn\.net\/clip\.mp4"/);
  assert.match(xml, /medium="video"/);
  assert.match(xml, /medium="image"/);
  assert.match(xml, /<media:thumbnail url="https:\/\/scontent\.xx\.fbcdn\.net\/poster\.jpg"/);
});

test("mediaFromContentHtml reads video poster", () => {
  const html = `<video controls poster="https://scontent/p.jpg"><source src="https://video/x.mp4" type="video/mp4" /></video>`;
  const media = mediaFromContentHtml(html);
  assert.equal(media.videos[0].url, "https://video/x.mp4");
  assert.equal(media.videos[0].poster, "https://scontent/p.jpg");
});

console.log("done");
