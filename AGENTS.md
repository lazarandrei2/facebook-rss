# AGENTS.md

## Cursor Cloud specific instructions

`facebook-rss` is a single Node.js (ESM) CLI product that scrapes public Facebook
profiles into an RSS 2.0 feed. Posts are stored in an embedded SQLite database and
either served over HTTP or published to GitHub Pages. There is no separate
frontend/backend, no external database server, and no Docker.

### Runtime

- Requires Node.js `>=22` (see `package.json` `engines`). The store uses the
  built-in `node:sqlite` module (`DatabaseSync`), which only exists in Node 22+.
- `npm install` (run by the update script) is all that is needed to run the tests
  and the HTTP server. It does NOT download the Playwright browser binary.

### Commands (all defined as npm scripts in `package.json`)

- Tests: `npm test` (runs `test/media.test.js`, plain `node:assert` tests).
- Serve the feed over HTTP: `npm run serve` (listens on port `8080`; endpoints
  `GET /feed.xml`, `GET /` and `GET /healthz`).
- Scrape + build feed: `npm run fetch` (add `--push` to commit/push `feed.xml`).
- Interactive login: `npm run login`. Publish only: `npm run publish`.
- There is no lint tooling configured in this repo.

### Non-obvious caveats

- Config: commands read `config.yaml`, which is gitignored. Copy it from
  `config.example.yaml` before running (`cp config.example.yaml config.yaml`).
- `serve` reads posts from the SQLite DB (`data/posts.db` by default), NOT from the
  committed `feed.xml`. On a fresh checkout the DB is empty, so the served feed will
  be empty until `fetch` (or seeding) populates the store. `data/` and `*.db` are
  gitignored.
- The scraping flow (`login`/`fetch`) needs the Playwright Chromium browser binary,
  which `npm install` does NOT fetch — run `npx playwright install chromium` (and,
  for a real environment, `npx playwright install-deps`) first. `login` launches a
  non-headless Chromium and requires a display plus real Facebook credentials, so
  the end-to-end scraping path cannot run unattended/headless in cloud. To exercise
  the store -> RSS -> HTTP pipeline without Facebook, seed a post via `lib/store.js`'s
  `openStore(...).upsert(...)` and then `npm run serve`.
