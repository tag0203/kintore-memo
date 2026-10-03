// Package cache is the short-TTL Notion response cache.
// Navigation still uses the browser cache. This only collapses repeated bootstraps.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/syntax"
)

// Store is a process cache or the memory+DynamoDB tier.
type Store interface {
	Get(ctx context.Context, segments []string) (string, bool, error)
	Put(ctx context.Context, segments []string, body string, at time.Time) error
	Delete(ctx context.Context, segments []string) error
	DeleteWhere(ctx context.Context, predicate func(key string) bool) error
}

// Remote is GetItem / PutItem / DeleteItem. Tests pass a fake.
type Remote interface {
	Get(ctx context.Context, table, pk, sk string, dest any) (bool, error)
	Put(ctx context.Context, table string, item any) error
	Delete(ctx context.Context, table, pk, sk string) error
}

type entry struct {
	body string
	ttl  int64
}

// Memory is the process-local cache. A cold start drops it.
type Memory struct {
	now   func() time.Time
	mu    sync.Mutex
	items map[string]entry
}

// NewMemory returns an empty cache. now defaults to time.Now.
func NewMemory(now func() time.Time) *Memory {
	if now == nil {
		now = time.Now
	}
	return &Memory{now: now, items: map[string]entry{}}
}

func (m *Memory) live(segments []string) (entry, bool, error) {
	key, err := cacheKey(segments)
	if err != nil {
		return entry{}, false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	found, ok := m.items[key]
	if !ok {
		return entry{}, false, nil
	}
	if found.ttl <= m.now().UTC().Unix() {
		delete(m.items, key)
		return entry{}, false, nil
	}
	return found, true, nil
}

func (m *Memory) Get(_ context.Context, segments []string) (string, bool, error) {
	found, ok, err := m.live(segments)
	if err != nil || !ok {
		return "", false, err
	}
	return found.body, true, nil
}

func (m *Memory) Put(_ context.Context, segments []string, body string, at time.Time) error {
	item, err := ddb.BuildNotionCacheItem(segments, body, at)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items[item.CacheKey] = entry{body: item.Body, ttl: item.TTL}
	return nil
}

func (m *Memory) Delete(_ context.Context, segments []string) error {
	key, err := cacheKey(segments)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
	return nil
}

func (m *Memory) DeleteWhere(_ context.Context, predicate func(string) bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key := range m.items {
		if predicate(key) {
			delete(m.items, key)
		}
	}
	return nil
}

// Dynamo is the table adapter. Callers should prefer Tiered so a miss still reaches Notion.
type Dynamo struct {
	table string
	api   Remote
	now   func() time.Time
}

// NewDynamo binds the cache to one table.
func NewDynamo(table string, api Remote, now func() time.Time) *Dynamo {
	if now == nil {
		now = time.Now
	}
	return &Dynamo{table: table, api: api, now: now}
}

func (d *Dynamo) Get(ctx context.Context, segments []string) (string, bool, error) {
	if d.table == "" {
		return "", false, errors.New("TABLE_NAME が設定されていません")
	}
	key, _, err := ddb.NotionCacheKey(segments)
	if err != nil {
		return "", false, err
	}
	var item ddb.NotionCacheItem
	found, err := d.api.Get(ctx, d.table, key.PK, key.SK, &item)
	if err != nil || !found {
		return "", false, err
	}
	record, err := ddb.ReadNotionCacheItem(item)
	if err != nil {
		return "", false, err
	}
	if record.TTL <= d.now().UTC().Unix() {
		return "", false, nil
	}
	return record.Body, true, nil
}

func (d *Dynamo) Put(ctx context.Context, segments []string, body string, at time.Time) error {
	if d.table == "" {
		return errors.New("TABLE_NAME が設定されていません")
	}
	item, err := ddb.BuildNotionCacheItem(segments, body, at)
	if err != nil {
		return err
	}
	return d.api.Put(ctx, d.table, item)
}

func (d *Dynamo) Delete(ctx context.Context, segments []string) error {
	if d.table == "" {
		return errors.New("TABLE_NAME が設定されていません")
	}
	key, _, err := ddb.NotionCacheKey(segments)
	if err != nil {
		return err
	}
	return d.api.Delete(ctx, d.table, key.PK, key.SK)
}

// Tiered reads memory, then DynamoDB. DynamoDB errors are ignored.
// Prefix deletes only cover keys this process has seen; leftovers expire after 300s.
type Tiered struct {
	memory *Memory
	dynamo *Dynamo
	mu     sync.Mutex
	known  map[string]struct{}
}

// NewTiered wraps memory and DynamoDB.
func NewTiered(memory *Memory, dynamo *Dynamo) *Tiered {
	return &Tiered{memory: memory, dynamo: dynamo, known: map[string]struct{}{}}
}

func (t *Tiered) Get(ctx context.Context, segments []string) (string, bool, error) {
	local, ok, err := t.memory.Get(ctx, segments)
	if err != nil || ok {
		return local, ok, err
	}
	remote, ok, err := t.dynamo.Get(ctx, segments)
	if err != nil {
		warnCache(err)
		return "", false, nil
	}
	if ok {
		key, keyErr := cacheKey(segments)
		if keyErr == nil {
			t.mu.Lock()
			t.known[key] = struct{}{}
			t.mu.Unlock()
		}
		if putErr := t.memory.Put(ctx, segments, remote, t.memory.now()); putErr != nil {
			// An oversized body is still returned to the caller.
		}
	}
	return remote, ok, nil
}

func (t *Tiered) Put(ctx context.Context, segments []string, body string, at time.Time) error {
	if err := t.memory.Put(ctx, segments, body, at); err != nil {
		return err
	}
	if key, err := cacheKey(segments); err == nil {
		t.mu.Lock()
		t.known[key] = struct{}{}
		t.mu.Unlock()
	}
	if err := t.dynamo.Put(ctx, segments, body, at); err != nil {
		warnCache(err)
	}
	return nil
}

func (t *Tiered) Delete(ctx context.Context, segments []string) error {
	if key, err := cacheKey(segments); err == nil {
		t.mu.Lock()
		delete(t.known, key)
		t.mu.Unlock()
	}
	if err := t.memory.Delete(ctx, segments); err != nil {
		return err
	}
	if err := t.dynamo.Delete(ctx, segments); err != nil {
		warnCache(err)
	}
	return nil
}

func (t *Tiered) DeleteWhere(ctx context.Context, predicate func(string) bool) error {
	t.mu.Lock()
	keys := make([]string, 0)
	for key := range t.known {
		if predicate(key) {
			keys = append(keys, key)
			delete(t.known, key)
		}
	}
	t.mu.Unlock()
	if err := t.memory.DeleteWhere(ctx, predicate); err != nil {
		return err
	}
	for _, key := range keys {
		if err := t.dynamo.Delete(ctx, splitHash(key)); err != nil {
			warnCache(err)
		}
	}
	return nil
}

// JSON collapses identical in-flight loads and stores {"v": value}.
type JSON struct {
	store    Store
	now      func() time.Time
	mu       sync.Mutex
	inflight map[string]*flight
}

type flight struct {
	done chan struct{}
	body string
	err  error
}

// NewJSON wraps a store. now is the timestamp written into new items.
func NewJSON(store Store, now func() time.Time) *JSON {
	if now == nil {
		now = time.Now
	}
	return &JSON{store: store, now: now, inflight: map[string]*flight{}}
}

// GetOrLoad returns the cached value or calls load once for this key.
func GetOrLoad[T any](ctx context.Context, c *JSON, segments []string, load func(context.Context) (T, error)) (T, error) {
	var zero T
	raw, err := c.do(ctx, joinZero(segments), func(ctx context.Context) (string, error) {
		body, ok, err := c.store.Get(ctx, segments)
		if err != nil {
			return "", err
		}
		if ok {
			return body, nil
		}
		value, err := load(ctx)
		if err != nil {
			return "", err
		}
		encoded, err := json.Marshal(struct {
			V T `json:"v"`
		}{V: value})
		if err != nil {
			return "", err
		}
		if err := c.store.Put(ctx, segments, string(encoded), c.now()); err != nil {
			var invalid *ddb.ItemValidationError
			if !errors.As(err, &invalid) {
				warnCache(err)
			}
		}
		return string(encoded), nil
	})
	if err != nil {
		return zero, err
	}
	var env struct {
		V T `json:"v"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return zero, &syntax.Error{Err: err}
	}
	return env.V, nil
}

func (c *JSON) Delete(ctx context.Context, segments []string) error {
	return c.store.Delete(ctx, segments)
}

func (c *JSON) DeleteWhere(ctx context.Context, predicate func(string) bool) error {
	return c.store.DeleteWhere(ctx, predicate)
}

func (c *JSON) do(ctx context.Context, key string, fn func(context.Context) (string, error)) (string, error) {
	c.mu.Lock()
	if existing, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-existing.done:
			return existing.body, existing.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	current := &flight{done: make(chan struct{})}
	c.inflight[key] = current
	c.mu.Unlock()

	body, err := fn(ctx)
	current.body = body
	current.err = err
	close(current.done)

	c.mu.Lock()
	delete(c.inflight, key)
	c.mu.Unlock()
	return body, err
}

func cacheKey(segments []string) (string, error) {
	_, key, err := ddb.NotionCacheKey(segments)
	return key, err
}

func warnCache(err error) {
	log.Printf("[notion-cache] %T", err)
}

func joinZero(segments []string) string {
	out := ""
	for i, segment := range segments {
		if i > 0 {
			out += "\x00"
		}
		out += segment
	}
	return out
}

func splitHash(key string) []string {
	parts := make([]string, 0, 4)
	start := 0
	for i := 0; i < len(key); i++ {
		if key[i] == '#' {
			parts = append(parts, key[start:i])
			start = i + 1
		}
	}
	return append(parts, key[start:])
}
