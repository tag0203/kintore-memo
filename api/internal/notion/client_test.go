package notion

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
