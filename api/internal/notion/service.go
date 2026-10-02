package notion

import (
	"context"
	"sort"
	"strings"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/model"
)

// Service shares one recent-log window across bootstrap and the individual GETs.
// A save drops that window. Screen navigation is still expected to use the client cache.
type Service struct {
	client Backend
	json   *cache.JSON
}

// NewService caches client calls for the TTL of the store underneath jsonCache.
func NewService(client Backend, jsonCache *cache.JSON) *Service {
	return &Service{client: client, json: jsonCache}
}

func (s *Service) recentWindow(ctx context.Context) (model.Window, error) {
	return cache.GetOrLoad(ctx, s.json, []string{"exercises", "recent"}, func(ctx context.Context) (model.Window, error) {
		window, err := s.client.LoadRecentWindow(ctx)
		if err != nil {
			return model.Window{}, err
		}
		if window.Logs == nil {
			window.Logs = []model.ExerciseLog{}
		}
		return window, nil
	})
}

// ListExercises returns the catalog. lastPickedAt is null.
func (s *Service) ListExercises(ctx context.Context) ([]model.ExerciseSummary, error) {
	items, err := cache.GetOrLoad(ctx, s.json, []string{"exercises"}, s.client.ListExercises)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []model.ExerciseSummary{}
	}
	return items, nil
}

// ListRecentExercises orders exercises by the newest log in the shared window.
func (s *Service) ListRecentExercises(ctx context.Context) ([]model.ExerciseSummary, error) {
	window, err := s.recentWindow(ctx)
	if err != nil {
		return nil, err
	}
	return summariesFromLogs(window.Logs), nil
}

// GetPreviousLog uses the window when it can prove the answer.
func (s *Service) GetPreviousLog(ctx context.Context, exercise, before string) (*model.ExerciseLog, error) {
	window, err := s.recentWindow(ctx)
	if err != nil {
		return nil, err
	}
	resolved := previousInWindow(window, exercise, before)
	if resolved.known {
		return resolved.log, nil
	}
	return cache.GetOrLoad(ctx, s.json, []string{"logs", "previous", exercise, before}, func(ctx context.Context) (*model.ExerciseLog, error) {
		return s.client.GetPreviousLog(ctx, exercise, before)
	})
}

// GetLogOnDate uses the window when the session date is inside it.
func (s *Service) GetLogOnDate(ctx context.Context, exercise, date string) (*model.ExerciseLog, error) {
	window, err := s.recentWindow(ctx)
	if err != nil {
		return nil, err
	}
	resolved := todayInWindow(window, exercise, date)
	if resolved.known {
		return resolved.log, nil
	}
	return cache.GetOrLoad(ctx, s.json, []string{"logs", "today", exercise, date}, func(ctx context.Context) (*model.ExerciseLog, error) {
		return s.client.GetLogOnDate(ctx, exercise, date)
	})
}

// Bootstrap returns the catalog, recent exercises, and previous/today for the session date.
func (s *Service) Bootstrap(ctx context.Context, date string, exercises []string) (model.Bootstrap, error) {
	type catalogResult struct {
		items []model.ExerciseSummary
		err   error
	}
	type windowResult struct {
		window model.Window
		err    error
	}
	catalogCh := make(chan catalogResult, 1)
	windowCh := make(chan windowResult, 1)
	go func() {
		items, err := s.ListExercises(ctx)
		catalogCh <- catalogResult{items, err}
	}()
	go func() {
		window, err := s.recentWindow(ctx)
		windowCh <- windowResult{window, err}
	}()
	catalog := <-catalogCh
	window := <-windowCh
	if catalog.err != nil {
		return model.Bootstrap{}, catalog.err
	}
	if window.err != nil {
		return model.Bootstrap{}, window.err
	}

	names := exercises
	if len(names) == 0 {
		for _, item := range summariesFromLogs(window.window.Logs) {
			names = append(names, item.Name)
		}
	}
	logs := map[string]model.LogPair{}
	for _, name := range names {
		previous := previousInWindow(window.window, name, date)
		today := todayInWindow(window.window, name, date)
		pair := model.LogPair{}
		if previous.known {
			pair.Previous = previous.log
		} else {
			log, err := cache.GetOrLoad(ctx, s.json, []string{"logs", "previous", name, date}, func(ctx context.Context) (*model.ExerciseLog, error) {
				return s.client.GetPreviousLog(ctx, name, date)
			})
			if err != nil {
				return model.Bootstrap{}, err
			}
			pair.Previous = log
		}
		if today.known {
			pair.Today = today.log
		} else {
			log, err := cache.GetOrLoad(ctx, s.json, []string{"logs", "today", name, date}, func(ctx context.Context) (*model.ExerciseLog, error) {
				return s.client.GetLogOnDate(ctx, name, date)
			})
			if err != nil {
				return model.Bootstrap{}, err
			}
			pair.Today = log
		}
		logs[name] = pair
	}
	recent := summariesFromLogs(window.window.Logs)
	exercisesOut := catalog.items
	if exercisesOut == nil {
		exercisesOut = []model.ExerciseSummary{}
	}
	return model.Bootstrap{
		Date:      date,
		Exercises: exercisesOut,
		Recent:    recent,
		Logs:      logs,
	}, nil
}

// CreateLog appends a row and drops the catalog, the window, and that exercise's keys.
func (s *Service) CreateLog(ctx context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	log, err := s.client.CreateLog(ctx, input)
	if err != nil {
		return model.ExerciseLog{}, err
	}
	if err := s.json.Delete(ctx, []string{"exercises"}); err != nil {
		return model.ExerciseLog{}, err
	}
	if err := s.json.Delete(ctx, []string{"exercises", "recent"}); err != nil {
		return model.ExerciseLog{}, err
	}
	if err := s.json.Delete(ctx, []string{"logs", "today", input.Exercise, input.Date}); err != nil {
		return model.ExerciseLog{}, err
	}
	prefix := "logs#previous#" + input.Exercise + "#"
	if err := s.json.DeleteWhere(ctx, func(key string) bool {
		return key == "bootstrap" || strings.HasPrefix(key, "bootstrap#") || strings.HasPrefix(key, prefix)
	}); err != nil {
		return model.ExerciseLog{}, err
	}
	return log, nil
}

type resolved struct {
	known bool
	log   *model.ExerciseLog
}

func summariesFromLogs(logs []model.ExerciseLog) []model.ExerciseSummary {
	sorted := sortDesc(logs)
	seen := map[string]struct{}{}
	recent := make([]model.ExerciseSummary, 0)
	for _, log := range sorted {
		if _, ok := seen[log.Exercise]; ok {
			continue
		}
		seen[log.Exercise] = struct{}{}
		recent = append(recent, model.ExerciseSummary{Name: log.Exercise, LastPickedAt: stringPtr(log.CreatedAt)})
	}
	return recent
}

func stringPtr(value string) *string {
	return &value
}

func sortDesc(logs []model.ExerciseLog) []model.ExerciseLog {
	out := append([]model.ExerciseLog(nil), logs...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date > out[j].Date
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

func previousFromWindow(logs []model.ExerciseLog, exercise, before string) *model.ExerciseLog {
	var best *model.ExerciseLog
	for i := range logs {
		log := &logs[i]
		if log.Exercise != exercise || log.Date >= before {
			continue
		}
		if best == nil || log.Date > best.Date || (log.Date == best.Date && log.CreatedAt > best.CreatedAt) {
			best = log
		}
	}
	if best == nil {
		return nil
	}
	copy := *best
	return &copy
}

func todayFromWindow(logs []model.ExerciseLog, exercise, date string) *model.ExerciseLog {
	var best *model.ExerciseLog
	for i := range logs {
		log := &logs[i]
		if log.Exercise != exercise || log.Date != date {
			continue
		}
		if best == nil || log.CreatedAt > best.CreatedAt {
			best = log
		}
	}
	if best == nil {
		return nil
	}
	copy := *best
	return &copy
}

func oldestDate(logs []model.ExerciseLog) string {
	oldest := ""
	for _, log := range logs {
		if oldest == "" || log.Date < oldest {
			oldest = log.Date
		}
	}
	return oldest
}

func previousInWindow(window model.Window, exercise, before string) resolved {
	if log := previousFromWindow(window.Logs, exercise, before); log != nil {
		return resolved{known: true, log: log}
	}
	if window.Complete {
		return resolved{known: true}
	}
	return resolved{}
}

func todayInWindow(window model.Window, exercise, date string) resolved {
	if log := todayFromWindow(window.Logs, exercise, date); log != nil {
		return resolved{known: true, log: log}
	}
	if window.Complete {
		return resolved{known: true}
	}
	if oldest := oldestDate(window.Logs); oldest != "" && date > oldest {
		return resolved{known: true}
	}
	return resolved{}
}
