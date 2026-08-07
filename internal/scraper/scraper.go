package scraper

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

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
	URL     string `json:"url"`
	Content string `json:"content"`
}

func (s *Scraper) fetchProfile(page playwright.Page, profile config.Profile) ([]store.Post, error) {
	if _, err := page.Goto(profile.URL, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60_000),
	}); err != nil {
		return nil, fmt.Errorf("goto profile: %w", err)
	}

	// Give the timeline a moment to hydrate.
	page.WaitForTimeout(3_000)

	value, err := page.Evaluate(`() => {
		const out = [];
		const seen = new Set();

		const anchors = Array.from(document.querySelectorAll('a[href]'));
		for (const a of anchors) {
			const href = a.href || '';
			if (!/facebook\.com\//.test(href)) continue;
			if (!/(\/posts\/|\/permalink\/|story_fbid=|\/reel\/)/.test(href)) continue;

			const url = href.split('?')[0];
			if (seen.has(url)) continue;
			seen.add(url);

			let root = a.closest('div[role="article"]') || a.closest('[data-ad-preview="message"]') || a.parentElement;
			let content = '';
			if (root) {
				const textNode = root.querySelector('[data-ad-preview="message"], [dir="auto"]');
				content = (textNode && textNode.innerText ? textNode.innerText : root.innerText || '').trim();
			}
			if (content.length > 500) content = content.slice(0, 500);

			out.push({ url, content });
			if (out.length >= 5) break;
		}
		return out;
	}`)
	if err != nil {
		return nil, fmt.Errorf("extract posts: %w", err)
	}

	items, err := decodeRawPosts(value)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no posts found (login expired, profile private, or DOM changed)")
	}

	now := time.Now().UTC()
	posts := make([]store.Post, 0, len(items))
	for _, item := range items {
		content := strings.TrimSpace(item.Content)
		title := firstLine(content)
		posts = append(posts, store.Post{
			ID:          hashID(item.URL),
			ProfileURL:  profile.URL,
			ProfileName: profile.Name,
			Title:       title,
			Content:     content,
			URL:         item.URL,
			PublishedAt: now,
			FetchedAt:   now,
		})
	}
	return posts, nil
}

func decodeRawPosts(value interface{}) ([]rawPost, error) {
	arr, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected evaluate result type %T", value)
	}
	out := make([]rawPost, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		url, _ := m["url"].(string)
		content, _ := m["content"].(string)
		if url == "" {
			continue
		}
		out = append(out, rawPost{URL: url, Content: content})
	}
	return out, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "Facebook post"
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 80 {
		return s[:77] + "..."
	}
	return s
}

func hashID(url string) string {
	sum := sha1.Sum([]byte(url))
	return hex.EncodeToString(sum[:])
}
