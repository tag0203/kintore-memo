package notion

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/model"
)

func logRow(overrides model.ExerciseLog) model.ExerciseLog {
	row := model.ExerciseLog{
		ID: "page-1", Exercise: "スクワット", WeightKg: 80, Reps: 11, Sets: 3,
		Difficulty: 3, Date: "2026-09-25", Title: "－", CreatedAt: "2026-09-25T12:00:00.000Z",
	}
	if overrides.ID != "" {
		row.ID = overrides.ID
	}
	if overrides.Exercise != "" {
		row.Exercise = overrides.Exercise
	}
	if overrides.Date != "" {
		row.Date = overrides.Date
	}
	if overrides.CreatedAt != "" {
		row.CreatedAt = overrides.CreatedAt
	}
	return row
}

type countingBackend struct {
	mu     sync.Mutex
	calls  []string
	window model.Window
	gate   chan struct{}
}

func (b *countingBackend) ListExercises(context.Context) ([]model.ExerciseSummary, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "exercises")
	b.mu.Unlock()
	return []model.ExerciseSummary{{Name: "スクワット"}, {Name: "デッドリフト"}}, nil
}

func (b *countingBackend) LoadRecentWindow(ctx context.Context) (model.Window, error) {
	if b.gate != nil {
		select {
		case <-b.gate:
		case <-ctx.Done():
			return model.Window{}, ctx.Err()
		}
	}
	b.mu.Lock()
	b.calls = append(b.calls, "recent")
	b.mu.Unlock()
	if b.window.Logs == nil && !b.window.Complete {
		return model.Window{Logs: []model.ExerciseLog{logRow(model.ExerciseLog{})}, Complete: true}, nil
	}
	return b.window, nil
}

func (b *countingBackend) GetPreviousLog(_ context.Context, exercise, before string) (*model.ExerciseLog, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "previous:"+exercise+":"+before)
	b.mu.Unlock()
	row := logRow(model.ExerciseLog{ID: "old", Exercise: exercise, Date: "2026-01-01"})
	return &row, nil
}

func (b *countingBackend) GetLogOnDate(_ context.Context, exercise, date string) (*model.ExerciseLog, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "today:"+exercise+":"+date)
	b.mu.Unlock()
	return nil, nil
}

func (b *countingBackend) CreateLog(_ context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "create")
	b.mu.Unlock()
	row := logRow(model.ExerciseLog{})
	row.Exercise = input.Exercise
	row.WeightKg = input.WeightKg
	row.ID = "new"
	row.CreatedAt = "2026-10-02T01:00:00.000Z"
	row.Date = input.Date
	return row, nil
}

func (b *countingBackend) snapshot() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := append([]string(nil), b.calls...)
	return out
}

func newService(b *countingBackend) *Service {
	clock := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	return NewService(b, cache.NewJSON(cache.NewMemory(func() time.Time { return clock }), func() time.Time { return clock }))
}

func TestBootstrapUsesTheWindowOnce(t *testing.T) {
	backend := &countingBackend{}
	service := newService(backend)
	first, err := service.Bootstrap(context.Background(), "2026-10-02", []string{"スクワット"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Bootstrap(context.Background(), "2026-10-02", []string{"スクワット"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Logs["スクワット"].Previous == nil || first.Logs["スクワット"].Previous.Date != "2026-09-25" || first.Logs["スクワット"].Today != nil {
		t.Fatalf("first = %#v", first.Logs["スクワット"])
	}
	if second.Logs["スクワット"].Previous.Date != first.Logs["スクワット"].Previous.Date {
		t.Fatal("second bootstrap diverged")
	}
	if got := join(backend.snapshot()); got != "exercises,recent" && got != "recent,exercises" {
		t.Fatalf("calls = %s", got)
	}
}

func TestColdExerciseQueriesPreviousOnly(t *testing.T) {
	backend := &countingBackend{window: model.Window{Logs: []model.ExerciseLog{logRow(model.ExerciseLog{Date: "2026-10-01"})}, Complete: false}}
	service := newService(backend)
	body, err := service.Bootstrap(context.Background(), "2026-10-02", []string{"デッドリフト"})
	if err != nil {
		t.Fatal(err)
	}
	if body.Logs["デッドリフト"].Previous == nil || body.Logs["デッドリフト"].Previous.Date != "2026-01-01" || body.Logs["デッドリフト"].Today != nil {
		t.Fatalf("pair = %#v", body.Logs["デッドリフト"])
	}
	calls := join(backend.snapshot())
	if !has(calls, "previous:デッドリフト:2026-10-02") || has(calls, "today:デッドリフト:2026-10-02") {
		t.Fatalf("calls = %s", calls)
	}
	backend.mu.Lock()
	backend.calls = nil
	backend.mu.Unlock()
	if _, err := service.GetPreviousLog(context.Background(), "デッドリフト", "2026-10-02"); err != nil {
		t.Fatal(err)
	}
	if len(backend.snapshot()) != 0 {
		t.Fatalf("cached previous refetched: %v", backend.snapshot())
	}
}

func TestSaveDropsTheWindow(t *testing.T) {
	backend := &countingBackend{}
	service := newService(backend)
	if _, err := service.ListRecentExercises(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateLog(context.Background(), model.NewExerciseLog{
		Exercise: "スクワット", WeightKg: 82.5, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
	}); err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	backend.calls = nil
	backend.mu.Unlock()
	if _, err := service.ListRecentExercises(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := join(backend.snapshot()); got != "recent" {
		t.Fatalf("calls = %s", got)
	}
}

func TestConcurrentBootstrapSharesTheWindow(t *testing.T) {
	gate := make(chan struct{})
	backend := &countingBackend{gate: gate}
	service := newService(backend)
	errCh := make(chan error, 2)
	go func() {
		_, err := service.Bootstrap(context.Background(), "2026-10-02", nil)
		errCh <- err
	}()
	go func() {
		_, err := service.Bootstrap(context.Background(), "2026-10-02", nil)
		errCh <- err
	}()
	close(gate)
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
	recent := 0
	for _, call := range backend.snapshot() {
		if call == "recent" {
			recent++
		}
	}
	if recent != 1 {
		t.Fatalf("recent calls = %d (%v)", recent, backend.snapshot())
	}
}

func join(calls []string) string {
	out := ""
	for i, call := range calls {
		if i > 0 {
			out += ","
		}
		out += call
	}
	return out
}

func has(calls, part string) bool {
	return len(calls) >= len(part) && (calls == part || containsCall(calls, part))
}

func containsCall(calls, part string) bool {
	for i := 0; i+len(part) <= len(calls); i++ {
		if calls[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
