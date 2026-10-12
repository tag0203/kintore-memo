package draft

import (
	"sort"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/model"
)

func emptyLogs() []model.ExerciseLog {
	return []model.ExerciseLog{}
}

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

func logsFromDay(day ddb.DraftDayItem) []model.ExerciseLog {
	logs := make([]model.ExerciseLog, 0, len(day.Drafts))
	for _, row := range day.Drafts {
		logs = append(logs, logFromRow(day, row))
	}
	return chronological(logs)
}

func exerciseRows(day ddb.DraftDayItem, exercise string) ([]model.ExerciseLog, map[string]struct{}) {
	logs := make([]model.ExerciseLog, 0)
	pages := map[string]struct{}{}
	for _, row := range day.Drafts {
		if row.Exercise != exercise {
			continue
		}
		if row.NotionPageID != "" {
			pages[row.NotionPageID] = struct{}{}
		}
		logs = append(logs, logFromRow(day, row))
	}
	return chronological(logs), pages
}

func mergeLogs(notion []model.ExerciseLog, drafts []model.ExerciseLog, pages map[string]struct{}) []model.ExerciseLog {
	out := make([]model.ExerciseLog, 0, len(drafts)+len(notion))
	out = append(out, drafts...)
	for _, log := range notion {
		if _, ok := pages[log.ID]; ok {
			continue
		}
		out = append(out, log)
	}
	return chronological(out)
}

// OverlayToday merges Notion rows for the session date with that day's drafts.
// A draft that already has a Notion page id replaces the Notion row.
func OverlayToday(notion []model.ExerciseLog, session *ddb.DraftDayItem, exercise string) []model.ExerciseLog {
	if session == nil {
		if len(notion) == 0 {
			return emptyLogs()
		}
		return chronological(notion)
	}
	drafts, pages := exerciseRows(*session, exercise)
	return mergeLogs(notion, drafts, pages)
}

// OverlayPrevious picks the latest day before `before` from Notion and from
// unfinished draft days. Unsynced drafts on a later day win over an older Notion day.
func OverlayPrevious(notion []model.ExerciseLog, open []ddb.DraftDayItem, exercise, before string) []model.ExerciseLog {
	notionDay := ""
	if len(notion) > 0 {
		notionDay = notion[0].Date
	}
	bestDay := ""
	var best []model.ExerciseLog
	var bestPages map[string]struct{}
	for _, day := range open {
		if day.Synced || day.Date == "" || day.Date >= before {
			continue
		}
		rows, pages := exerciseRows(day, exercise)
		if len(rows) == 0 {
			continue
		}
		if bestDay == "" || day.Date > bestDay {
			bestDay = day.Date
			best = rows
			bestPages = pages
		}
	}
	switch {
	case bestDay == "":
		if len(notion) == 0 {
			return emptyLogs()
		}
		return chronological(notion)
	case notionDay == "" || bestDay > notionDay:
		return chronological(best)
	case bestDay < notionDay:
		return chronological(notion)
	default:
		return mergeLogs(notion, best, bestPages)
	}
}
