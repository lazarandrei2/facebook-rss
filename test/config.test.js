import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFromUrl, loadConfig, requireAnyProfiles } from "../lib/config.js";

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

test("handleFromUrl parses x.com and twitter.com", () => {
  assert.equal(handleFromUrl("https://x.com/jack"), "jack");
  assert.equal(handleFromUrl("https://twitter.com/jack/status/123"), "jack");
  assert.equal(handleFromUrl("https://x.com/home"), "");
});

test("loadConfig supports nested facebook + twitter", () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `
listen: ":9090"
max_posts: 7
facebook:
  session_path: sess-fb.json
  database_path: data/fb.db
  profiles:
    - name: Zuck
      url: https://www.facebook.com/zuck
twitter:
  session_path: sess-tw.json
  profiles:
    - name: Jack
      url: https://x.com/jack
`,
  );
  try {
    const cfg = loadConfig(path);
    assert.equal(cfg.listen, ":9090");
    assert.equal(cfg.maxPosts, 7);
    assert.equal(cfg.facebook.sessionPath, "sess-fb.json");
    assert.equal(cfg.facebook.profiles[0].name, "Zuck");
    assert.equal(cfg.twitter.sessionPath, "sess-tw.json");
    assert.equal(cfg.twitter.profiles[0].handle, "jack");
    assert.equal(cfg.profiles[0].name, "Zuck"); // legacy alias
    requireAnyProfiles(cfg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig keeps legacy flat facebook profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `
session_path: session.json
database_path: data/posts.db
profiles:
  - name: Legacy
    url: https://www.facebook.com/zuck
`,
  );
  try {
    const cfg = loadConfig(path);
    assert.equal(cfg.facebook.sessionPath, "session.json");
    assert.equal(cfg.facebook.databasePath, "data/posts.db");
    assert.equal(cfg.facebook.profiles.length, 1);
    assert.equal(cfg.twitter.profiles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
