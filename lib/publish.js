import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(name, args, { capture = false } = {}) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed (exit ${result.status})`);
  }
  return capture ? result.stdout || "" : "";
}

/**
 * Commit and push feed XML files.
 * @param {string} message
 * @param {string[]} [files]
 */
export function publishFeed(message = "Update feeds", files = ["facebook.xml", "twitter.xml", "feed.xml"]) {
  const existing = files.filter((f) => existsSync(f));
  if (!existing.length) {
    throw new Error("no feed xml files found; run fetch first");
  }

  try {
    run("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });
  } catch {
    throw new Error("not a git repository");
  }

  const status = run("git", ["status", "--porcelain", "--", ...existing], {
    capture: true,
  }).trim();

  if (status) {
    run("git", ["add", "--", ...existing]);
    run("git", ["commit", "-m", message]);
  }

  run("git", ["push"]);
}
