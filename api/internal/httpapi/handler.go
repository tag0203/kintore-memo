// Package httpapi is the Lambda entry for the workout API.
// API Gateway validates the Cognito JWT. This package does not check the token again,
// except to read sub for DayPlan.
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/model"
	"github.com/tag0203/kintore-memo/api/internal/notion"
	"github.com/tag0203/kintore-memo/api/internal/secrets"
	"github.com/tag0203/kintore-memo/api/internal/syntax"
	"github.com/tag0203/kintore-memo/api/internal/validate"
)

// Deps wires the handler. Tests pass fakes and leave AWS nil.
type Deps struct {
	Env         map[string]string
	Now         func() time.Time
	LoadSecrets func(ctx context.Context, getenv func(string) string) (secrets.Pair, error)
	Cache       cache.Store
	NewClient   func(token, databaseID string) notion.Backend
	DayPlan     dayplan.Store
	Parameters  secrets.Getter
	Dynamo      tableAPI
}

// Handler serves API Gateway HTTP API payload v2.
type Handler struct {
	env         map[string]string
	now         func() time.Time
	loadSecrets func(context.Context, func(string) string) (secrets.Pair, error)
	json        *cache.JSON
	newClient   func(token, databaseID string) notion.Backend
	dayPlan     dayplan.Store
	dynamo      tableAPI

	mu       sync.Mutex
	services map[string]*notion.Service
}

// New builds the production handler when AWS deps are set, or a test handler when fakes are set.
func New(deps Deps) *Handler {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	h := &Handler{
		env:         deps.Env,
		now:         now,
		loadSecrets: deps.LoadSecrets,
		newClient:   deps.NewClient,
		dayPlan:     deps.DayPlan,
		dynamo:      deps.Dynamo,
		services:    map[string]*notion.Service{},
	}
	if h.loadSecrets == nil {
		loader := secrets.NewLoader(deps.Parameters, now)
		h.loadSecrets = loader.Load
	}
	if h.newClient == nil {
		h.newClient = func(token, databaseID string) notion.Backend {
			return notion.NewClient(token, databaseID, nil)
		}
	}
	store := deps.Cache
	if store == nil {
		store = defaultCache(h.getenv, deps.Dynamo, now)
	}
	h.json = cache.NewJSON(store, now)
	return h
}

// tableAPI is the shared DynamoDB port. NotionCache uses Get.
// DayPlan uses GetConsistent so a reload sees the item just written.
type tableAPI interface {
	cache.Remote
	GetConsistent(ctx context.Context, table, pk, sk string, dest any) (bool, error)
}

func defaultCache(getenv func(string) string, api cache.Remote, now func() time.Time) cache.Store {
	memory := cache.NewMemory(now)
	table := strings.TrimSpace(getenv("TABLE_NAME"))
	if table == "" || getenv("NOTION_CACHE") == "memory" || api == nil {
		return memory
	}
	return cache.NewTiered(memory, cache.NewDynamo(table, api, now))
}

// Handle is the Lambda entry.
func (h *Handler) Handle(ctx context.Context, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	method := event.RequestContext.HTTP.Method
	if method == "" {
		method = "GET"
	}
	path := resolvePath(event)
	if method == "OPTIONS" {
		return events.APIGatewayV2HTTPResponse{StatusCode: 204, Body: ""}, nil
	}
	if path == "/api/day-plan" {
		return h.handleDayPlan(ctx, event, method), nil
	}
	if isHealth(event) {
		return jsonResponse(200, healthBody(h.getenv)), nil
	}

	body, status, err := h.route(ctx, event, method, path)
	if err != nil {
		return h.notionError(ctx, event, err), nil
	}
	if status == 0 {
		return jsonResponse(404, map[string]string{"error": "見つかりません"}), nil
	}
	return jsonResponse(status, body), nil
}

func (h *Handler) route(ctx context.Context, event events.APIGatewayV2HTTPRequest, method, path string) (any, int, error) {
	params := searchParams(event)
	switch {
	case method == "GET" && path == "/api/exercises":
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.ListExercises(ctx)
		return body, 200, err
	case method == "GET" && path == "/api/exercises/recent":
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.ListRecentExercises(ctx)
		return body, 200, err
	case method == "GET" && path == "/api/logs/previous":
		exercise, err := validate.AssertExerciseName(params.Get("exercise"))
		if err != nil {
			return nil, 0, err
		}
		before, err := validate.AssertISODate(params.Get("before"), "before")
		if err != nil {
			return nil, 0, err
		}
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.GetPreviousLog(ctx, exercise, before)
		return body, 200, err
	case method == "GET" && path == "/api/logs/today":
		exercise, err := validate.AssertExerciseName(params.Get("exercise"))
		if err != nil {
			return nil, 0, err
		}
		date, err := validate.AssertISODate(params.Get("date"), "date")
		if err != nil {
			return nil, 0, err
		}
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.GetLogOnDate(ctx, exercise, date)
		return body, 200, err
	case method == "GET" && path == "/api/bootstrap":
		date, err := validate.AssertISODate(params.Get("date"), "date")
		if err != nil {
			return nil, 0, err
		}
		names, err := validate.ParseExerciseList(append(append([]string{}, params["exercise"]...), params["exercises"]...))
		if err != nil {
			return nil, 0, err
		}
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.Bootstrap(ctx, date, names)
		return body, 200, err
	case method == "POST" && path == "/api/logs":
		payload, err := readEventJSON(event)
		if err != nil {
			return nil, 0, err
		}
		input, err := validate.ReadCreateBody(payload)
		if err != nil {
			return nil, 0, err
		}
		svc, err := h.service(ctx)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.CreateLog(ctx, model.NewExerciseLog{
			Exercise:   input.Exercise,
			WeightKg:   input.WeightKg,
			Reps:       input.Reps,
			Sets:       input.Sets,
			Difficulty: input.Difficulty,
			Date:       input.Date,
			Title:      input.Title,
		})
		return body, 201, err
	default:
		return nil, 0, nil
	}
}

func (h *Handler) handleDayPlan(ctx context.Context, event events.APIGatewayV2HTTPRequest, method string) events.APIGatewayV2HTTPResponse {
	if method != "GET" && method != "PUT" {
		return jsonResponse(405, map[string]string{
			"error":   "method_not_allowed",
			"message": "GET または PUT を使ってください",
		}, "allow", "GET, PUT")
	}
	if h.dayPlan == nil && strings.TrimSpace(h.getenv("TABLE_NAME")) == "" {
		return jsonResponse(503, map[string]string{
			"error":   "table_unconfigured",
			"message": "TABLE_NAME がありません",
		})
	}
	userID := jwtSubject(event)
	if userID == "" {
		return jsonResponse(401, map[string]string{
			"error":   "unauthorized",
			"message": "ログインが必要です",
		})
	}
	store, err := h.dayPlanStore()
	if err != nil {
		id := logServerError(ctx, event, "day plan failed", err, "DayPlan の読み書きに失敗しました")
		return jsonResponse(502, dayPlanFault(id))
	}
	var result model.DayPlan
	if method == "GET" {
		result, err = dayplan.Get(ctx, store, userID, searchParams(event).Get("date"), h.now())
	} else {
		payload, readErr := readEventJSON(event)
		if readErr != nil {
			err = readErr
		} else {
			result, err = dayplan.Put(ctx, store, userID, payload, h.now())
		}
	}
	if err != nil {
		// A bad stored item is StorageError wrapping ItemValidationError.
		// errors.As unwraps, so storage has to be classified before request validation.
		var stored *dayplan.StorageError
		if !errors.As(err, &stored) {
			var invalid *ddb.ItemValidationError
			if errors.As(err, &invalid) {
				if invalid.Code == "user_id" {
					return jsonResponse(401, map[string]string{
						"error":   "unauthorized",
						"message": "ログインが必要です",
					})
				}
				return jsonResponse(400, map[string]string{"error": invalid.Code, "message": invalid.Error()})
			}
			var syntaxErr *syntax.Error
			if errors.As(err, &syntaxErr) {
				return jsonResponse(400, map[string]string{
					"error":   "invalid_json",
					"message": "JSON を確認してください",
				})
			}
		}
		id := logServerError(ctx, event, "day plan failed", err, "DayPlan の読み書きに失敗しました")
		return jsonResponse(502, dayPlanFault(id))
	}
	return jsonResponse(200, result)
}

func (h *Handler) dayPlanStore() (dayplan.Store, error) {
	if h.dayPlan != nil {
		return h.dayPlan, nil
	}
	table := strings.TrimSpace(h.getenv("TABLE_NAME"))
	if table == "" || h.dynamo == nil {
		return nil, errors.New("TABLE_NAME が設定されていません")
	}
	return dayplan.NewDynamo(table, h.dynamo), nil
}

func (h *Handler) service(ctx context.Context) (*notion.Service, error) {
	pair, err := h.loadSecrets(ctx, h.getenv)
	if err != nil {
		return nil, err
	}
	key := pair.DatabaseID + "\x00" + pair.Token
	h.mu.Lock()
	defer h.mu.Unlock()
	if existing := h.services[key]; existing != nil {
		return existing, nil
	}
	created := notion.NewService(h.newClient(pair.Token, pair.DatabaseID), h.json)
	h.services[key] = created
	return created, nil
}

func (h *Handler) getenv(key string) string {
	if h.env != nil {
		return h.env[key]
	}
	return os.Getenv(key)
}

type health struct {
	OK               bool    `json:"ok"`
	Service          string  `json:"service"`
	Stage            string  `json:"stage"`
	NotionConfigured bool    `json:"notionConfigured"`
	TableName        *string `json:"tableName"`
}

func healthBody(getenv func(string) string) health {
	stage := getenv("ENVIRONMENT")
	if stage == "" {
		stage = "local"
	}
	var table *string
	if name := getenv("TABLE_NAME"); name != "" {
		table = &name
	}
	return health{
		OK:               true,
		Service:          "kintore-memo",
		Stage:            stage,
		NotionConfigured: secrets.Configured(getenv),
		TableName:        table,
	}
}

func resolvePath(event events.APIGatewayV2HTTPRequest) string {
	raw := event.RawPath
	if raw == "" {
		raw = event.RequestContext.HTTP.Path
	}
	stage := event.RequestContext.Stage
	if stage != "" && stage != "$default" && strings.HasPrefix(raw, "/"+stage+"/") {
		trimmed := raw[len(stage)+1:]
		if trimmed == "" {
			return "/"
		}
		return trimmed
	}
	if raw == "" {
		return "/"
	}
	return raw
}

func isHealth(event events.APIGatewayV2HTTPRequest) bool {
	if event.RouteKey == "GET /api/health" {
		return true
	}
	method := event.RequestContext.HTTP.Method
	if method == "" {
		method = "GET"
	}
	return method == "GET" && resolvePath(event) == "/api/health"
}

func searchParams(event events.APIGatewayV2HTTPRequest) url.Values {
	if event.RawQueryString != "" {
		values, err := url.ParseQuery(event.RawQueryString)
		if err == nil {
			return values
		}
	}
	values := url.Values{}
	for key, value := range event.QueryStringParameters {
		values.Set(key, value)
	}
	return values
}

func readEventJSON(event events.APIGatewayV2HTTPRequest) (any, error) {
	if event.Body == "" {
		return map[string]any{}, nil
	}
	raw := event.Body
	if event.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(event.Body)
		if err != nil {
			return nil, &syntax.Error{Err: err}
		}
		raw = string(decoded)
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, &syntax.Error{Err: err}
	}
	// JSON.parse rejects a second value. Decoder.Decode stops after the first.
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("unexpected trailing JSON")
		}
		return nil, &syntax.Error{Err: err}
	}
	return value, nil
}

func jwtSubject(event events.APIGatewayV2HTTPRequest) string {
	auth := event.RequestContext.Authorizer
	if auth == nil || auth.JWT == nil {
		return ""
	}
	return auth.JWT.Claims["sub"]
}

func dayPlanFault(requestID string) map[string]string {
	body := map[string]string{
		"error":   "storage",
		"message": "DayPlan の読み書きに失敗しました",
	}
	if requestID != "" {
		body["requestId"] = requestID
	}
	return body
}

func jsonResponse(status int, body any, headerPairs ...string) events.APIGatewayV2HTTPResponse {
	headers := map[string]string{"content-type": "application/json; charset=utf-8"}
	for i := 0; i+1 < len(headerPairs); i += 2 {
		headers[headerPairs[i]] = headerPairs[i+1]
	}
	raw, err := marshalJSON(body)
	if err != nil {
		raw = []byte(`{"error":"サーバーでエラーが発生しました"}`)
		status = 500
	}
	return events.APIGatewayV2HTTPResponse{StatusCode: status, Headers: headers, Body: string(raw)}
}

func marshalJSON(body any) ([]byte, error) {
	var buf strings.Builder
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(buf.String(), "\n")), nil
}
