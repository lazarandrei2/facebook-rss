package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
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

// Upsert inserts a post if new. Returns true when the post was newly inserted.
func (s *Store) Upsert(p Post) (bool, error) {
	if p.FetchedAt.IsZero() {
		p.FetchedAt = time.Now().UTC()
	}
	if p.PublishedAt.IsZero() {
		p.PublishedAt = p.FetchedAt
	}

	res, err := s.db.Exec(`
		INSERT OR IGNORE INTO posts (
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
		return false, fmt.Errorf("upsert post: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *Store) List(limit int) ([]Post, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, profile_url, profile_name, title, content, url, published_at, fetched_at
		FROM posts
		ORDER BY published_at DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list posts: %w", err)
	}
	defer rows.Close()

	var posts []Post
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
		posts = append(posts, p)
	}
	return posts, rows.Err()
}
