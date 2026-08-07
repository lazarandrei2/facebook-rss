package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Post struct {
	ID          string
	ProfileURL  string
	ProfileName string
	Title       string
	Content     string
	URL         string
	PublishedAt time.Time
	FetchedAt   time.Time
}

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create database dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS posts (
			id TEXT PRIMARY KEY,
			profile_url TEXT NOT NULL,
			profile_name TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			url TEXT NOT NULL,
			published_at TEXT NOT NULL,
			fetched_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC);
	`)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// Upsert inserts or refreshes a post. Returns true when newly inserted.
func (s *Store) Upsert(p Post) (bool, error) {
	if p.FetchedAt.IsZero() {
		p.FetchedAt = time.Now().UTC()
	}
	if p.PublishedAt.IsZero() {
		p.PublishedAt = p.FetchedAt
	}

	var exists int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM posts WHERE id = ?`, p.ID).Scan(&exists); err != nil {
		return false, fmt.Errorf("lookup post: %w", err)
	}

	if exists == 0 {
		_, err := s.db.Exec(`
			INSERT INTO posts (
				id, profile_url, profile_name, title, content, url, published_at, fetched_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
			p.ID,
			p.ProfileURL,
			p.ProfileName,
			p.Title,
			p.Content,
			p.URL,
			p.PublishedAt.UTC().Format(time.RFC3339),
			p.FetchedAt.UTC().Format(time.RFC3339),
		)
		if err != nil {
			return false, fmt.Errorf("insert post: %w", err)
		}
		return true, nil
	}

	_, err := s.db.Exec(`
		UPDATE posts
		SET profile_url = ?, profile_name = ?, title = ?, content = ?, url = ?, fetched_at = ?
		WHERE id = ?
	`,
		p.ProfileURL,
		p.ProfileName,
		p.Title,
		p.Content,
		p.URL,
		p.FetchedAt.UTC().Format(time.RFC3339),
		p.ID,
	)
	if err != nil {
		return false, fmt.Errorf("update post: %w", err)
	}
	return false, nil
}

func (s *Store) Clear() error {
	_, err := s.db.Exec(`DELETE FROM posts`)
	if err != nil {
		return fmt.Errorf("clear posts: %w", err)
	}
	return nil
}

func (s *Store) List(limit int) ([]Post, error) {
	if limit <= 0 {
		limit = 50
	}
	// Pull extra rows so content-duplicate filtering still fills the feed.
	fetchLimit := limit * 3
	if fetchLimit < 50 {
		fetchLimit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, profile_url, profile_name, title, content, url, published_at, fetched_at
		FROM posts
		ORDER BY published_at DESC
		LIMIT ?
	`, fetchLimit)
	if err != nil {
		return nil, fmt.Errorf("list posts: %w", err)
	}
	defer rows.Close()

	var posts []Post
	seenTitle := map[string]bool{}
	for rows.Next() {
		var (
			p            Post
			publishedRaw string
			fetchedRaw   string
		)
		if err := rows.Scan(
			&p.ID,
			&p.ProfileURL,
			&p.ProfileName,
			&p.Title,
			&p.Content,
			&p.URL,
			&publishedRaw,
			&fetchedRaw,
		); err != nil {
			return nil, err
		}
		p.PublishedAt, err = time.Parse(time.RFC3339, publishedRaw)
		if err != nil {
			return nil, fmt.Errorf("parse published_at: %w", err)
		}
		p.FetchedAt, err = time.Parse(time.RFC3339, fetchedRaw)
		if err != nil {
			return nil, fmt.Errorf("parse fetched_at: %w", err)
		}
		key := strings.ToLower(strings.Join(strings.Fields(p.Title), " "))
		if key != "" {
			if seenTitle[key] {
				continue
			}
			seenTitle[key] = true
		}
		posts = append(posts, p)
		if len(posts) >= limit {
			break
		}
	}
	return posts, rows.Err()
}
