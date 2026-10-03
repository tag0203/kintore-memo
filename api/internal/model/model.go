// Package model is the JSON shape the React client already parses.
package model

// ExerciseLog is one Notion row, as WorkoutLogClient expects it.
type ExerciseLog struct {
	ID         string  `json:"id"`
	Exercise   string  `json:"exercise"`
	WeightKg   float64 `json:"weightKg"`
	Reps       int     `json:"reps"`
	Sets       int     `json:"sets"`
	Difficulty int     `json:"difficulty"`
	Date       string  `json:"date"`
	Title      string  `json:"title"`
	CreatedAt  string  `json:"createdAt"`
}

// NewExerciseLog is the POST /api/logs body.
type NewExerciseLog struct {
	Exercise   string
	WeightKg   float64
	Reps       int
	Sets       int
	Difficulty int
	Date       string
	Title      string
}

// ExerciseSummary is a catalog or recent-exercise row.
type ExerciseSummary struct {
	Name         string  `json:"name"`
	LastPickedAt *string `json:"lastPickedAt"`
}

// LogPair is the previous and same-day row for one exercise.
type LogPair struct {
	Previous *ExerciseLog `json:"previous"`
	Today    *ExerciseLog `json:"today"`
}

// Bootstrap is GET /api/bootstrap.
type Bootstrap struct {
	Date      string             `json:"date"`
	Exercises []ExerciseSummary  `json:"exercises"`
	Recent    []ExerciseSummary  `json:"recent"`
	Logs      map[string]LogPair `json:"logs"`
}

// Window is the newest Notion page of logs, shared by bootstrap and the GETs.
type Window struct {
	Logs     []ExerciseLog `json:"logs"`
	Complete bool          `json:"complete"`
}

// DayPlan is GET/PUT /api/day-plan. updatedAt is null when the day has no item.
type DayPlan struct {
	Date      string   `json:"date"`
	Memo      string   `json:"memo"`
	Exercises []string `json:"exercises"`
	Finished  bool     `json:"finished"`
	UpdatedAt *string  `json:"updatedAt"`
}
