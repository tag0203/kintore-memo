package notion

import (
	"testing"

	"github.com/tag0203/kintore-memo/api/internal/model"
)

func TestWorkoutSchemaAndPage(t *testing.T) {
	schema := map[string]any{
		"名前": map[string]any{"type": "title"},
		"種目": map[string]any{"type": "select", "select": map[string]any{"options": []any{
			map[string]any{"name": "スクワット"},
			map[string]any{"name": "ベンチプレス"},
		}}},
		"重量（kg）": map[string]any{"type": "number"},
		"回数":     map[string]any{"type": "number"},
		"セット数":   map[string]any{"type": "number"},
		"きつさ":    map[string]any{"type": "select"},
		"日付":     map[string]any{"type": "date"},
	}
	title, err := AssertWorkoutSchema(schema)
	if err != nil || title != "名前" {
		t.Fatalf("title = %s %v", title, err)
	}
	names := ExerciseNamesFromSchema(schema)
	if len(names) != 2 || names[0] != "スクワット" || names[1] != "ベンチプレス" {
		t.Fatalf("names = %#v", names)
	}
	if _, err := AssertWorkoutSchema(map[string]any{"名前": map[string]any{"type": "title"}}); err == nil || err.Error() != "プロパティ「種目」がありません" {
		t.Fatalf("missing exercise: %v", err)
	}

	page := map[string]any{
		"id":           "page-1",
		"created_time": "2026-09-25T12:10:00.000Z",
		"properties": map[string]any{
			"名前":     map[string]any{"title": []any{map[string]any{"plain_text": "－"}}},
			"種目":     map[string]any{"select": map[string]any{"name": "スクワット"}},
			"重量（kg）": map[string]any{"number": 80.0},
			"回数":     map[string]any{"number": 11.0},
			"セット数":   map[string]any{"number": 3.0},
			"きつさ":    map[string]any{"select": map[string]any{"name": "ややきつい"}},
			"日付":     map[string]any{"date": map[string]any{"start": "2026-09-25"}},
		},
	}
	log := PageToLog(page, "名前")
	if log == nil || log.Exercise != "スクワット" || log.WeightKg != 80 || log.Reps != 11 || log.Difficulty != 3 || log.Date != "2026-09-25" || log.Title != "－" {
		t.Fatalf("log = %#v", log)
	}
	page["properties"].(map[string]any)["回数"] = map[string]any{"number": 1.5}
	if PageToLog(page, "名前") != nil {
		t.Fatal("fractional reps should be skipped")
	}

	body := buildCreatePageBody("ds-1", "名前", model.NewExerciseLog{
		Exercise: "スクワット", WeightKg: 82.5, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-09-26",
	})
	parent := body["parent"].(map[string]any)
	if parent["data_source_id"] != "ds-1" {
		t.Fatalf("parent = %#v", parent)
	}
	props := body["properties"].(map[string]any)
	titleProp := props["名前"].(map[string]any)["title"].([]any)[0].(map[string]any)
	if titleProp["text"].(map[string]any)["content"] != "－" {
		t.Fatal(titleProp)
	}
	if props["きつさ"].(map[string]any)["select"].(map[string]any)["name"] != "きつい" {
		t.Fatal(props["きつさ"])
	}
}
