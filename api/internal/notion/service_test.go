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
	mu       sync.Mutex
	calls    []string
	window   model.Window
	gate     chan struct{}
	previous []model.ExerciseLog
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

func (b *countingBackend) GetPreviousLog(_ context.Context, exercise, before string) ([]model.ExerciseLog, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "previous:"+exercise+":"+before)
	rows := b.previous
	b.mu.Unlock()
	if rows != nil {
		return rows, nil
	}
	row := logRow(model.ExerciseLog{ID: "old", Exercise: exercise, Date: "2026-01-01"})
	return []model.ExerciseLog{row}, nil
}

func (b *countingBackend) GetLogOnDate(_ context.Context, exercise, date string) ([]model.ExerciseLog, error) {
	b.mu.Lock()
	b.calls = append(b.calls, "today:"+exercise+":"+date)
	b.mu.Unlock()
	return []model.ExerciseLog{}, nil
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
	previous := first.Logs["スクワット"].Previous
	if len(previous) != 1 || previous[0].Date != "2026-09-25" || len(first.Logs["スクワット"].Today) != 0 {
		t.Fatalf("first = %#v", first.Logs["スクワット"])
	}
	if second.Logs["スクワット"].Previous[0].Date != previous[0].Date {
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
	previous := body.Logs["デッドリフト"].Previous
	if len(previous) != 1 || previous[0].Date != "2026-01-01" || len(body.Logs["デッドリフト"].Today) != 0 {
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

func fullLog(id, exercise string, weight float64, reps, sets, difficulty int, date, createdAt string) model.ExerciseLog {
	return model.ExerciseLog{
		ID: id, Exercise: exercise, WeightKg: weight, Reps: reps, Sets: sets,
		Difficulty: difficulty, Date: date, Title: "－", CreatedAt: createdAt,
	}
}

func TestPreviousDayKeepsEveryRowAndIgnoresOtherExercises(t *testing.T) {
	backend := &countingBackend{window: model.Window{Complete: true, Logs: []model.ExerciseLog{
		fullLog("squat-old", "スクワット", 40, 12, 3, 2, "2026-09-10", "2026-09-10T09:00:00.000Z"),
		fullLog("squat-60", "スクワット", 60, 8, 3, 3, "2026-09-25", "2026-09-25T11:00:00.000Z"),
		fullLog("squat-70", "スクワット", 70, 6, 3, 4, "2026-09-25", "2026-09-25T12:00:00.000Z"),
		fullLog("press", "レッグプレス", 150, 10, 3, 3, "2026-09-28", "2026-09-28T10:00:00.000Z"),
		fullLog("today-80", "スクワット", 80, 8, 3, 3, "2026-10-02", "2026-10-02T08:00:00.000Z"),
		fullLog("today-90", "スクワット", 90, 5, 3, 5, "2026-10-02", "2026-10-02T09:00:00.000Z"),
	}}}
	service := newService(backend)
	body, err := service.Bootstrap(context.Background(), "2026-10-02", []string{"スクワット", "レッグプレス"})
	if err != nil {
		t.Fatal(err)
	}
	squat := body.Logs["スクワット"]
	if len(squat.Previous) != 2 || squat.Previous[0].WeightKg != 60 || squat.Previous[1].WeightKg != 70 || squat.Previous[0].Date != "2026-09-25" {
		t.Fatalf("squat previous = %#v", squat.Previous)
	}
	if len(squat.Today) != 2 || squat.Today[0].WeightKg != 80 || squat.Today[1].WeightKg != 90 {
		t.Fatalf("squat today = %#v", squat.Today)
	}
	press := body.Logs["レッグプレス"]
	if len(press.Previous) != 1 || press.Previous[0].Date != "2026-09-28" || press.Previous[0].WeightKg != 150 || len(press.Today) != 0 {
		t.Fatalf("press = %#v", press)
	}
	if has(join(backend.snapshot()), "previous:") || has(join(backend.snapshot()), "today:") {
		t.Fatalf("window was complete, extra queries = %v", backend.snapshot())
	}
}

func TestTruncatedPreviousDayAsksForEveryRow(t *testing.T) {
	backend := &countingBackend{
		window: model.Window{Complete: false, Logs: []model.ExerciseLog{
			fullLog("squat-70", "スクワット", 70, 6, 3, 4, "2026-09-25", "2026-09-25T12:00:00.000Z"),
		}},
		previous: []model.ExerciseLog{
			fullLog("squat-60", "スクワット", 60, 8, 3, 3, "2026-09-25", "2026-09-25T11:00:00.000Z"),
			fullLog("squat-70", "スクワット", 70, 6, 3, 4, "2026-09-25", "2026-09-25T12:00:00.000Z"),
		},
	}
	service := newService(backend)
	rows, err := service.GetPreviousLog(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].WeightKg != 60 || rows[1].WeightKg != 70 {
		t.Fatalf("rows = %#v", rows)
	}
	if !has(join(backend.snapshot()), "previous:スクワット:2026-10-02") {
		t.Fatalf("calls = %v", backend.snapshot())
	}
}

type appendingBackend struct {
	logs []model.ExerciseLog
}

func (b *appendingBackend) ListExercises(context.Context) ([]model.ExerciseSummary, error) {
	return []model.ExerciseSummary{{Name: "スクワット"}}, nil
}

func (b *appendingBackend) LoadRecentWindow(context.Context) (model.Window, error) {
	return model.Window{Logs: append([]model.ExerciseLog(nil), b.logs...), Complete: true}, nil
}

func (b *appendingBackend) GetPreviousLog(context.Context, string, string) ([]model.ExerciseLog, error) {
	return nil, nil
}

func (b *appendingBackend) GetLogOnDate(context.Context, string, string) ([]model.ExerciseLog, error) {
	return nil, nil
}

func (b *appendingBackend) CreateLog(_ context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	row := fullLog("id-"+input.Date+"-"+itoa(len(b.logs)), input.Exercise, input.WeightKg, input.Reps, input.Sets, input.Difficulty, input.Date, "2026-10-02T09:00:0"+itoa(len(b.logs))+".000Z")
	b.logs = append(b.logs, row)
	return row, nil
}

func TestLaterSaveKeepsTheEarlierSameDayRow(t *testing.T) {
	backend := &appendingBackend{logs: []model.ExerciseLog{
		fullLog("squat-60", "スクワット", 60, 8, 3, 3, "2026-09-25", "2026-09-25T11:00:00.000Z"),
		fullLog("squat-70", "スクワット", 70, 6, 3, 4, "2026-09-25", "2026-09-25T12:00:00.000Z"),
	}}
	clock := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	service := NewService(backend, cache.NewJSON(cache.NewMemory(func() time.Time { return clock }), func() time.Time { return clock }))
	for _, weight := range []float64{80, 90} {
		if _, err := service.CreateLog(context.Background(), model.NewExerciseLog{
			Exercise: "スクワット", WeightKg: weight, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
		}); err != nil {
			t.Fatal(err)
		}
	}
	today, err := service.GetLogOnDate(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(today) != 2 || today[0].WeightKg != 80 || today[1].WeightKg != 90 {
		t.Fatalf("today = %#v", today)
	}
	previous, err := service.GetPreviousLog(context.Background(), "スクワット", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if len(previous) != 2 || previous[0].WeightKg != 60 || previous[1].WeightKg != 70 || previous[0].Date != "2026-09-25" {
		t.Fatalf("previous = %#v", previous)
	}
	if len(backend.logs) != 4 {
		t.Fatalf("stored = %#v", backend.logs)
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
