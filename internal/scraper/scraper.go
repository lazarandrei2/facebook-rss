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
	for _, profile := range s.cfg.Profiles {
		posts, err := s.fetchProfile(page, profile)
		if err != nil {
			log.Printf("warn: %s: %v", profile.URL, err)
			continue
		}
		all = append(all, posts...)
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
	seen := map[string]bool{}

	for i, rawURL := range urls {
		permalink := normalizePostURL(rawURL)
		if permalink == "" || seen[permalink] {
			continue
		}
		seen[permalink] = true

		full, err := s.fetchPostPage(page, permalink)
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

		// Keep discovery order (top of timeline = newest).
		published := now.Add(-time.Duration(i) * time.Minute)
		posts = append(posts, store.Post{
			ID:          hashID(permalink),
			ProfileURL:  profile.URL,
			ProfileName: strings.TrimSpace(profile.Name),
			Title:       makeTitle(text, profile.Name),
			Content:     renderHTML(text, images, permalink),
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
	// Collect extras so filtering still leaves enough.
	target := want + 5
	if target < 20 {
		target = 20
	}

	ordered := make([]string, 0, target)
	seen := map[string]bool{}
	stagnant := 0

	harvest := func() {
		html, err := page.Content()
		if err != nil {
			return
		}
		for _, id := range pfbidPattern.FindAllString(html, -1) {
			permalink := "https://www.facebook.com/" + slug + "/posts/" + id
			if seen[permalink] {
				continue
			}
			seen[permalink] = true
			ordered = append(ordered, permalink)
		}
		// Also keep any already-canonical post anchors.
		value, err := page.Evaluate(collectPostURLsJS)
		if err == nil {
			for _, u := range decodeStringList(value) {
				permalink := normalizePostURL(u)
				if permalink == "" || seen[permalink] {
					continue
				}
				seen[permalink] = true
				ordered = append(ordered, permalink)
			}
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

func (s *Scraper) fetchPostPage(page playwright.Page, permalink string) (rawPost, error) {
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

	value, err := page.Evaluate(extractPostPageJS)
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

const collectPostURLsJS = `() => {
	const out = [];
	const seen = new Set();
	const anchors = Array.from(document.querySelectorAll('a[href]'));
	for (const a of anchors) {
		const href = a.href || '';
		if (!/facebook\.com\//.test(href)) continue;
		const pathMatch = href.match(/facebook\.com(\/[^?#]*\/(?:posts|reel|videos)\/(?:pfbid)?[A-Za-z0-9]+)/i)
			|| href.match(/facebook\.com(\/reel\/\d+)/i)
			|| href.match(/facebook\.com(\/[^?#]*\/posts\/pfbid[A-Za-z0-9]+)/i);
		if (!pathMatch) continue;
		const canonical = 'https://www.facebook.com' + pathMatch[1].replace(/\/$/, '');
		if (seen.has(canonical)) continue;
		// Skip bare /reel tab.
		if (/\/reel\/?$/.test(canonical)) continue;
		seen.add(canonical);
		out.push(canonical);
		if (out.length >= 12) break;
	}
	return out;
}`

const extractPostPageJS = `() => {
	const decode = (raw) => raw
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t')
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\')
		.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
		.trim();

	const titleRaw = (document.title || '')
		.replace(/\s*\|\s*Facebook\s*$/i, '')
		.replace(/^\(\d+\)\s*/, '');
	// "Teaser... - Author | Facebook" or "Teaser... - Author"
	let titleTeaser = titleRaw;
	const dash = titleRaw.lastIndexOf(' - ');
	if (dash > 10) titleTeaser = titleRaw.slice(0, dash);
	titleTeaser = titleTeaser.replace(/\.\.\.$/, '').trim();

	const html = document.documentElement.innerHTML;
	const texts = [];
	const re = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
	let match;
	while ((match = re.exec(html)) !== null) {
		const raw = decode(match[1]);
		if (raw.length < 20) continue;
		if (/Meta AI|Privacy Policy|Remember password|By using Meta AI/i.test(raw)) continue;
		texts.push(raw);
	}

	const uniq = [];
	const seen = new Set();
	for (const t of texts) {
		const key = t.slice(0, 80);
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push(t);
	}

	const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	const teaser = norm(titleTeaser).slice(0, 48);

	let text = '';
	if (teaser.length >= 12) {
		const matched = uniq
			.filter(t => norm(t).includes(teaser) || teaser.includes(norm(t).slice(0, Math.min(40, teaser.length))))
			.sort((a, b) => b.length - a.length);
		if (matched.length) text = matched[0];
	}
	if (!text) {
		// Prefer message blocks that appear near this post's pfbid in the HTML.
		const pfbid = (location.pathname.match(/pfbid[A-Za-z0-9]+/) || [])[0];
		if (pfbid) {
			const idx = html.indexOf(pfbid);
			if (idx >= 0) {
				const window = html.slice(Math.max(0, idx - 8000), idx + 12000);
				const local = [];
				const re2 = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
				let m2;
				while ((m2 = re2.exec(window)) !== null) {
					const raw = decode(m2[1]);
					if (raw.length >= 20) local.push(raw);
				}
				local.sort((a, b) => b.length - a.length);
				if (local[0]) text = local[0];
			}
		}
	}
	if (!text) {
		uniq.sort((a, b) => b.length - a.length);
		text = uniq[0] || titleTeaser || '';
	}

	const isPostImage = (img) => {
		const src = img.src || '';
		if (!/scontent|fbcdn/.test(src)) return false;
		if (/emoji|static\.xx|rsrc\.php|t1\.30497-1/.test(src)) return false;
		if (/ctp=s(32|40|50|64|80|100|120)x/.test(src)) return false;
		if (/\/t39\.30808-1\//.test(src)) return false; // profile avatars
		const w = Number(img.naturalWidth || img.width || 0);
		const h = Number(img.naturalHeight || img.height || 0);
		if (w && h && (w < 200 || h < 200)) return false;
		return true;
	};

	const images = Array.from(document.querySelectorAll('img'))
		.filter(isPostImage)
		.map(img => img.src)
		.filter((src, i, arr) => arr.indexOf(src) === i)
		.slice(0, 8);

	return { text, images, titleTeaser };
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
	unreadPrefix = regexp.MustCompile(`(?i)^unread\s*`)
	pfbidPattern = regexp.MustCompile(`pfbid[A-Za-z0-9]+`)
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

func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = unreadPrefix.ReplaceAllString(s, "")
	// Strip Facebook's odd spaced-letter obfuscation leftovers if any remain.
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
	if strings.Contains(path, "/posts/") || strings.Contains(path, "/videos/") || strings.Contains(path, "/reel/") || strings.Contains(path, "/permalink/") {
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

func hashID(u string) string {
	sum := sha1.Sum([]byte(u))
	return hex.EncodeToString(sum[:])
}
