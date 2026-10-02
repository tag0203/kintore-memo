package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/model"
	"github.com/tag0203/kintore-memo/api/internal/notion"
	"github.com/tag0203/kintore-memo/api/internal/secrets"
)

const userID = "11111111-2222-4333-8444-555555555555"

func httpEvent(method, rawPath, stage, query, body string, encoded bool) events.APIGatewayV2HTTPRequest {
	path := rawPath
	if stage != "" && stage != "$default" && len(rawPath) > len(stage)+1 && rawPath[len(stage)+1] == '/' {
		path = rawPath[len(stage)+1:]
	}
	return events.APIGatewayV2HTTPRequest{
		RouteKey:        method + " " + path,
		RawPath:         rawPath,
		RawQueryString:  query,
		Body:            body,
		IsBase64Encoded: encoded,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			Stage: stage,
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: method,
				Path:   rawPath,
			},
		},
	}
}

var squat = model.ExerciseLog{
	ID: "page-1", Exercise: "スクワット", WeightKg: 80, Reps: 11, Sets: 3,
	Difficulty: 3, Date: "2026-09-25", Title: "－", CreatedAt: "2026-09-25T12:00:00.000Z",
}

type fakeBackend struct {
	calls   []string
	created int
	window  model.Window
	fail    error
}

func (f *fakeBackend) ListExercises(context.Context) ([]model.ExerciseSummary, error) {
	f.calls = append(f.calls, "exercises")
	if f.fail != nil {
		return nil, f.fail
	}
	return []model.ExerciseSummary{{Name: "スクワット"}}, nil
}

func (f *fakeBackend) LoadRecentWindow(context.Context) (model.Window, error) {
	f.calls = append(f.calls, "recent")
	if f.window.Logs == nil && !f.window.Complete {
		return model.Window{Logs: []model.ExerciseLog{squat}, Complete: true}, nil
	}
	return f.window, nil
}

func (f *fakeBackend) GetPreviousLog(context.Context, string, string) (*model.ExerciseLog, error) {
	f.calls = append(f.calls, "previous")
	return nil, nil
}

func (f *fakeBackend) GetLogOnDate(context.Context, string, string) (*model.ExerciseLog, error) {
	f.calls = append(f.calls, "today")
	return nil, nil
}

func (f *fakeBackend) CreateLog(_ context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	f.created++
	f.calls = append(f.calls, "create")
	created := squat
	created.ID = "new"
	created.Exercise = input.Exercise
	created.WeightKg = input.WeightKg
	created.Reps = input.Reps
	created.Sets = input.Sets
	created.Difficulty = input.Difficulty
	created.Date = input.Date
	created.Title = "－"
	created.CreatedAt = "2026-10-02T01:00:00.000Z"
	return created, nil
}

func testHandler(backend notion.Backend, env map[string]string, plans dayplan.Store) *Handler {
	if env == nil {
		env = map[string]string{}
	}
	clock := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	return New(Deps{
		Env: env,
		Now: func() time.Time { return clock },
		LoadSecrets: func(context.Context, func(string) string) (secrets.Pair, error) {
			return secrets.Pair{Token: "secret_token", DatabaseID: "db-1"}, nil
		},
		Cache: cache.NewMemory(func() time.Time { return clock }),
		NewClient: func(string, string) notion.Backend {
			return backend
		},
		DayPlan: plans,
	})
}

func TestHealthAndStagePath(t *testing.T) {
	h := New(Deps{Env: map[string]string{
		"ENVIRONMENT": "dev", "TABLE_NAME": "kintore-memo-dev",
		"NOTION_TOKEN": "secret_token", "NOTION_DATABASE_ID": "db-1",
	}})
	event := httpEvent("GET", "/dev/api/health", "dev", "", "", false)
	event.RouteKey = "GET /api/health"
	res, err := h.Handle(context.Background(), event)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health %d %v", res.StatusCode, err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(res.Body), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true || body["service"] != "kintore-memo" || body["stage"] != "dev" || body["notionConfigured"] != true || body["tableName"] != "kintore-memo-dev" {
		t.Fatalf("body = %s", res.Body)
	}
	if strings.Contains(res.Body, "secret_token") {
		t.Fatal("health echoed the token")
	}

	for _, stage := range []string{"staging", "prod"} {
		event = httpEvent("GET", "/"+stage+"/api/health", stage, "", "", false)
		event.RouteKey = "GET /api/health"
		res, _ = h.Handle(context.Background(), event)
		if res.StatusCode != 200 {
			t.Fatalf("%s health %d", stage, res.StatusCode)
		}
	}
}

func TestExercisesBootstrapAndLogs(t *testing.T) {
	backend := &fakeBackend{}
	h := testHandler(backend, nil, nil)
	res, _ := h.Handle(context.Background(), httpEvent("GET", "/dev/api/exercises", "dev", "", "", false))
	if res.StatusCode != 200 || res.Body != `[{"name":"スクワット","lastPickedAt":null}]` {
		t.Fatalf("exercises %d %s", res.StatusCode, res.Body)
	}

	res, _ = h.Handle(context.Background(), httpEvent("GET", "/dev/api/bootstrap", "dev", "date=2026-10-02&exercise=%E3%82%B9%E3%82%AF%E3%83%AF%E3%83%83%E3%83%88", "", false))
	if res.StatusCode != 200 {
		t.Fatalf("bootstrap %d %s", res.StatusCode, res.Body)
	}
	var boot model.Bootstrap
	if err := json.Unmarshal([]byte(res.Body), &boot); err != nil {
		t.Fatal(err)
	}
	pair := boot.Logs["スクワット"]
	if pair.Previous == nil || pair.Previous.WeightKg != 80 || pair.Previous.Date != "2026-09-25" || pair.Today != nil {
		t.Fatalf("logs = %#v", pair)
	}
	if strings.Contains(res.Body, "secret_token") {
		t.Fatal("bootstrap echoed the token")
	}

	res, _ = h.Handle(context.Background(), httpEvent("GET", "/api/logs/today", "$default", "exercise=スクワット&date=2026-10-02", "", false))
	if res.StatusCode != 200 || res.Body != "null" {
		t.Fatalf("today %d %s", res.StatusCode, res.Body)
	}
	options, _ := h.Handle(context.Background(), httpEvent("OPTIONS", "/api/logs", "$default", "", "", false))
	if options.StatusCode != 204 || options.Body != "" {
		t.Fatalf("options %d %q", options.StatusCode, options.Body)
	}
}

func TestCreateLogValidationAndBase64(t *testing.T) {
	backend := &fakeBackend{}
	h := testHandler(backend, nil, nil)
	bad := `{"exercise":"スクワット","weightKg":-20,"reps":11,"sets":3,"difficulty":3,"date":"2026-10-02"}`
	res, _ := h.Handle(context.Background(), httpEvent("POST", "/dev/api/logs", "dev", "", bad, false))
	if res.StatusCode != 400 || backend.created != 0 {
		t.Fatalf("invalid %d created %d %s", res.StatusCode, backend.created, res.Body)
	}

	payload := `{"exercise":"スクワット","weightKg":82.5,"reps":11,"sets":3,"difficulty":3,"date":"2026-10-02"}`
	res, _ = h.Handle(context.Background(), httpEvent("POST", "/api/logs", "$default", "", base64.StdEncoding.EncodeToString([]byte(payload)), true))
	if res.StatusCode != 201 || backend.created != 1 || !strings.Contains(res.Body, `"weightKg":82.5`) || strings.Contains(res.Body, "secret_token") {
		t.Fatalf("create %d %s", res.StatusCode, res.Body)
	}
}

func TestMissingConfigAndRedaction(t *testing.T) {
	h := New(Deps{Env: map[string]string{}})
	missing, _ := h.Handle(context.Background(), httpEvent("GET", "/dev/api/exercises", "dev", "", "", false))
	if missing.StatusCode != 500 || !strings.Contains(missing.Body, "設定がありません") {
		t.Fatalf("missing %d %s", missing.StatusCode, missing.Body)
	}
	unknown, _ := h.Handle(context.Background(), httpEvent("GET", "/dev/api/unknown", "dev", "", "", false))
	if unknown.StatusCode != 404 {
		t.Fatalf("unknown %d %s", unknown.StatusCode, unknown.Body)
	}

	backend := &fakeBackend{fail: errString("Notion API: unauthorized ntn_secretvalue")}
	h = testHandler(backend, nil, nil)
	res, _ := h.Handle(context.Background(), httpEvent("GET", "/api/exercises", "$default", "", "", false))
	if res.StatusCode != 502 || strings.Contains(res.Body, "ntn_secretvalue") || !strings.Contains(res.Body, "[redacted]") {
		t.Fatalf("redact %d %s", res.StatusCode, res.Body)
	}
}

func TestDayPlanContract(t *testing.T) {
	store := dayplan.NewMemory()
	h := testHandler(&fakeBackend{}, map[string]string{}, store)
	event := httpEvent("GET", "/dev/api/day-plan", "dev", "date=2026-10-02", "", false)
	event.RequestContext.Authorizer = jwtAuth(userID)
	res, _ := h.Handle(context.Background(), event)
	if res.StatusCode != 200 || res.Body != `{"date":"2026-10-02","memo":"","exercises":[],"finished":false,"updatedAt":null}` {
		t.Fatalf("empty %d %s", res.StatusCode, res.Body)
	}

	body := `{"date":"2026-10-02","memo":"脚","exercises":["スクワット","レッグプレス"],"finished":false}`
	put := httpEvent("PUT", "/api/day-plan", "$default", "", body, false)
	put.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), put)
	if res.StatusCode != 200 || !strings.Contains(res.Body, `"memo":"脚"`) || !strings.Contains(res.Body, `"updatedAt":"2026-10-02T00:00:00.000Z"`) {
		t.Fatalf("put %d %s", res.StatusCode, res.Body)
	}
	res, _ = h.Handle(context.Background(), event)
	if !strings.Contains(res.Body, `"memo":"脚"`) || !strings.Contains(res.Body, "レッグプレス") {
		t.Fatalf("get after put %s", res.Body)
	}

	noUser := httpEvent("GET", "/api/day-plan", "$default", "date=2026-10-02", "", false)
	res, _ = h.Handle(context.Background(), noUser)
	if res.StatusCode != 401 || !strings.Contains(res.Body, `"error":"unauthorized"`) {
		t.Fatalf("anon %d %s", res.StatusCode, res.Body)
	}

	unconfigured := testHandler(&fakeBackend{}, map[string]string{}, nil)
	res, _ = unconfigured.Handle(context.Background(), event)
	if res.StatusCode != 503 || !strings.Contains(res.Body, "table_unconfigured") {
		t.Fatalf("table %d %s", res.StatusCode, res.Body)
	}

	post := httpEvent("POST", "/api/day-plan", "$default", "", body, false)
	post.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), post)
	if res.StatusCode != 405 || res.Headers["allow"] != "GET, PUT" {
		t.Fatalf("method %d %v", res.StatusCode, res.Headers)
	}

	emptyBody := httpEvent("PUT", "/api/day-plan", "$default", "", `{}`, false)
	emptyBody.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), emptyBody)
	if res.StatusCode != 400 || !strings.Contains(res.Body, `"error":"date"`) {
		t.Fatalf("empty body %d %s", res.StatusCode, res.Body)
	}

	far := httpEvent("PUT", "/api/day-plan", "$default", "", `{"date":"2099-01-01","memo":"脚","exercises":[],"finished":false}`, false)
	far.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), far)
	if res.StatusCode != 400 || !strings.Contains(res.Body, `"error":"date_window"`) {
		t.Fatalf("window %d %s", res.StatusCode, res.Body)
	}
}

func jwtAuth(sub string) *events.APIGatewayV2HTTPRequestContextAuthorizerDescription {
	return &events.APIGatewayV2HTTPRequestContextAuthorizerDescription{
		JWT: &events.APIGatewayV2HTTPRequestContextAuthorizerJWTDescription{
			Claims: map[string]string{"sub": sub},
		},
	}
}

type errString string

func (e errString) Error() string { return string(e) }
