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

/** Commit and push feed.xml. No-op commit if unchanged; still tries push. */
export function publishFeed(message = "Update feed.xml") {
  if (!existsSync("feed.xml")) {
    throw new Error("feed.xml not found; run fetch first");
  }

  try {
    run("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });
  } catch {
    throw new Error("not a git repository");
  }

  const status = run("git", ["status", "--porcelain", "--", "feed.xml"], {
    capture: true,
  }).trim();

  if (status) {
    run("git", ["add", "--", "feed.xml"]);
    run("git", ["commit", "-m", message]);
  }

  run("git", ["push"]);
}
