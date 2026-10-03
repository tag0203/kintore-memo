// Package validate checks API input against the screen rules in src/domain.ts.
package validate

import (
	"math"
	"unicode/utf8"
)

// Error is a 400 from the caller, not from Notion.
type Error struct {
	Msg string
}

func (e *Error) Error() string { return e.Msg }

func fail(message string) error {
	return &Error{Msg: message}
}

// IsISODate reports whether value is a real YYYY-MM-DD day.
func IsISODate(value string) bool {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return false
	}
	// Reuse the calendar check from the date parser without importing ddb
	// (request errors use different messages).
	year, month, day, ok := splitDate(value)
	if !ok {
		return false
	}
	return validDate(year, month, day)
}

// IsValidWeightKg matches the screen: 0 < weight <= 999, at most two decimals.
func IsValidWeightKg(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > 999 {
		return false
	}
	cents := math.Round(value * 100)
	return math.Abs(value*100-cents) < 1e-6
}

// IsValidCount is an integer from 1 through 999.
func IsValidCount(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return false
	}
	return value > 0 && value <= 999
}

// IsDifficulty is 1 through 5.
func IsDifficulty(value float64) bool {
	return value == 1 || value == 2 || value == 3 || value == 4 || value == 5
}

// AssertExerciseName trims a cache-safe exercise name (no '#' or controls).
func AssertExerciseName(value string) (string, error) {
	name := trimSpace(value)
	length := utf8.RuneCountInString(name)
	if name == "" || length > 80 {
		return "", fail("種目名を確認してください")
	}
	if hasControl(name) || containsHash(name) {
		return "", fail("種目名を確認してください")
	}
	return name, nil
}

// AssertISODate returns value or a 400 naming the query field.
func AssertISODate(value, label string) (string, error) {
	if !IsISODate(value) {
		return "", fail(label + " は YYYY-MM-DD で指定してください")
	}
	return value, nil
}

// CreateInput is a checked POST /api/logs body.
type CreateInput struct {
	Exercise   string
	WeightKg   float64
	Reps       int
	Sets       int
	Difficulty int
	Date       string
	Title      string
	HasTitle   bool
}

// ReadCreateBody checks the JSON object the screen posts.
func ReadCreateBody(value any) (CreateInput, error) {
	body, ok := value.(map[string]any)
	if !ok || value == nil {
		return CreateInput{}, fail("記録の形式を確認してください")
	}
	exercise, ok := body["exercise"].(string)
	if !ok {
		return CreateInput{}, fail("種目名を確認してください")
	}
	name, err := AssertExerciseName(exercise)
	if err != nil {
		return CreateInput{}, err
	}
	weight, ok := asFloat(body["weightKg"])
	if !ok || !IsValidWeightKg(weight) {
		return CreateInput{}, fail("重量を確認してください")
	}
	reps, ok := asFloat(body["reps"])
	if !ok || !IsValidCount(reps) {
		return CreateInput{}, fail("回数を確認してください")
	}
	sets, ok := asFloat(body["sets"])
	if !ok || !IsValidCount(sets) {
		return CreateInput{}, fail("セット数を確認してください")
	}
	difficulty, ok := asFloat(body["difficulty"])
	if !ok || !IsDifficulty(difficulty) {
		return CreateInput{}, fail("きつさを確認してください")
	}
	date, ok := body["date"].(string)
	if !ok {
		return CreateInput{}, fail("日付 は YYYY-MM-DD で指定してください")
	}
	checkedDate, err := AssertISODate(date, "日付")
	if err != nil {
		return CreateInput{}, err
	}
	input := CreateInput{
		Exercise:   name,
		WeightKg:   math.Round(weight*100) / 100,
		Reps:       int(reps),
		Sets:       int(sets),
		Difficulty: int(difficulty),
		Date:       checkedDate,
	}
	if raw, present := body["title"]; present {
		title, ok := raw.(string)
		if !ok {
			return CreateInput{}, fail("タイトルを確認してください")
		}
		trimmed := trimSpace(title)
		if utf8.RuneCountInString(trimmed) > 200 || hasControl(trimmed) {
			return CreateInput{}, fail("タイトルを確認してください")
		}
		input.Title = trimmed
		input.HasTitle = trimmed != ""
	}
	return input, nil
}

// ParseExerciseList accepts repeated names and comma-separated names. Cap is 40.
func ParseExerciseList(values []string) ([]string, error) {
	names := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range splitComma(value) {
			trimmed := trimSpace(part)
			if trimmed == "" {
				continue
			}
			name, err := AssertExerciseName(trimmed)
			if err != nil {
				return nil, err
			}
			names = append(names, name)
		}
	}
	if len(names) > 40 {
		return nil, fail("種目は40件までです")
	}
	seen := make(map[string]struct{}, len(names))
	out := make([]string, 0, len(names))
	for _, name := range names {
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out, nil
}
