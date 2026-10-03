// Package notion talks to the Notion API. The browser never imports it.
package notion

import "github.com/tag0203/kintore-memo/api/internal/model"

const (
	version        = "2026-03-11"
	pageTitle      = "－"
	recentPageSize = 100
)

var difficultyLabels = map[int]string{
	1: "とても楽",
	2: "楽",
	3: "ややきつい",
	4: "きつい",
	5: "とてもきつい",
}

var labelToDifficulty = map[string]int{
	"とても楽":   1,
	"楽":      2,
	"ややきつい":  3,
	"きつい":    4,
	"とてもきつい": 5,
}

var properties = struct {
	Exercise, Weight, Reps, Sets, Difficulty, Date string
}{
	Exercise:   "種目",
	Weight:     "重量（kg）",
	Reps:       "回数",
	Sets:       "セット数",
	Difficulty: "きつさ",
	Date:       "日付",
}

var expectedTypes = []struct{ name, typ string }{
	{properties.Exercise, "select"},
	{properties.Weight, "number"},
	{properties.Reps, "number"},
	{properties.Sets, "number"},
	{properties.Difficulty, "select"},
	{properties.Date, "date"},
}

// AssertWorkoutSchema finds the title column and checks the workout properties.
func AssertWorkoutSchema(props map[string]any) (string, error) {
	title := ""
	for name, property := range props {
		if propType(property) == "title" {
			title = name
			break
		}
	}
	if title == "" {
		return "", errString("タイトルプロパティが見つかりません")
	}
	for _, expected := range expectedTypes {
		property, ok := props[expected.name]
		if !ok {
			return "", errString("プロパティ「" + expected.name + "」がありません")
		}
		got := propType(property)
		if got != expected.typ {
			if got == "" {
				got = "不明"
			}
			return "", errString("プロパティ「" + expected.name + "」の型は " + expected.typ + " にしてください（今は " + got + "）")
		}
	}
	return title, nil
}

// ExerciseNamesFromSchema reads the select options for 種目.
func ExerciseNamesFromSchema(props map[string]any) []string {
	options := selectOptions(props[properties.Exercise])
	names := make([]string, 0, len(options))
	seen := map[string]struct{}{}
	for _, option := range options {
		name := trim(option)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

func buildPreviousQuery(exercise, beforeDate string) map[string]any {
	return map[string]any{
		"filter": map[string]any{
			"and": []any{
				map[string]any{"property": properties.Exercise, "select": map[string]any{"equals": exercise}},
				map[string]any{"property": properties.Date, "date": map[string]any{"before": beforeDate}},
			},
		},
		"sorts": []any{
			map[string]any{"property": properties.Date, "direction": "descending"},
			map[string]any{"timestamp": "created_time", "direction": "descending"},
		},
		"page_size": 1,
	}
}

func buildOnDateQuery(exercise, date string) map[string]any {
	return map[string]any{
		"filter": map[string]any{
			"and": []any{
				map[string]any{"property": properties.Exercise, "select": map[string]any{"equals": exercise}},
				map[string]any{"property": properties.Date, "date": map[string]any{"equals": date}},
			},
		},
		"sorts":     []any{map[string]any{"timestamp": "created_time", "direction": "descending"}},
		"page_size": 1,
	}
}

func buildRecentQuery() map[string]any {
	return map[string]any{
		"sorts": []any{
			map[string]any{"property": properties.Date, "direction": "descending"},
			map[string]any{"timestamp": "created_time", "direction": "descending"},
		},
		"page_size": recentPageSize,
	}
}

func buildCreatePageBody(dataSourceID, titleProperty string, input model.NewExerciseLog) map[string]any {
	title := trim(input.Title)
	if title == "" {
		title = pageTitle
	}
	return map[string]any{
		"parent": map[string]any{"type": "data_source_id", "data_source_id": dataSourceID},
		"properties": map[string]any{
			titleProperty: map[string]any{
				"type":  "title",
				"title": []any{map[string]any{"type": "text", "text": map[string]any{"content": title}}},
			},
			properties.Exercise:   map[string]any{"type": "select", "select": map[string]any{"name": input.Exercise}},
			properties.Weight:     map[string]any{"type": "number", "number": input.WeightKg},
			properties.Reps:       map[string]any{"type": "number", "number": input.Reps},
			properties.Sets:       map[string]any{"type": "number", "number": input.Sets},
			properties.Difficulty: map[string]any{"type": "select", "select": map[string]any{"name": difficultyLabels[input.Difficulty]}},
			properties.Date:       map[string]any{"type": "date", "date": map[string]any{"start": input.Date}},
		},
	}
}

// PageToLog maps one Notion page. Incomplete rows are skipped.
func PageToLog(page map[string]any, titleProperty string) *model.ExerciseLog {
	props, _ := page["properties"].(map[string]any)
	exercise := readSelect(props[properties.Exercise])
	weight, weightOK := readNumber(props[properties.Weight])
	reps, repsOK := readNumber(props[properties.Reps])
	sets, setsOK := readNumber(props[properties.Sets])
	difficultyLabel := readSelect(props[properties.Difficulty])
	date := readDate(props[properties.Date])
	if exercise == "" || !weightOK || !repsOK || !setsOK || difficultyLabel == "" || date == "" {
		return nil
	}
	difficulty, ok := labelToDifficulty[difficultyLabel]
	if !ok || !isWhole(reps) || !isWhole(sets) {
		return nil
	}
	created, _ := page["created_time"].(string)
	if created == "" {
		created = "1970-01-01T00:00:00.000Z"
	}
	id, _ := page["id"].(string)
	title := readTitle(props[titleProperty])
	if title == "" {
		title = pageTitle
	}
	return &model.ExerciseLog{
		ID:         id,
		Exercise:   exercise,
		WeightKg:   weight,
		Reps:       int(reps),
		Sets:       int(sets),
		Difficulty: difficulty,
		Date:       date,
		Title:      title,
		CreatedAt:  created,
	}
}

func propType(property any) string {
	record, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	typ, _ := record["type"].(string)
	return typ
}

func selectOptions(property any) []string {
	record, ok := property.(map[string]any)
	if !ok {
		return nil
	}
	selectProp, ok := record["select"].(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := selectProp["options"].([]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(raw))
	for _, option := range raw {
		item, ok := option.(map[string]any)
		if !ok {
			names = append(names, "")
			continue
		}
		name, _ := item["name"].(string)
		names = append(names, name)
	}
	return names
}

func readTitle(property any) string {
	record, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	title, ok := record["title"].([]any)
	if !ok {
		return ""
	}
	out := ""
	for _, item := range title {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		text, _ := entry["plain_text"].(string)
		out += text
	}
	return out
}

func readSelect(property any) string {
	record, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	selected, ok := record["select"].(map[string]any)
	if !ok {
		return ""
	}
	name, _ := selected["name"].(string)
	return trim(name)
}

func readNumber(property any) (float64, bool) {
	record, ok := property.(map[string]any)
	if !ok {
		return 0, false
	}
	switch n := record["number"].(type) {
	case float64:
		return n, true
	default:
		return 0, false
	}
}

func readDate(property any) string {
	record, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	date, ok := record["date"].(map[string]any)
	if !ok {
		return ""
	}
	start, _ := date["start"].(string)
	if start == "" {
		return ""
	}
	if len(start) >= 10 {
		return start[:10]
	}
	return start
}
