// Package secrets loads the Notion token and database id.
// Production reads SSM SecureString. sam local may set the env vars instead.
// Neither value is returned to the browser.
package secrets

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

const defaultTTL = 5 * time.Minute

// Pair is the server-side Notion configuration.
type Pair struct {
	Token      string
	DatabaseID string
}

// Getter reads one SSM parameter. WithDecryption is always requested.
type Getter interface {
	GetParameter(ctx context.Context, name string) (string, error)
}

type cached struct {
	expiresAt  time.Time
	token      string
	databaseID string
}

// Loader caches SSM values in memory for a few minutes.
type Loader struct {
	get   Getter
	now   func() time.Time
	ttl   time.Duration
	mu    sync.Mutex
	cache *cached
}

// NewLoader uses SSM when the direct env vars are absent.
func NewLoader(get Getter, now func() time.Time) *Loader {
	if now == nil {
		now = time.Now
	}
	return &Loader{get: get, now: now, ttl: defaultTTL}
}

// Load returns the token. Direct env vars win and do not call SSM.
func (l *Loader) Load(ctx context.Context, getenv func(string) string) (Pair, error) {
	directToken := strings.TrimSpace(getenv("NOTION_TOKEN"))
	directDatabase := strings.TrimSpace(getenv("NOTION_DATABASE_ID"))
	if directToken != "" && directDatabase != "" {
		return Pair{Token: directToken, DatabaseID: directDatabase}, nil
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if l.cache != nil && now.Before(l.cache.expiresAt) {
		return Pair{Token: l.cache.token, DatabaseID: l.cache.databaseID}, nil
	}

	tokenName := strings.TrimSpace(getenv("NOTION_TOKEN_PARAM"))
	databaseName := strings.TrimSpace(getenv("NOTION_DATABASE_ID_PARAM"))
	if tokenName == "" || databaseName == "" || l.get == nil {
		return Pair{}, errors.New("Notion の設定がありません")
	}
	token, err := l.get.GetParameter(ctx, tokenName)
	if err != nil {
		return Pair{}, err
	}
	databaseID, err := l.get.GetParameter(ctx, databaseName)
	if err != nil {
		return Pair{}, err
	}
	token = strings.TrimSpace(token)
	databaseID = strings.TrimSpace(databaseID)
	if token == "" || databaseID == "" {
		return Pair{}, errors.New("Notion の設定がありません")
	}
	l.cache = &cached{expiresAt: now.Add(l.ttl), token: token, databaseID: databaseID}
	return Pair{Token: token, DatabaseID: databaseID}, nil
}

// SetTTL overrides the memory lifetime. Tests use a short value.
func (l *Loader) SetTTL(ttl time.Duration) { l.ttl = ttl }

// Configured reports whether a token location is named. It does not read the value.
func Configured(getenv func(string) string) bool {
	direct := strings.TrimSpace(getenv("NOTION_TOKEN")) != "" && strings.TrimSpace(getenv("NOTION_DATABASE_ID")) != ""
	named := strings.TrimSpace(getenv("NOTION_TOKEN_PARAM")) != "" && strings.TrimSpace(getenv("NOTION_DATABASE_ID_PARAM")) != ""
	return direct || named
}
