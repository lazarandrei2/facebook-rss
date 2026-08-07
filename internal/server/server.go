package server

import (
	"fmt"
	"log"
	"net/http"

	"facebook-rss/internal/config"
	"facebook-rss/internal/rssfeed"
	"facebook-rss/internal/store"
)

type Server struct {
	cfg   *config.Config
	store *store.Store
}

func New(cfg *config.Config, st *store.Store) *Server {
	return &Server{cfg: cfg, store: st}
}

func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/feed.xml", s.handleFeed)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("Serving RSS at http://localhost%s/feed.xml", s.cfg.Listen)
	return http.ListenAndServe(s.cfg.Listen, mux)
}

func (s *Server) handleFeed(w http.ResponseWriter, _ *http.Request) {
	posts, err := s.store.List(50)
	if err != nil {
		http.Error(w, "failed to load posts", http.StatusInternalServerError)
		log.Printf("list posts: %v", err)
		return
	}

	body, err := rssfeed.Build(s.cfg.Feed, posts)
	if err != nil {
		http.Error(w, "failed to build feed", http.StatusInternalServerError)
		log.Printf("build feed: %v", err)
		return
	}

	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	if _, err := fmt.Fprint(w, body); err != nil {
		log.Printf("write feed: %v", err)
	}
}
