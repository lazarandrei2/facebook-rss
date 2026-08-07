package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Feed struct {
	Title       string `yaml:"title"`
	Link        string `yaml:"link"`
	Description string `yaml:"description"`
}

type Profile struct {
	Name string `yaml:"name"`
	URL  string `yaml:"url"`
}

type Config struct {
	Listen       string    `yaml:"listen"`
	Headless     bool      `yaml:"headless"`
	SessionPath  string    `yaml:"session_path"`
	DatabasePath string    `yaml:"database_path"`
	MaxPosts     int       `yaml:"max_posts"` // posts to fetch per profile
	Feed         Feed      `yaml:"feed"`
	Profiles     []Profile `yaml:"profiles"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		Listen:       ":8080",
		Headless:     true,
		SessionPath:  "session.json",
		DatabasePath: "data/posts.db",
		MaxPosts:     15,
		Feed: Feed{
			Title:       "Facebook RSS",
			Link:        "http://localhost:8080/feed.xml",
			Description: "Latest posts from watched Facebook profiles",
		},
	}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.MaxPosts <= 0 {
		cfg.MaxPosts = 15
	}
	for i, p := range cfg.Profiles {
		if p.URL == "" {
			return nil, fmt.Errorf("config: profiles[%d].url is required", i)
		}
		if p.Name == "" {
			cfg.Profiles[i].Name = p.URL
		}
	}
	return cfg, nil
}

func (c *Config) RequireProfiles() error {
	if len(c.Profiles) == 0 {
		return fmt.Errorf("config: at least one profile is required")
	}
	return nil
}
