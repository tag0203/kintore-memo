package notion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/model"
)

// Backend is the Notion port the service caches in front of.
type Backend interface {
	ListExercises(ctx context.Context) ([]model.ExerciseSummary, error)
	LoadRecentWindow(ctx context.Context) (model.Window, error)
	GetPreviousLog(ctx context.Context, exercise, before string) ([]model.ExerciseLog, error)
	GetLogOnDate(ctx context.Context, exercise, date string) ([]model.ExerciseLog, error)
	CreateLog(ctx context.Context, input model.NewExerciseLog) (model.ExerciseLog, error)
}

type schema struct {
	databaseID    string
	dataSourceID  string
	titleProperty string
	properties    map[string]any
}

// Client is a Notion API 2026-03-11 client. Tokens come from the caller.
type Client struct {
	token      string
	databaseID string
	http       *http.Client
	baseURL    string

	mu      sync.Mutex
	schema  *schema
	waiters []chan result
	loading bool
}

type result struct {
	schema schema
	err    error
}

// NewClient uses the public Notion host.
func NewClient(token, databaseID string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{
		token:      token,
		databaseID: databaseID,
		http:       httpClient,
		baseURL:    "https://api.notion.com/v1",
	}
}

func (c *Client) notion(ctx context.Context, path, method string, body any) (map[string]any, error) {
	if c.token == "" {
		return nil, errors.New("NOTION_TOKEN が設定されていません")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Notion-Version", version)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	payload := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			if response.StatusCode >= 300 {
				return nil, errString("Notion API: HTTP " + itoa(response.StatusCode))
			}
			return nil, errString("Notion API: invalid JSON")
		}
	}
	if response.StatusCode >= 300 {
		message := "HTTP " + itoa(response.StatusCode)
		if text, ok := payload["message"].(string); ok && text != "" {
			message = text
		}
		return nil, errString("Notion API: " + message)
	}
	return payload, nil
}

func (c *Client) resolve(ctx context.Context) (schema, error) {
	if c.token == "" {
		return schema{}, errors.New("NOTION_TOKEN が設定されていません")
	}
	if c.databaseID == "" {
		return schema{}, errors.New("NOTION_DATABASE_ID が設定されていません")
	}
	c.mu.Lock()
	if c.schema != nil && c.schema.databaseID == c.databaseID {
		current := *c.schema
		c.mu.Unlock()
		return current, nil
	}
	if c.loading {
		wait := make(chan result, 1)
		c.waiters = append(c.waiters, wait)
		c.mu.Unlock()
		select {
		case got := <-wait:
			if got.err != nil {
				return schema{}, got.err
			}
			return got.schema, nil
		case <-ctx.Done():
			return schema{}, ctx.Err()
		}
	}
	c.loading = true
	c.mu.Unlock()

	loaded, err := c.loadSchema(ctx)

	c.mu.Lock()
	c.loading = false
	if err == nil {
		c.schema = &loaded
	}
	waiters := c.waiters
	c.waiters = nil
	c.mu.Unlock()
	for _, wait := range waiters {
		wait <- result{schema: loaded, err: err}
	}
	return loaded, err
}

func (c *Client) loadSchema(ctx context.Context) (schema, error) {
	database, err := c.notion(ctx, "/databases/"+c.databaseID, http.MethodGet, nil)
	if err != nil {
		return schema{}, err
	}
	dataSourceID := ""
	if sources, ok := database["data_sources"].([]any); ok && len(sources) > 0 {
		if first, ok := sources[0].(map[string]any); ok {
			dataSourceID, _ = first["id"].(string)
		}
	}
	if dataSourceID == "" {
		return schema{}, errors.New("データベースにデータソースがありません")
	}
	source, err := c.notion(ctx, "/data_sources/"+dataSourceID, http.MethodGet, nil)
	if err != nil {
		return schema{}, err
	}
	props, _ := source["properties"].(map[string]any)
	if props == nil {
		props = map[string]any{}
	}
	title, err := AssertWorkoutSchema(props)
	if err != nil {
		return schema{}, err
	}
	return schema{
		databaseID:    c.databaseID,
		dataSourceID:  dataSourceID,
		titleProperty: title,
		properties:    props,
	}, nil
}

func (c *Client) query(ctx context.Context, body map[string]any) (schema, []map[string]any, bool, string, error) {
	source, err := c.resolve(ctx)
	if err != nil {
		return schema{}, nil, false, "", err
	}
	result, err := c.notion(ctx, "/data_sources/"+source.dataSourceID+"/query", http.MethodPost, body)
	if err != nil {
		return schema{}, nil, false, "", err
	}
	pages := make([]map[string]any, 0)
	if raw, ok := result["results"].([]any); ok {
		for _, item := range raw {
			if page, ok := item.(map[string]any); ok {
				pages = append(pages, page)
			}
		}
	}
	hasMore, _ := result["has_more"].(bool)
	next, _ := result["next_cursor"].(string)
	return source, pages, hasMore, next, nil
}

func logsFrom(source schema, pages []map[string]any) []model.ExerciseLog {
	logs := make([]model.ExerciseLog, 0, len(pages))
	for _, page := range pages {
		if log := PageToLog(page, source.titleProperty); log != nil {
			logs = append(logs, *log)
		}
	}
	return logs
}

// ListExercises returns select options. lastPickedAt stays null.
func (c *Client) ListExercises(ctx context.Context) ([]model.ExerciseSummary, error) {
	source, err := c.resolve(ctx)
	if err != nil {
		return nil, err
	}
	names := ExerciseNamesFromSchema(source.properties)
	out := make([]model.ExerciseSummary, 0, len(names))
	for _, name := range names {
		out = append(out, model.ExerciseSummary{Name: name})
	}
	return out, nil
}

// LoadRecentWindow is one query for the newest logs.
// Complete is false when older pages exist, so a missing row is not "no history".
func (c *Client) LoadRecentWindow(ctx context.Context) (model.Window, error) {
	source, pages, hasMore, _, err := c.query(ctx, buildRecentQuery())
	if err != nil {
		return model.Window{}, err
	}
	return model.Window{
		Logs:     logsFrom(source, pages),
		Complete: !hasMore && len(pages) < recentPageSize,
	}, nil
}

// GetPreviousLog returns every row from that exercise's latest day strictly before beforeDate.
// A later page is read only while that day continues. Older days are not included.
func (c *Client) GetPreviousLog(ctx context.Context, exercise, beforeDate string) ([]model.ExerciseLog, error) {
	var rows []model.ExerciseLog
	var day string
	cursor := ""
	for page := 0; page < maxDayPages; page++ {
		body := buildPreviousQuery(exercise, beforeDate)
		if cursor != "" {
			body["start_cursor"] = cursor
		}
		source, pages, hasMore, next, err := c.query(ctx, body)
		if err != nil {
			return nil, err
		}
		logs := logsFrom(source, pages)
		if len(logs) == 0 {
			break
		}
		if day == "" {
			day = logs[0].Date
			for _, log := range logs[1:] {
				if log.Date > day {
					day = log.Date
				}
			}
		}
		older := false
		for _, log := range logs {
			if log.Date == day {
				rows = append(rows, log)
				continue
			}
			if log.Date < day {
				older = true
			}
		}
		if older || !hasMore || next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return chronological(rows), nil
}

// GetLogOnDate returns every row of that exercise on date.
func (c *Client) GetLogOnDate(ctx context.Context, exercise, date string) ([]model.ExerciseLog, error) {
	var rows []model.ExerciseLog
	cursor := ""
	for page := 0; page < maxDayPages; page++ {
		body := buildOnDateQuery(exercise, date)
		if cursor != "" {
			body["start_cursor"] = cursor
		}
		source, pages, hasMore, next, err := c.query(ctx, body)
		if err != nil {
			return nil, err
		}
		rows = append(rows, logsFrom(source, pages)...)
		if !hasMore || next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return chronological(rows), nil
}

// CreateLog appends one page and drops the schema cache so a new select option is visible.
func (c *Client) CreateLog(ctx context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	source, err := c.resolve(ctx)
	if err != nil {
		return model.ExerciseLog{}, err
	}
	input.Exercise = trim(input.Exercise)
	page, err := c.notion(ctx, "/pages", http.MethodPost, buildCreatePageBody(source.dataSourceID, source.titleProperty, input))
	if err != nil {
		return model.ExerciseLog{}, err
	}
	c.mu.Lock()
	c.schema = nil
	c.mu.Unlock()
	if log := PageToLog(page, source.titleProperty); log != nil {
		return *log, nil
	}
	title := trim(input.Title)
	if title == "" {
		title = pageTitle
	}
	created, _ := page["created_time"].(string)
	if created == "" {
		created = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	id, _ := page["id"].(string)
	return model.ExerciseLog{
		ID:         id,
		Exercise:   input.Exercise,
		WeightKg:   input.WeightKg,
		Reps:       input.Reps,
		Sets:       input.Sets,
		Difficulty: input.Difficulty,
		Date:       input.Date,
		Title:      title,
		CreatedAt:  created,
	}, nil
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [16]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}
