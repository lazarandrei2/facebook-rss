/**
 * Shared Playwright browser helpers for Facebook and Twitter scrapers.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export function hashID(u) {
  return createHash("sha1").update(String(u)).digest("hex");
}

export function waitForEnter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * @param {{ headless?: boolean }} [opts]
 */
export async function launchBrowser(opts = {}) {
  return chromium.launch({ headless: opts.headless ?? true });
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{ storageState?: string, locale?: string }} [opts]
 */
export async function newScrapingContext(browser, opts = {}) {
  return browser.newContext({
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
    locale: opts.locale || "en-US",
    userAgent: USER_AGENT,
    viewport: DEFAULT_VIEWPORT,
  });
}

/**
 * Interactive login: open URL, wait for Enter, save storage state.
 * @param {{ loginUrl: string, sessionPath: string, prompt: string[] }} opts
 */
export async function interactiveLogin(opts) {
  const browser = await launchBrowser({ headless: false });
  try {
    const context = await newScrapingContext(browser);
    const page = await context.newPage();
    await page.goto(opts.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    for (const line of opts.prompt || []) console.log(line);
    await waitForEnter();
    await context.storageState({ path: opts.sessionPath });
    console.log(`feeds: Session saved to ${opts.sessionPath}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

/**
 * Launch browser with saved session and run `fn(page)`.
 * @template T
 * @param {{ sessionPath: string, headless?: boolean, missingSessionError: string }} opts
 * @param {(page: import('playwright').Page) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSessionPage(opts, fn) {
  const { existsSync } = await import("node:fs");
  if (!existsSync(opts.sessionPath)) {
    throw new Error(opts.missingSessionError);
  }

  const browser = await launchBrowser({ headless: opts.headless ?? true });
  try {
    const context = await newScrapingContext(browser, {
      storageState: opts.sessionPath,
    });
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Scroll a page and harvest URLs until target count or stagnant rounds.
 * @param {import('playwright').Page} page
 * @param {{
 *   target: number,
 *   maxRounds?: number,
 *   wheelDelta?: number,
 *   waitMs?: number,
 *   evaluate: () => Promise<string[]>,
 *   onRound?: () => Promise<void>,
 * }} opts
 * @returns {Promise<string[]>}
 */
export async function scrollHarvest(page, opts) {
  const target = opts.target;
  const maxRounds = opts.maxRounds ?? 25;
  const wheelDelta = opts.wheelDelta ?? 3200;
  const waitMs = opts.waitMs ?? 1500;
  const ordered = [];
  const seen = new Set();
  let stagnant = 0;

  const harvest = async () => {
    const found = await opts.evaluate();
    for (const u of found || []) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      ordered.push(u);
    }
  };

  await harvest();
  for (let i = 0; i < maxRounds && ordered.length < target; i++) {
    const before = ordered.length;
    await page.mouse.wheel(0, wheelDelta);
    await page.waitForTimeout(waitMs);
    if (opts.onRound) await opts.onRound();
    await harvest();
    if (ordered.length === before) stagnant++;
    else stagnant = 0;
    if (stagnant >= 4) break;
  }
  return ordered;
}
