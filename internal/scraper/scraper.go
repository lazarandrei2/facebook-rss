package scraper

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"html"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"facebook-rss/internal/config"
	"facebook-rss/internal/store"

	"github.com/mxschmitt/playwright-go"
)

type Scraper struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Scraper {
	return &Scraper{cfg: cfg}
}

// Login opens a visible browser so you can sign in to Facebook, then saves the session.
func (s *Scraper) Login() error {
	pw, browser, err := s.launch(false)
	if err != nil {
		return err
	}
	defer pw.Stop()
	defer browser.Close()

	context, err := browser.NewContext()
	if err != nil {
		return fmt.Errorf("new context: %w", err)
	}
	defer context.Close()

	page, err := context.NewPage()
	if err != nil {
		return fmt.Errorf("new page: %w", err)
	}

	if _, err := page.Goto("https://www.facebook.com/login", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60_000),
	}); err != nil {
		return fmt.Errorf("goto login: %w", err)
	}

	log.Println("Log in to Facebook in the opened browser window.")
	log.Println("When your news feed is visible, return here and press Enter.")
	fmt.Scanln()

	if _, err := context.StorageState(playwright.BrowserContextStorageStateOptions{
		Path: playwright.String(s.cfg.SessionPath),
	}); err != nil {
		return fmt.Errorf("save session: %w", err)
	}
	log.Printf("Session saved to %s", s.cfg.SessionPath)
	return nil
}

// FetchLatest scrapes the newest posts for each configured profile.
func (s *Scraper) FetchLatest() ([]store.Post, error) {
	if _, err := os.Stat(s.cfg.SessionPath); err != nil {
		return nil, fmt.Errorf("session not found at %s; run: facebook-rss login", s.cfg.SessionPath)
	}

	pw, browser, err := s.launch(s.cfg.Headless)
	if err != nil {
		return nil, err
	}
	defer pw.Stop()
	defer browser.Close()

	context, err := browser.NewContext(playwright.BrowserNewContextOptions{
		StorageStatePath: playwright.String(s.cfg.SessionPath),
		Locale:           playwright.String("en-US"),
		UserAgent: playwright.String(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		),
		Viewport: &playwright.Size{Width: 1280, Height: 900},
	})
	if err != nil {
		return nil, fmt.Errorf("new context: %w", err)
	}
	defer context.Close()

	page, err := context.NewPage()
	if err != nil {
		return nil, fmt.Errorf("new page: %w", err)
	}

	var all []store.Post
	seenContent := map[string]bool{}
	for _, profile := range s.cfg.Profiles {
		posts, err := s.fetchProfile(page, profile)
		if err != nil {
			log.Printf("warn: %s: %v", profile.URL, err)
			continue
		}
		for _, p := range posts {
			key := contentKey(p.Title, p.Content)
			if key != "" && seenContent[key] {
				log.Printf("skip duplicate content: %s", p.URL)
				continue
			}
			if key != "" {
				seenContent[key] = true
			}
			all = append(all, p)
		}
	}
	return all, nil
}

func (s *Scraper) launch(headless bool) (*playwright.Playwright, playwright.Browser, error) {
	if err := playwright.Install(); err != nil {
		return nil, nil, fmt.Errorf("install playwright browsers: %w", err)
	}

	pw, err := playwright.Run()
	if err != nil {
		return nil, nil, fmt.Errorf("start playwright: %w", err)
	}

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(headless),
	})
	if err != nil {
		_ = pw.Stop()
		return nil, nil, fmt.Errorf("launch chromium: %w", err)
	}
	return pw, browser, nil
}

type rawPost struct {
	URL    string
	Text   string
	Images []string
}

func (s *Scraper) fetchProfile(page playwright.Page, profile config.Profile) ([]store.Post, error) {
	urls, err := s.collectPostURLs(page, profile)
	if err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("no posts found (login expired, profile private, or DOM changed)")
	}

	limit := s.cfg.MaxPosts
	if limit <= 0 {
		limit = 15
	}
	if len(urls) > limit {
		urls = urls[:limit]
	}
	log.Printf("%s: opening %d posts", profile.Name, len(urls))

	now := time.Now().UTC()
	posts := make([]store.Post, 0, len(urls))
	seenURL := map[string]bool{}
	seenContent := map[string]bool{}

	for i, rawURL := range urls {
		permalink := normalizePostURL(rawURL)
		if permalink == "" || seenURL[permalink] {
			continue
		}
		seenURL[permalink] = true

		full, err := s.fetchPostPage(page, permalink, profile)
		if err != nil {
			log.Printf("warn: open post %s: %v", permalink, err)
			continue
		}
		text := cleanText(full.Text)
		images := uniqueNonEmpty(full.Images)
		if !isUsefulPost(text, images, permalink, profile.Name) {
			log.Printf("warn: skip thin post %s", permalink)
			continue
		}

		title := makeTitle(text, profile.Name)
		content := renderHTML(text, images, permalink)
		key := contentKey(title, content)
		if key != "" && seenContent[key] {
			log.Printf("skip duplicate content: %s", permalink)
			continue
		}
		if key != "" {
			seenContent[key] = true
		}

		// Keep discovery order (top of timeline = newest).
		published := now.Add(-time.Duration(i) * time.Minute)
		posts = append(posts, store.Post{
			ID:          hashID(permalink),
			ProfileURL:  profile.URL,
			ProfileName: strings.TrimSpace(profile.Name),
			Title:       title,
			Content:     content,
			URL:         permalink,
			PublishedAt: published,
			FetchedAt:   now,
		})
	}

	if len(posts) == 0 {
		return nil, fmt.Errorf("no usable posts after filtering")
	}
	return posts, nil
}

func (s *Scraper) collectPostURLs(page playwright.Page, profile config.Profile) ([]string, error) {
	slug := profileSlug(profile.URL)
	if _, err := page.Goto(profile.URL, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60_000),
	}); err != nil {
		return nil, fmt.Errorf("goto profile: %w", err)
	}
	page.WaitForTimeout(3_000)

	_, _ = page.Evaluate(`() => {
		const tabs = Array.from(document.querySelectorAll('a[role="tab"], div[role="tab"], span, a'));
		for (const el of tabs) {
			const t = (el.innerText || '').trim().toLowerCase();
			if (t === 'posts' || t === 'postări') {
				try { el.click(); } catch (_) {}
				break;
			}
		}
	}`)
	page.WaitForTimeout(2_000)

	want := s.cfg.MaxPosts
	if want <= 0 {
		want = 15
	}
	target := want + 5
	if target < 20 {
		target = 20
	}

	ordered := make([]string, 0, target)
	seen := map[string]bool{}
	stagnant := 0

	harvest := func() {
		value, err := page.Evaluate(collectPostURLsJS, slug)
		if err != nil {
			return
		}
		for _, u := range decodeStringList(value) {
			permalink := normalizePostURL(u)
			if permalink == "" || seen[permalink] {
				continue
			}
			// Only keep posts that clearly belong to this profile slug,
			// or profile-owned reels discovered from this page's anchors.
			if !belongsToProfile(permalink, slug) {
				continue
			}
			seen[permalink] = true
			ordered = append(ordered, permalink)
		}
	}

	harvest()
	for i := 0; i < 25 && len(ordered) < target; i++ {
		before := len(ordered)
		_ = page.Mouse().Wheel(0, 3200)
		page.WaitForTimeout(1_500)
		_, _ = page.Evaluate(`() => {
			for (const el of document.querySelectorAll('div[role="button"], a, span')) {
				const t = (el.innerText || '').trim().toLowerCase();
				if (t === 'see more' || t === 'vezi mai mult' || t.includes('more posts') || t.includes('mai multe')) {
					try { el.click(); } catch (_) {}
				}
			}
		}`)
		harvest()
		if len(ordered) == before {
			stagnant++
		} else {
			stagnant = 0
		}
		if stagnant >= 4 {
			break
		}
	}

	log.Printf("%s: discovered %d post urls", profile.Name, len(ordered))
	return ordered, nil
}

func (s *Scraper) fetchPostPage(page playwright.Page, permalink string, profile config.Profile) (rawPost, error) {
	if _, err := page.Goto(permalink, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60_000),
	}); err != nil {
		return rawPost{}, err
	}
	page.WaitForTimeout(3_000)

	_, _ = page.Evaluate(`() => {
		const buttons = Array.from(document.querySelectorAll('div[role="button"], span'));
		for (const el of buttons) {
			const t = (el.innerText || '').trim().toLowerCase();
			if (t === 'see more' || t === 'vezi mai mult' || t === 'see more…') {
				try { el.click(); } catch (_) {}
			}
		}
	}`)
	page.WaitForTimeout(800)

	value, err := page.Evaluate(extractPostPageJS, profile.Name)
	if err != nil {
		return rawPost{}, err
	}
	m, ok := value.(map[string]interface{})
	if !ok {
		return rawPost{URL: permalink}, nil
	}
	text, _ := m["text"].(string)
	var images []string
	if rawImages, ok := m["images"].([]interface{}); ok {
		for _, img := range rawImages {
			if s, ok := img.(string); ok && s != "" {
				images = append(images, s)
			}
		}
	}
	return rawPost{URL: permalink, Text: text, Images: images}, nil
}

// collectPostURLsJS only returns hrefs from real anchors that belong to the profile slug.
// Arg0 = profile slug.
const collectPostURLsJS = `(slug) => {
	const out = [];
	const seen = new Set();
	const slugLower = String(slug || '').toLowerCase();
	const anchors = Array.from(document.querySelectorAll('a[href]'));
	for (const a of anchors) {
		let href = a.href || '';
		if (!/facebook\.com\//.test(href)) continue;
		// Drop tracking query noise before matching.
		try { href = href.split('#')[0]; } catch (_) {}

		let path = '';
		const mPost = href.match(/facebook\.com\/([^\/?#]+)\/(?:posts|videos|permalink)\/(pfbid[A-Za-z0-9]+|\d+)/i);
		const mReel = href.match(/facebook\.com\/reel\/(\d+)/i);
		const mStory = href.match(/facebook\.com\/story\.php\?[^#]*story_fbid=([^&]+)/i);

		if (mPost) {
			const owner = mPost[1].toLowerCase();
			if (owner !== slugLower) continue;
			path = '/' + mPost[1] + '/posts/' + mPost[2];
		} else if (mReel) {
			// Reels on a profile page often use /reel/<id> without the profile slug.
			// Only accept when the anchor sits inside an article that also links to this profile.
			const article = a.closest('div[role="article"]') || a.closest('[data-pagelet]') || a.parentElement;
			const html = (article && article.innerHTML) || '';
			if (!new RegExp('facebook\\.com\\/' + slugLower + '(\\/|"|\\?|#)', 'i').test(html)
				&& !new RegExp('/' + slugLower + '(\\/|"|\\?|#)', 'i').test(html)) {
				continue;
			}
			path = '/reel/' + mReel[1];
		} else if (mStory) {
			continue; // skip opaque story.php forms; prefer /posts/pfbid links
		} else {
			continue;
		}

		const canonical = ('https://www.facebook.com' + path).replace(/\/$/, '');
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		out.push(canonical);
		if (out.length >= 40) break;
	}
	return out;
}`

// extractPostPageJS pulls the post body + images for the opened permalink only.
// Arg0 = expected author/profile name (used as a soft hint).
const extractPostPageJS = `(profileName) => {
	const decode = (raw) => raw
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t')
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\')
		.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
		.trim();

	const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	const author = norm(String(profileName || ''));

	const titleRaw = (document.title || '')
		.replace(/\s*\|\s*Facebook\s*$/i, '')
		.replace(/^\(\d+\)\s*/, '')
		.trim();

	// Title formats vary:
	//   "Teaser... - Author"
	//   "Author - Teaser..."
	//   "Teaser..."
	let titleTeaser = titleRaw;
	const dash = titleRaw.indexOf(' - ');
	if (dash >= 0) {
		const left = titleRaw.slice(0, dash).trim();
		const right = titleRaw.slice(dash + 3).trim();
		if (author && norm(left) === author) titleTeaser = right;
		else if (author && norm(right) === author) titleTeaser = left;
		else if (right.length >= left.length) titleTeaser = right;
		else titleTeaser = left;
	}
	titleTeaser = titleTeaser.replace(/\.\.\.$/, '').trim();
	if (author && norm(titleTeaser) === author) titleTeaser = '';

	const html = document.documentElement.innerHTML;
	const pfbid = (location.pathname.match(/pfbid[A-Za-z0-9]+/) || [])[0]
		|| (location.pathname.match(/\/reel\/(\d+)/) || [])[1]
		|| '';

	const texts = [];
	const re = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
	let match;
	while ((match = re.exec(html)) !== null) {
		const raw = decode(match[1]);
		if (raw.length < 12) continue;
		if (/Meta AI|Privacy Policy|Remember password|By using Meta AI|Log into Facebook/i.test(raw)) continue;
		if (author && norm(raw) === author) continue;
		texts.push({ text: raw, index: match.index });
	}

	const teaser = norm(titleTeaser).slice(0, 48);
	let text = '';

	// 1) Messages that match the document title teaser (most reliable).
	if (teaser.length >= 12) {
		const matched = texts
			.map(t => t.text)
			.filter(t => {
				const n = norm(t);
				return n.includes(teaser) || teaser.includes(n.slice(0, Math.min(40, teaser.length)));
			})
			.sort((a, b) => b.length - a.length);
		if (matched[0]) text = matched[0];
	}

	// 2) Messages near this post's id in the HTML payload.
	if (!text && pfbid) {
		const idx = html.indexOf(pfbid);
		if (idx >= 0) {
			const local = texts
				.filter(t => Math.abs(t.index - idx) < 40000)
				.map(t => t.text)
				.sort((a, b) => b.length - a.length);
			if (local[0] && local[0].length >= 20) text = local[0];
		}
	}

	// 3) Visible story text in the main article (DOM), matched to teaser when possible.
	if (!text) {
		const article = document.querySelector('div[role="article"]');
		const nodes = Array.from((article || document).querySelectorAll('div[data-ad-preview="message"], div[dir="auto"]'));
		const domTexts = nodes
			.map(el => (el.innerText || '').replace(/\s*See more\s*$/i, '').trim())
			.filter(t => t.length >= 40 && !(author && norm(t) === author));
		if (teaser.length >= 12) {
			const hit = domTexts
				.filter(t => norm(t).includes(teaser) || teaser.includes(norm(t).slice(0, Math.min(40, teaser.length))))
				.sort((a, b) => b.length - a.length);
			if (hit[0]) text = hit[0];
		}
		if (!text && domTexts[0]) {
			domTexts.sort((a, b) => b.length - a.length);
			// Prefer the longest DOM block that isn't an obvious comment/sidebar snippet
			// only when it agrees with the title teaser, or teaser is missing.
			if (teaser.length < 12 || norm(domTexts[0]).includes(teaser.slice(0, 20))) {
				text = domTexts[0];
			}
		}
	}

	// 4) Longest JSON message that agrees with teaser; else teaser alone.
	if (!text) {
		const uniq = [];
		const seen = new Set();
		for (const t of texts) {
			const key = t.text.slice(0, 80);
			if (seen.has(key)) continue;
			seen.add(key);
			uniq.push(t.text);
		}
		uniq.sort((a, b) => b.length - a.length);
		if (uniq[0] && (teaser.length < 12 || norm(uniq[0]).includes(teaser.slice(0, 20)))) {
			text = uniq[0];
		} else {
			text = titleTeaser || '';
		}
	}

	const isBadImage = (src) => {
		if (!src || src.startsWith('data:')) return true;
		if (!/scontent|fbcdn/.test(src)) return true;
		if (/emoji|static\.xx|rsrc\.php|t1\.30497-1|\/t39\.30808-1\//.test(src)) return true;
		if (/ctp=s(32|40|50|64|80|100|120)x/.test(src)) return true;
		return false;
	};

	const images = [];
	const seenImg = new Set();
	const pushImg = (src) => {
		if (!src || isBadImage(src) || seenImg.has(src)) return;
		seenImg.add(src);
		images.push(src);
	};

	const og = document.querySelector('meta[property="og:image"]');
	if (og && og.content) pushImg(og.content);

	// Large DOM images: prefer the first article, then the whole page.
	const scopes = [];
	const article = document.querySelector('div[role="article"]');
	if (article) scopes.push(article);
	scopes.push(document);

	for (const scope of scopes) {
		const ranked = Array.from(scope.querySelectorAll('img'))
			.map(img => {
				const src = img.currentSrc || img.src || '';
				const w = Number(img.naturalWidth || img.width || 0);
				const h = Number(img.naturalHeight || img.height || 0);
				return { src, w, h, area: w * h };
			})
			.filter(x => !isBadImage(x.src) && x.w >= 240 && x.h >= 240)
			.sort((a, b) => b.area - a.area);
		for (const x of ranked) {
			pushImg(x.src);
			if (images.length >= 4) break;
		}
		if (images.length) break;
	}

	// JSON photo URIs near the post id as a backup.
	if (!images.length && pfbid) {
		const idx = html.indexOf(pfbid);
		const window = idx >= 0 ? html.slice(Math.max(0, idx - 20000), idx + 40000) : html;
		const uriRe = /"(?:uri|url|image_uri|photo_image|preview_image)"\s*:\s*"(https:\\\/\\\/[^"]+scontent[^"]+)"/g;
		let um;
		while ((um = uriRe.exec(window)) !== null) {
			const src = um[1].replace(/\\\//g, '/').replace(/\\u0025/g, '%');
			pushImg(src);
			if (images.length >= 4) break;
		}
	}

	return { text, images: images.slice(0, 4), titleTeaser };
}`

func decodeStringList(value interface{}) []string {
	arr, ok := value.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

var (
	unreadPrefix   = regexp.MustCompile(`(?i)^unread\s*`)
	videosToPosts  = regexp.MustCompile(`(?i)^/([^/]+)/(?:videos|permalink)/((?:pfbid)?[A-Za-z0-9]+)$`)
)

func profileSlug(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return strings.Trim(raw, "/")
	}
	path := strings.Trim(u.Path, "/")
	if path == "" {
		return "profile.php"
	}
	// Keep first path segment (username / page slug).
	if i := strings.IndexByte(path, '/'); i >= 0 {
		path = path[:i]
	}
	return path
}

func belongsToProfile(permalink, slug string) bool {
	u, err := url.Parse(permalink)
	if err != nil {
		return false
	}
	path := strings.Trim(u.Path, "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 {
		return false
	}
	// /reel/<id> accepted when discovered from that profile's page context.
	if parts[0] == "reel" {
		return true
	}
	return strings.EqualFold(parts[0], slug)
}

func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = unreadPrefix.ReplaceAllString(s, "")
	s = strings.Map(func(r rune) rune {
		switch r {
		case '\u200b', '\u200c', '\u200d', '\ufeff', '\u2060':
			return -1
		default:
			return r
		}
	}, s)
	return strings.TrimSpace(s)
}

func normalizePostURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if !strings.Contains(u.Host, "facebook.com") {
		return ""
	}
	path := strings.TrimRight(u.Path, "/")
	if path == "" || path == "/reel" {
		return ""
	}
	// Canonicalize /videos/ and /permalink/ to /posts/ when pfbid/id present.
	if m := videosToPosts.FindStringSubmatch(path); len(m) == 3 {
		return "https://www.facebook.com/" + m[1] + "/posts/" + m[2]
	}
	if strings.Contains(path, "/posts/") || strings.Contains(path, "/reel/") {
		return "https://www.facebook.com" + path
	}
	return ""
}

func isUsefulPost(text string, images []string, permalink, profileName string) bool {
	if permalink == "" {
		return false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" && len(images) == 0 {
		return false
	}
	if profileName != "" && strings.EqualFold(trimmed, strings.TrimSpace(profileName)) && len(images) == 0 {
		return false
	}
	if utf8.RuneCountInString(trimmed) < 12 && len(images) == 0 {
		return false
	}
	return true
}

func makeTitle(text, profileName string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		if profileName != "" {
			return profileName + " (photo/video)"
		}
		return "Facebook post"
	}
	line := text
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	line = strings.TrimSpace(line)
	runes := []rune(line)
	if len(runes) > 100 {
		return string(runes[:97]) + "..."
	}
	return line
}

func renderHTML(text string, images []string, permalink string) string {
	var b strings.Builder
	if text != "" {
		paras := strings.Split(text, "\n")
		for _, p := range paras {
			p = strings.TrimSpace(p)
			if p == "" {
				b.WriteString("<br/>\n")
				continue
			}
			b.WriteString("<p>")
			b.WriteString(html.EscapeString(p))
			b.WriteString("</p>\n")
		}
	}
	for _, img := range images {
		b.WriteString(`<p><img src="`)
		b.WriteString(html.EscapeString(img))
		b.WriteString(`" alt="" style="max-width:100%;height:auto" /></p>`)
		b.WriteByte('\n')
	}
	b.WriteString(`<p><a href="`)
	b.WriteString(html.EscapeString(permalink))
	b.WriteString(`">View on Facebook</a></p>`)
	return b.String()
}

func uniqueNonEmpty(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func contentKey(title, content string) string {
	// Fingerprint on title + first paragraph of plain text so identical bodies collapse.
	plain := content
	for {
		start := strings.IndexByte(plain, '<')
		if start < 0 {
			break
		}
		end := strings.IndexByte(plain[start:], '>')
		if end < 0 {
			break
		}
		plain = plain[:start] + " " + plain[start+end+1:]
	}
	plain = strings.Join(strings.Fields(strings.ToLower(plain)), " ")
	title = strings.Join(strings.Fields(strings.ToLower(title)), " ")
	if title == "" && plain == "" {
		return ""
	}
	// Drop the trailing "view on facebook" noise for comparison.
	plain = strings.ReplaceAll(plain, "view on facebook", "")
	sum := sha1.Sum([]byte(title + "|" + plain))
	return hex.EncodeToString(sum[:8])
}

func hashID(u string) string {
	sum := sha1.Sum([]byte(u))
	return hex.EncodeToString(sum[:])
}
