package notion

import (
	"testing"

	"github.com/tag0203/kintore-memo/api/internal/model"
)

func TestNotionPageTitle(t *testing.T) {
	t.Run("single exercise", func(t *testing.T) {
		if got := notionPageTitle("ベンチプレス"); got != "ベンチプレス" {
			t.Fatalf("title = %q", got)
		}
		body := buildCreatePageBody("ds-1", "－", model.NewExerciseLog{
			Exercise: "ベンチプレス", WeightKg: 80, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
			Title: "－",
		})
		props := body["properties"].(map[string]any)
		if _, renamed := props["名前"]; renamed {
			t.Fatal("title property was renamed")
		}
		content := titleContent(t, props, "－")
		if content != "ベンチプレス" {
			t.Fatalf("content = %q", content)
		}
		selectName := props["種目"].(map[string]any)["select"].(map[string]any)["name"]
		if selectName != "ベンチプレス" {
			t.Fatalf("select = %#v", selectName)
		}
		// A custom draft title does not replace the exercise name.
		custom := buildCreatePageBody("ds-1", "－", model.NewExerciseLog{
			Exercise: "デッドリフト", Title: "メモ", WeightKg: 100, Reps: 5, Sets: 3, Difficulty: 5, Date: "2026-10-02",
		})
		if got := titleContent(t, custom["properties"].(map[string]any), "－"); got != "デッドリフト" {
			t.Fatalf("custom title leaked: %q", got)
		}
	})

	t.Run("multiple exercises stay one title per row", func(t *testing.T) {
		// 種目 is a single select, so two exercises are two pages.
		// Titles are not joined with " / ".
		want := []string{"ベンチプレス", "スクワット"}
		for _, exercise := range want {
			body := buildCreatePageBody("ds-1", "－", model.NewExerciseLog{
				Exercise: exercise, WeightKg: 60, Reps: 10, Sets: 3, Difficulty: 3, Date: "2026-10-02",
				Title: "－",
			})
			props := body["properties"].(map[string]any)
			if got := titleContent(t, props, "－"); got != exercise {
				t.Fatalf("title for %s = %q", exercise, got)
			}
		}
		// A single 種目 whose text contains a slash is copied whole.
		slash := notionPageTitle("ベンチプレス / スクワット")
		if slash != "ベンチプレス / スクワット" {
			t.Fatalf("slash name = %q", slash)
		}
	})

	t.Run("empty and odd names", func(t *testing.T) {
		cases := []struct {
			in, want string
		}{
			{in: "", want: "－"},
			{in: "   ", want: "－"},
			{in: "\n\t", want: "－"},
			{in: "\u3000\u3000", want: "－"},
			{in: "  ベンチプレス  ", want: "ベンチプレス"},
			{in: "\u3000スクワット", want: "スクワット"},
			{in: "スクワット\n", want: "スクワット"},
			{in: "－", want: "－"},
			{in: "-", want: "-"},
			{in: "  －  ", want: "－"},
			{in: "ベンチ　プレス", want: "ベンチ　プレス"},
		}
		for _, tc := range cases {
			if got := notionPageTitle(tc.in); got != tc.want {
				t.Fatalf("notionPageTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		}
		body := buildCreatePageBody("ds-1", "－", model.NewExerciseLog{
			Exercise: "  スクワット  ", Title: "－", WeightKg: 80, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
		})
		props := body["properties"].(map[string]any)
		if got := titleContent(t, props, "－"); got != "スクワット" {
			t.Fatalf("padded exercise title = %q", got)
		}
		if props["種目"].(map[string]any)["select"].(map[string]any)["name"] != "スクワット" {
			t.Fatalf("select was not trimmed: %#v", props["種目"])
		}
		blank := buildCreatePageBody("ds-1", "－", model.NewExerciseLog{
			Exercise: "  ", Title: "", WeightKg: 80, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02",
		})
		if got := titleContent(t, blank["properties"].(map[string]any), "－"); got != "－" {
			t.Fatalf("blank exercise title = %q", got)
		}
	})
}

func titleContent(t *testing.T, props map[string]any, property string) string {
	t.Helper()
	titleProp, ok := props[property].(map[string]any)
	if !ok {
		t.Fatalf("missing title property %q in %#v", property, props)
	}
	items, ok := titleProp["title"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("title items = %#v", titleProp["title"])
	}
	text, ok := items[0].(map[string]any)["text"].(map[string]any)
	if !ok {
		t.Fatalf("title text = %#v", items[0])
	}
	content, _ := text["content"].(string)
	return content
}

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
		"下書きID":  map[string]any{"type": "rich_text"},
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
	if titleProp["text"].(map[string]any)["content"] != "スクワット" {
		t.Fatal(titleProp)
	}
	if props["きつさ"].(map[string]any)["select"].(map[string]any)["name"] != "きつい" {
		t.Fatal(props["きつさ"])
	}
	withID := withDraftID(body, "11111111-2222-4333-8444-555555555555")
	draftProp := withID["properties"].(map[string]any)["下書きID"].(map[string]any)
	text := draftProp["rich_text"].([]any)[0].(map[string]any)["text"].(map[string]any)["content"]
	if text != "11111111-2222-4333-8444-555555555555" {
		t.Fatal(draftProp)
	}
	without := schema
	delete(without, "下書きID")
	if _, err := AssertWorkoutSchema(without); err == nil || err.Error() != "プロパティ「下書きID」がありません" {
		t.Fatalf("missing draft id: %v", err)
	}
}
