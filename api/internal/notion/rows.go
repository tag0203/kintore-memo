package notion

import (
	"sort"

	"github.com/tag0203/kintore-memo/api/internal/model"
)

func emptyLogs() []model.ExerciseLog {
	return []model.ExerciseLog{}
}

// chronological keeps the earlier save ahead of a later one.
func chronological(logs []model.ExerciseLog) []model.ExerciseLog {
	if len(logs) == 0 {
		return emptyLogs()
	}
	out := append([]model.ExerciseLog(nil), logs...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// previousDayRows is every row of exercise on its latest date strictly before before.
func previousDayRows(logs []model.ExerciseLog, exercise, before string) (string, []model.ExerciseLog) {
	day := ""
	for _, log := range logs {
		if log.Exercise != exercise || log.Date >= before {
			continue
		}
		if day == "" || log.Date > day {
			day = log.Date
		}
	}
	if day == "" {
		return "", emptyLogs()
	}
	return day, sameDayRows(logs, exercise, day)
}

func sameDayRows(logs []model.ExerciseLog, exercise, date string) []model.ExerciseLog {
	rows := make([]model.ExerciseLog, 0)
	for _, log := range logs {
		if log.Exercise == exercise && log.Date == date {
			rows = append(rows, log)
		}
	}
	return chronological(rows)
}
