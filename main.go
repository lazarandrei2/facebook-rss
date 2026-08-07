package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"facebook-rss/internal/config"
	"facebook-rss/internal/publish"
	"facebook-rss/internal/rssfeed"
	"facebook-rss/internal/scraper"
	"facebook-rss/internal/server"
	"facebook-rss/internal/store"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("facebook-rss: ")

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	configPath := fs.String("config", "config.yaml", "path to config file")
	push := fs.Bool("push", false, "after fetch, commit and push feed.xml to GitHub Pages")
	_ = fs.Parse(os.Args[2:])

	switch cmd {
	case "login":
		cfg, err := config.Load(*configPath)
		must(err)
		must(scraper.New(cfg).Login())

	case "fetch":
		cfg, err := config.Load(*configPath)
		must(err)
		must(cfg.RequireProfiles())
		st, err := store.Open(cfg.DatabasePath)
		must(err)
		defer st.Close()

		posts, err := scraper.New(cfg).FetchLatest()
		must(err)

		var added int
		for _, p := range posts {
			ok, err := st.Upsert(p)
			must(err)
			if ok {
				added++
				log.Printf("new: %s (%s)", p.Title, p.URL)
			}
		}
		log.Printf("fetched %d posts, %d new", len(posts), added)

		// Also write a static feed.xml for simple hosting / GitHub Pages.
		all, err := st.List(50)
		must(err)
		body, err := rssfeed.Build(cfg.Feed, all)
		must(err)
		must(os.WriteFile("feed.xml", []byte(body), 0o644))
		log.Println("wrote feed.xml")

		if *push {
			must(publish.Feed("Update feed.xml"))
			log.Println("pushed feed.xml to GitHub")
		}

	case "publish":
		must(publish.Feed("Update feed.xml"))
		log.Println("pushed feed.xml to GitHub")

	case "serve":
		cfg, err := config.Load(*configPath)
		must(err)
		st, err := store.Open(cfg.DatabasePath)
		must(err)
		defer st.Close()
		must(server.New(cfg, st).Start())

	case "help", "-h", "--help":
		usage()

	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage:
  facebook-rss login   [-config config.yaml]           Interactive Facebook login; saves session.json
  facebook-rss fetch   [-config config.yaml] [-push]   Scrape profiles and update SQLite + feed.xml
  facebook-rss publish                                 Commit and push feed.xml (GitHub Pages)
  facebook-rss serve   [-config config.yaml]           Serve GET /feed.xml for Tapestry

Typical cron (GitHub Pages):
  */15 * * * * cd /path/to/facebook-rss && ./facebook-rss fetch -push
`)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
