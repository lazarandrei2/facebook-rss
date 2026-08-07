package rssfeed

import (
	"fmt"
	"strings"
	"time"

	"facebook-rss/internal/config"
	"facebook-rss/internal/store"

	"github.com/gorilla/feeds"
)

func Build(cfg config.Feed, posts []store.Post) (string, error) {
	now := time.Now()
	feed := &feeds.Feed{
		Title:       cfg.Title,
		Link:        &feeds.Link{Href: cfg.Link},
		Description: cfg.Description,
		Created:     now,
	}

	items := make([]*feeds.Item, 0, len(posts))
	for _, p := range posts {
		title := p.Title
		if title == "" {
			title = fmt.Sprintf("Post from %s", p.ProfileName)
		}
		items = append(items, &feeds.Item{
			Id:          p.ID,
			Title:       title,
			Link:        &feeds.Link{Href: p.URL},
			Description: plainSummary(p.Content),
			Content:     p.Content,
			Author:      &feeds.Author{Name: p.ProfileName},
			Created:     p.PublishedAt,
			Updated:     p.FetchedAt,
		})
	}
	feed.Items = items

	rss, err := feed.ToRss()
	if err != nil {
		return "", fmt.Errorf("encode rss: %w", err)
	}
	return rss, nil
}

func plainSummary(htmlBody string) string {
	s := htmlBody
	for _, tag := range []string{"<p>", "</p>", "<br>", "<br/>", "<br />"} {
		s = strings.ReplaceAll(s, tag, "\n")
	}
	// Strip remaining tags roughly.
	for {
		start := strings.IndexByte(s, '<')
		if start < 0 {
			break
		}
		end := strings.IndexByte(s[start:], '>')
		if end < 0 {
			break
		}
		s = s[:start] + s[start+end+1:]
	}
	s = strings.TrimSpace(s)
	if len([]rune(s)) > 280 {
		return string([]rune(s)[:277]) + "..."
	}
	return s
}
