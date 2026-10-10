package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
	"github.com/aws/smithy-go"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
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

func (f *fakeBackend) GetPreviousLog(context.Context, string, string) ([]model.ExerciseLog, error) {
	f.calls = append(f.calls, "previous")
	return []model.ExerciseLog{}, nil
}

func (f *fakeBackend) GetLogOnDate(context.Context, string, string) ([]model.ExerciseLog, error) {
	f.calls = append(f.calls, "today")
	return []model.ExerciseLog{}, nil
}

func (f *fakeBackend) CreateLog(_ context.Context, input model.NewExerciseLog) (model.ExerciseLog, error) {
	f.created++
	f.calls = append(f.calls, "create")
	if f.fail != nil {
		return model.ExerciseLog{}, f.fail
	}
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
	if res.Body != `{"ok":true}` || len(body) != 1 || body["ok"] != true {
		t.Fatalf("body = %s", res.Body)
	}
	for _, key := range []string{"service", "stage", "notionConfigured", "tableName", "secret_token", "kintore-memo-dev"} {
		if strings.Contains(res.Body, key) {
			t.Fatalf("health included %s: %s", key, res.Body)
		}
	}

	for _, stage := range []string{"staging", "prod"} {
		event = httpEvent("GET", "/"+stage+"/api/health", stage, "", "", false)
		event.RouteKey = "GET /api/health"
		res, _ = h.Handle(context.Background(), event)
		if res.StatusCode != 200 || res.Body != `{"ok":true}` {
			t.Fatalf("%s health %d %s", stage, res.StatusCode, res.Body)
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
	if len(pair.Previous) != 1 || pair.Previous[0].WeightKg != 80 || pair.Previous[0].Date != "2026-09-25" || len(pair.Today) != 0 {
		t.Fatalf("logs = %#v", pair)
	}
	if strings.Contains(res.Body, "secret_token") {
		t.Fatal("bootstrap echoed the token")
	}

	res, _ = h.Handle(context.Background(), httpEvent("GET", "/api/logs/today", "$default", "exercise=スクワット&date=2026-10-02", "", false))
	if res.StatusCode != 200 || res.Body != "[]" {
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
	if res.StatusCode != 400 || backend.created != 0 || strings.Contains(res.Body, "requestId") {
		t.Fatalf("invalid %d created %d %s", res.StatusCode, backend.created, res.Body)
	}

	payload := `{"exercise":"スクワット","weightKg":82.5,"reps":11,"sets":3,"difficulty":3,"date":"2026-10-02"}`
	trailing, _ := h.Handle(context.Background(), httpEvent("POST", "/api/logs", "$default", "", payload+`{"extra":1}`, false))
	if trailing.StatusCode != 400 || backend.created != 0 || !strings.Contains(trailing.Body, "JSON を確認してください") {
		t.Fatalf("trailing %d created %d %s", trailing.StatusCode, backend.created, trailing.Body)
	}
	spaced, _ := h.Handle(context.Background(), httpEvent("POST", "/api/logs", "$default", "", payload+"\n", false))
	if spaced.StatusCode != 201 || backend.created != 1 {
		t.Fatalf("whitespace %d created %d %s", spaced.StatusCode, backend.created, spaced.Body)
	}
	res, _ = h.Handle(context.Background(), httpEvent("POST", "/api/logs", "$default", "", base64.StdEncoding.EncodeToString([]byte(payload)), true))
	if res.StatusCode != 201 || backend.created != 2 || !strings.Contains(res.Body, `"weightKg":82.5`) || strings.Contains(res.Body, "secret_token") {
		t.Fatalf("create %d %s", res.StatusCode, res.Body)
	}
}

func TestMissingConfigAndRedaction(t *testing.T) {
	h := New(Deps{Env: map[string]string{}})
	missing, _ := h.Handle(context.Background(), httpEvent("GET", "/dev/api/exercises", "dev", "", "", false))
	if missing.StatusCode != 500 || !strings.Contains(missing.Body, msgServer) || strings.Contains(missing.Body, "設定がありません") {
		t.Fatalf("missing %d %s", missing.StatusCode, missing.Body)
	}
	unknown, _ := h.Handle(context.Background(), httpEvent("GET", "/dev/api/unknown", "dev", "", "", false))
	if unknown.StatusCode != 404 {
		t.Fatalf("unknown %d %s", unknown.StatusCode, unknown.Body)
	}
}

func TestUpstreamErrorsDoNotLeak(t *testing.T) {
	const (
		account  = "123456789012"
		notionID = "a1b2c3d4-e5f6-4789-a123-ef1234567890"
		bareID   = "a1b2c3d4e5f64789a123ef1234567890"
		token    = "ntn_secretvalue"
		marker   = "body-marker-do-not-log"
	)
	roleARN := "arn:aws:sts::" + account + ":assumed-role/kintore-memo-dev-api/fn"
	paramARN := "arn:aws:ssm:ap-northeast-1:" + account + ":parameter/kintore/notion-token"
	pageURL := "https://api.notion.com/v1/databases/" + notionID
	leaks := []string{account, notionID, bareID, token, roleARN, paramARN, pageURL, "Bearer " + token, marker}

	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	assertSafe := func(t *testing.T, status int, body, public, requestID, typeName string) {
		t.Helper()
		if status != 0 && !strings.Contains(body, fmt.Sprintf(`"error":"%s"`, public)) {
			t.Fatalf("public message missing from %s", body)
		}
		if requestID != "" && !strings.Contains(body, requestID) {
			t.Fatalf("requestId missing from %s", body)
		}
		assertNoLeak(t, body, leaks)
		logged := logs.String()
		if !strings.Contains(logged, typeName) || !strings.Contains(logged, public) || !strings.Contains(logged, "[redacted]") {
			t.Fatalf("log = %s", logged)
		}
		assertNoLeak(t, logged, leaks)
	}

	t.Run("ssm access denied", func(t *testing.T) {
		logs.Reset()
		h := New(Deps{
			LoadSecrets: func(context.Context, func(string) string) (secrets.Pair, error) {
				return secrets.Pair{}, &smithy.OperationError{
					ServiceID:     "SSM",
					OperationName: "GetParameter",
					Err: &smithy.GenericAPIError{
						Code: "AccessDeniedException",
						Message: fmt.Sprintf(
							"User: %s is not authorized to perform: ssm:GetParameter on resource: %s account %s token %s",
							roleARN, paramARN, account, token,
						),
					},
				}
			},
		})
		event := httpEvent("GET", "/api/exercises", "$default", "", "", false)
		event.RequestContext.RequestID = "ZoG1fH0oIAMEjeg="
		event.Headers = map[string]string{"authorization": "Bearer " + token}
		ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"})
		res, err := h.Handle(ctx, event)
		if err != nil || res.StatusCode != 502 {
			t.Fatalf("ssm %d %v %s", res.StatusCode, err, res.Body)
		}
		if strings.Contains(res.Body, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") {
			t.Fatalf("lambda uuid was returned: %s", res.Body)
		}
		if !strings.Contains(logs.String(), "lambdaRequestId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") {
			t.Fatalf("lambda id missing from log: %s", logs.String())
		}
		assertSafe(t, res.StatusCode, res.Body, msgServer, "ZoG1fH0oIAMEjeg=", "*smithy.OperationError")
	})

	t.Run("notion 404", func(t *testing.T) {
		logs.Reset()
		message := fmt.Sprintf(
			"Notion API: Could not find database with ID: %s. See %s token %s bare %s",
			notionID, pageURL, token, bareID,
		)
		h := testHandler(&fakeBackend{fail: errString(message)}, nil, nil)
		event := httpEvent("GET", "/api/exercises", "$default", "", "", false)
		event.RequestContext.RequestID = "K1x7Ejy1iYcEJew="
		res, err := h.Handle(context.Background(), event)
		if err != nil || res.StatusCode != 502 {
			t.Fatalf("notion %d %v %s", res.StatusCode, err, res.Body)
		}
		assertSafe(t, res.StatusCode, res.Body, msgNotion, "K1x7Ejy1iYcEJew=", "httpapi.errString")
	})

	t.Run("network url", func(t *testing.T) {
		logs.Reset()
		cause := &url.Error{
			Op:  "Get",
			URL: pageURL,
			Err: errors.New("dial tcp: lookup api.notion.com: no such host token " + token + " id " + notionID),
		}
		h := testHandler(&fakeBackend{fail: cause}, nil, nil)
		body := fmt.Sprintf(
			`{"exercise":"スクワット","weightKg":80,"reps":8,"sets":3,"difficulty":3,"date":"2026-10-02","title":"%s"}`,
			marker,
		)
		event := httpEvent("POST", "/api/logs", "$default", "", body, false)
		event.RequestContext.RequestID = "VJ6r1Gq1iYcEJ9A="
		event.Headers = map[string]string{"authorization": "Bearer " + token}
		res, err := h.Handle(context.Background(), event)
		if err != nil || res.StatusCode != 502 {
			t.Fatalf("url %d %v %s", res.StatusCode, err, res.Body)
		}
		assertSafe(t, res.StatusCode, res.Body, msgNotion, "VJ6r1Gq1iYcEJ9A=", "*url.Error")
	})

	t.Run("unknown", func(t *testing.T) {
		logs.Reset()
		h := testHandler(&fakeBackend{fail: errString("unexpected failure token " + token + " " + pageURL)}, nil, nil)
		event := httpEvent("GET", "/api/exercises", "$default", "", "", false)
		event.RequestContext.RequestID = "JMJ4sH2oIAMEjeg="
		res, err := h.Handle(context.Background(), event)
		if err != nil || res.StatusCode != 500 {
			t.Fatalf("unknown %d %v %s", res.StatusCode, err, res.Body)
		}
		assertSafe(t, res.StatusCode, res.Body, msgServer, "JMJ4sH2oIAMEjeg=", "httpapi.errString")
	})

	t.Run("uuid request id omitted", func(t *testing.T) {
		logs.Reset()
		h := testHandler(&fakeBackend{fail: errString("Notion API: upstream failed")}, nil, nil)
		event := httpEvent("GET", "/api/exercises", "$default", "", "", false)
		event.RequestContext.RequestID = notionID
		ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"})
		res, err := h.Handle(ctx, event)
		if err != nil || res.StatusCode != 502 {
			t.Fatalf("uuid id %d %v %s", res.StatusCode, err, res.Body)
		}
		if strings.Contains(res.Body, "requestId") || strings.Contains(res.Body, notionID) {
			t.Fatalf("uuid request id leaked: %s", res.Body)
		}
		if !strings.Contains(logs.String(), "lambdaRequestId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") {
			t.Fatalf("lambda id missing from log: %s", logs.String())
		}
	})
}

func assertNoLeak(t *testing.T, body string, leaks []string) {
	t.Helper()
	for _, leak := range leaks {
		if leak != "" && strings.Contains(body, leak) {
			t.Fatalf("leaked %q in %s", leak, body)
		}
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

	garbage := httpEvent("PUT", "/api/day-plan", "$default", "", body+` true`, false)
	garbage.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), garbage)
	if res.StatusCode != 400 || !strings.Contains(res.Body, `"error":"invalid_json"`) {
		t.Fatalf("trailing day plan %d %s", res.StatusCode, res.Body)
	}
	res, _ = h.Handle(context.Background(), event)
	if !strings.Contains(res.Body, `"memo":"脚"`) {
		t.Fatalf("trailing write landed %s", res.Body)
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

	broken := dayplan.NewMemory()
	if err := broken.Put(context.Background(), ddb.DayPlanItem{
		PK: "USER#" + userID, SK: "DAY#2026-10-02", EntityType: "LegacyPlan",
		UserID: userID, Date: "2026-10-02", Memo: "脚", Exercises: []string{"スクワット"},
		UpdatedAt: "2026-10-02T00:00:00.000Z", TTL: 1,
	}); err != nil {
		t.Fatal(err)
	}
	h = testHandler(&fakeBackend{}, map[string]string{}, broken)
	res, _ = h.Handle(context.Background(), event)
	if res.StatusCode != 502 || !strings.Contains(res.Body, `"error":"storage"`) || strings.Contains(res.Body, "entity_type") {
		t.Fatalf("stored %d %s", res.StatusCode, res.Body)
	}

	ttl, err := ddb.DayPlanTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	omitted := dayplan.NewMemory()
	if err := omitted.Put(context.Background(), ddb.DayPlanItem{
		PK: "USER#" + userID, SK: "DAY#2026-10-02", EntityType: ddb.EntityDayPlan,
		UserID: userID, Date: "2026-10-02", Memo: "", Exercises: []string{}, Finished: false,
		UpdatedAt: "2026-10-02T00:00:00.000Z", TTL: ttl,
	}); err != nil {
		t.Fatal(err)
	}
	h = testHandler(&fakeBackend{}, map[string]string{}, omitted)
	res, _ = h.Handle(context.Background(), event)
	if res.StatusCode != 502 || !strings.Contains(res.Body, `"error":"storage"`) || strings.Contains(res.Body, `"exercises":[]`) {
		t.Fatalf("omitted %d %s", res.StatusCode, res.Body)
	}

	blank := dayplan.NewMemory()
	h = testHandler(&fakeBackend{}, map[string]string{}, blank)
	emptyMenu := httpEvent("PUT", "/api/day-plan", "$default", "", `{"date":"2026-10-02","memo":"","exercises":[],"finished":false}`, false)
	emptyMenu.RequestContext.Authorizer = jwtAuth(userID)
	res, _ = h.Handle(context.Background(), emptyMenu)
	if res.StatusCode != 200 || !strings.Contains(res.Body, `"memo":""`) || !strings.Contains(res.Body, `"exercises":[]`) || !strings.Contains(res.Body, `"finished":false`) {
		t.Fatalf("empty menu put %d %s", res.StatusCode, res.Body)
	}
	res, _ = h.Handle(context.Background(), event)
	if res.StatusCode != 200 || !strings.Contains(res.Body, `"exercises":[]`) || !strings.Contains(res.Body, `"finished":false`) {
		t.Fatalf("empty menu get %d %s", res.StatusCode, res.Body)
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
