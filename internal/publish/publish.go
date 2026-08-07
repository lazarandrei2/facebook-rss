package publish

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Feed pushes the current feed.xml to the configured git remote.
// No-op if there are no changes to commit.
func Feed(message string) error {
	if _, err := os.Stat("feed.xml"); err != nil {
		return fmt.Errorf("feed.xml not found; run fetch first: %w", err)
	}
	if message == "" {
		message = "Update feed.xml"
	}

	if err := run("git", "rev-parse", "--is-inside-work-tree"); err != nil {
		return fmt.Errorf("not a git repository")
	}

	status, err := output("git", "status", "--porcelain", "--", "feed.xml")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) == "" {
		// Still push in case a previous commit wasn't pushed.
		if err := run("git", "push"); err != nil {
			return fmt.Errorf("git push: %w", err)
		}
		return nil
	}

	if err := run("git", "add", "--", "feed.xml"); err != nil {
		return fmt.Errorf("git add: %w", err)
	}
	if err := run("git", "commit", "-m", message); err != nil {
		return fmt.Errorf("git commit: %w", err)
	}
	if err := run("git", "push"); err != nil {
		return fmt.Errorf("git push: %w", err)
	}
	return nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func output(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return buf.String(), nil
}
