package notion

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tag0203/kintore-memo/api/internal/model"
)

func TestClientResolvesSchemaOnce(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("Notion-Version") != version {
			t.Errorf("headers = %v", r.Header)
		}
		switch {
		case r.URL.Path == "/databases/db-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"data_sources": []any{map[string]any{"id": "ds-1"}}})
		case r.URL.Path == "/data_sources/ds-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"properties": workoutProps()})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient("test-token", "db-1", server.Client())
	client.baseURL = server.URL
	first, err := client.ListExercises(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListExercises(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Fatalf("hits = %d", hits.Load())
	}
	if len(first) != 1 || first[0].Name != "スクワット" || first[0].LastPickedAt != nil {
		t.Fatalf("catalog = %#v", first)
	}
}

func TestClientCreateAndQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/databases/db-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"data_sources": []any{map[string]any{"id": "ds-1"}}})
		case r.URL.Path == "/data_sources/ds-1" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"properties": workoutProps()})
		case strings.HasSuffix(r.URL.Path, "/query"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results":  []any{workoutPage()},
				"has_more": false,
			})
		case r.URL.Path == "/pages":
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), `"data_source_id":"ds-1"`) {
				t.Errorf("create body = %s", raw)
			}
			_ = json.NewEncoder(w).Encode(workoutPage())
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewClient("test-token", "db-1", server.Client())
	client.baseURL = server.URL
	window, err := client.LoadRecentWindow(context.Background())
	if err != nil || !window.Complete || len(window.Logs) != 1 {
		t.Fatalf("window = %#v %v", window, err)
	}
	created, err := client.CreateLog(context.Background(), model.NewExerciseLog{
		Exercise: "スクワット", WeightKg: 82.5, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-09-26",
	})
	if err != nil || created.Exercise != "スクワット" || created.Difficulty != 3 {
		t.Fatalf("created = %#v %v", created, err)
	}
}

func TestSameDayQueriesKeepEveryRowOfThatExercise(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	var todayPages []any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		methods = append(methods, r.Method+" "+r.URL.Path)
		mu.Unlock()
		switch {
		case r.URL.Path == "/databases/db-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"data_sources": []any{map[string]any{"id": "ds-1"}}})
		case r.URL.Path == "/data_sources/ds-1" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"properties": workoutProps()})
		case strings.HasSuffix(r.URL.Path, "/query"):
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("query json: %v", err)
			}
			if body["page_size"] != float64(dayPageSize) {
				t.Errorf("page_size = %v", body["page_size"])
			}
			text := string(raw)
			cursor, _ := body["start_cursor"].(string)
			switch {
			case strings.Contains(text, `"before"`) && cursor == "":
				_ = json.NewEncoder(w).Encode(map[string]any{
					"results":     []any{logPage("p70", "スクワット", 70, "2026-09-25T12:00:00.000Z", "2026-09-25")},
					"has_more":    true,
					"next_cursor": "c2",
				})
			case strings.Contains(text, `"before"`):
				if cursor != "c2" {
					t.Errorf("cursor = %s", cursor)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"results": []any{
						logPage("p60", "スクワット", 60, "2026-09-25T11:00:00.000Z", "2026-09-25"),
						logPage("p50", "スクワット", 50, "2026-09-20T11:00:00.000Z", "2026-09-20"),
					},
					"has_more": false,
				})
			default:
				mu.Lock()
				pages := append([]any(nil), todayPages...)
				mu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]any{"results": pages, "has_more": false})
			}
		case r.URL.Path == "/pages" && r.Method == http.MethodPost:
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			props := body["properties"].(map[string]any)
			weight := props["重量（kg）"].(map[string]any)["number"].(float64)
			date := props["日付"].(map[string]any)["date"].(map[string]any)["start"].(string)
			mu.Lock()
			page := logPage("created-"+itoa(len(todayPages)), "スクワット", weight, "2026-10-02T09:00:0"+itoa(len(todayPages))+".000Z", date)
			todayPages = append(todayPages, page)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(page)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewClient("test-token", "db-1", server.Client())
	client.baseURL = server.URL

	previous, err := client.GetPreviousLog(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(previous) != 2 || previous[0].WeightKg != 60 || previous[1].WeightKg != 70 || previous[0].Date != "2026-09-25" || previous[1].Date != "2026-09-25" {
		t.Fatalf("previous = %#v", previous)
	}
	for _, weight := range []float64{80, 90} {
		if _, err := client.CreateLog(context.Background(), model.NewExerciseLog{
			Exercise: "スクワット", WeightKg: weight, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
		}); err != nil {
			t.Fatal(err)
		}
	}
	today, err := client.GetLogOnDate(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(today) != 2 || today[0].WeightKg != 80 || today[1].WeightKg != 90 {
		t.Fatalf("today = %#v", today)
	}
	again, err := client.GetPreviousLog(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 2 || again[0].ID != "p60" || again[1].ID != "p70" {
		t.Fatalf("previous after saves = %#v", again)
	}
	mu.Lock()
	defer mu.Unlock()
	posts := 0
	for _, method := range methods {
		if strings.Contains(method, "PATCH") || strings.Contains(method, "DELETE") {
			t.Fatalf("existing row was changed: %s", method)
		}
		if method == "POST /pages" {
			posts++
		}
	}
	if posts != 2 {
		t.Fatalf("posts = %d (%v)", posts, methods)
	}
}

func logPage(id, exercise string, weight float64, created, date string) map[string]any {
	page := workoutPage()
	page["id"] = id
	page["created_time"] = created
	props := page["properties"].(map[string]any)
	props["種目"] = map[string]any{"select": map[string]any{"name": exercise}}
	props["重量（kg）"] = map[string]any{"number": weight}
	props["日付"] = map[string]any{"date": map[string]any{"start": date}}
	return page
}

func workoutProps() map[string]any {
	return map[string]any{
		"名前":     map[string]any{"type": "title"},
		"種目":     map[string]any{"type": "select", "select": map[string]any{"options": []any{map[string]any{"name": "スクワット"}}}},
		"重量（kg）": map[string]any{"type": "number"},
		"回数":     map[string]any{"type": "number"},
		"セット数":   map[string]any{"type": "number"},
		"きつさ":    map[string]any{"type": "select"},
		"日付":     map[string]any{"type": "date"},
	}
}

func workoutPage() map[string]any {
	return map[string]any{
		"id": "page-1", "created_time": "2026-09-25T12:10:00.000Z",
		"properties": map[string]any{
			"名前":     map[string]any{"title": []any{map[string]any{"plain_text": "－"}}},
			"種目":     map[string]any{"select": map[string]any{"name": "スクワット"}},
			"重量（kg）": map[string]any{"number": 80},
			"回数":     map[string]any{"number": 11},
			"セット数":   map[string]any{"number": 3},
			"きつさ":    map[string]any{"select": map[string]any{"name": "ややきつい"}},
			"日付":     map[string]any{"date": map[string]any{"start": "2026-09-25"}},
		},
	}
}
