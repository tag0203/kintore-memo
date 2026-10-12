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
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/tag0203/kintore-memo/api/internal/cache"
	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/draft"
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
	Drafts      draft.Store
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
	drafts      draft.Store
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
		drafts:      deps.Drafts,
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
	PutIf(ctx context.Context, table string, item any, previousVersion int, exists bool) error
	DeleteIf(ctx context.Context, table, pk, sk string, previousVersion int) error
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
		return jsonResponse(200, healthBody()), nil
	}

	body, status, err := h.route(ctx, event, method, path)
	if err != nil {
		if resp, ok := h.draftHTTPError(ctx, event, err); ok {
			return resp, nil
		}
		return h.notionError(ctx, event, err), nil
	}
	if status == 204 {
		return events.APIGatewayV2HTTPResponse{StatusCode: 204}, nil
	}
	if status == 0 {
		return jsonResponse(404, map[string]string{"error": "見つかりません"}), nil
	}
	return jsonResponse(status, body), nil
}

// HandleFlush is the nightly Lambda. It writes unfinished days that are at
// least two Tokyo calendar days old. The event is not logged.
func (h *Handler) HandleFlush(ctx context.Context, _ events.CloudWatchEvent) error {
	svc, err := h.flushService(ctx)
	if err != nil {
		log.Printf("draft flush unavailable %T detail=%s", err, redact(err.Error()))
		return errors.New("draft flush unavailable")
	}
	due, err := svc.Due(ctx, h.now())
	if err != nil {
		log.Printf("draft flush list failed %T detail=%s", err, redact(err.Error()))
		return errors.New("draft flush failed")
	}
	failed := 0
	for _, day := range due {
		ready, dueErr := ddb.IsAutoFlushDue(day.Date, h.now())
		if dueErr != nil || !ready {
			continue
		}
		result, flushErr := svc.Flush(ctx, day.UserID, day.Date, h.now(), false)
		if flushErr != nil || !result.Synced {
			failed++
			detail := ""
			if flushErr != nil {
				detail = redact(flushErr.Error())
			}
			log.Printf("draft flush failed date=%s synced=%t detail=%s", day.Date, result.Synced, detail)
		}
	}
	if failed > 0 {
		return errors.New("draft flush incomplete")
	}
	return nil
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
		if err != nil {
			return nil, 0, err
		}
		body, err = h.overlayPrevious(ctx, event, exercise, before, body)
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
		if err != nil {
			return nil, 0, err
		}
		body, err = h.overlayToday(ctx, event, exercise, date, body)
		return body, 200, err
	case method == "GET" && path == "/api/drafts":
		date, err := validate.AssertISODate(params.Get("date"), "date")
		if err != nil {
			return nil, 0, err
		}
		svc, err := h.draftCRUD()
		if err != nil {
			return h.draftUnavailable(err)
		}
		userID, err := h.requireUser(event)
		if err != nil {
			return nil, 0, err
		}
		body, err := svc.List(ctx, userID, date, h.now())
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
		if err != nil {
			return nil, 0, err
		}
		body, err = h.overlayBootstrap(ctx, event, body)
		return body, 200, err
	case method == "POST" && path == "/api/logs":
		return h.createDraft(ctx, event)
	case method == "PUT" && strings.HasPrefix(path, "/api/logs/"):
		return h.updateDraft(ctx, event, strings.TrimPrefix(path, "/api/logs/"))
	case method == "DELETE" && strings.HasPrefix(path, "/api/logs/"):
		return h.deleteDraft(ctx, event, strings.TrimPrefix(path, "/api/logs/"))
	case method == "POST" && strings.HasPrefix(path, "/api/day/") && strings.HasSuffix(path, "/finish"):
		date := strings.TrimSuffix(strings.TrimPrefix(path, "/api/day/"), "/finish")
		return h.finishDay(ctx, event, date)
	default:
		return nil, 0, nil
	}
}

func (h *Handler) createDraft(ctx context.Context, event events.APIGatewayV2HTTPRequest) (any, int, error) {
	payload, err := readEventJSON(event)
	if err != nil {
		return nil, 0, err
	}
	input, err := validate.ReadCreateBody(payload)
	if err != nil {
		return nil, 0, err
	}
	userID, err := h.requireUser(event)
	if err != nil {
		return nil, 0, err
	}
	svc, err := h.draftCRUD()
	if err != nil {
		return h.draftUnavailable(err)
	}
	body, err := svc.Create(ctx, userID, input, h.now())
	return body, 201, err
}

func (h *Handler) updateDraft(ctx context.Context, event events.APIGatewayV2HTTPRequest, id string) (any, int, error) {
	if strings.Contains(id, "/") || id == "" {
		return nil, 0, nil
	}
	payload, err := readEventJSON(event)
	if err != nil {
		return nil, 0, err
	}
	input, err := validate.ReadCreateBody(payload)
	if err != nil {
		return nil, 0, err
	}
	svc, err := h.draftCRUD()
	if err != nil {
		return h.draftUnavailable(err)
	}
	userID, err := h.requireUser(event)
	if err != nil {
		return nil, 0, err
	}
	body, err := svc.Update(ctx, userID, id, input, h.now())
	return body, 200, err
}

func (h *Handler) deleteDraft(ctx context.Context, event events.APIGatewayV2HTTPRequest, id string) (any, int, error) {
	if strings.Contains(id, "/") || id == "" {
		return nil, 0, nil
	}
	svc, err := h.draftCRUD()
	if err != nil {
		return h.draftUnavailable(err)
	}
	userID, err := h.requireUser(event)
	if err != nil {
		return nil, 0, err
	}
	if err := svc.Delete(ctx, userID, id, h.now()); err != nil {
		return nil, 0, err
	}
	return nil, 204, nil
}

func (h *Handler) finishDay(ctx context.Context, event events.APIGatewayV2HTTPRequest, date string) (any, int, error) {
	if strings.Contains(date, "/") || date == "" {
		return nil, 0, nil
	}
	checked, err := validate.AssertISODate(date, "日付")
	if err != nil {
		return nil, 0, err
	}
	svc, err := h.flushService(ctx)
	if err != nil {
		return h.draftUnavailable(err)
	}
	userID, err := h.requireUser(event)
	if err != nil {
		return nil, 0, err
	}
	body, err := svc.Flush(ctx, userID, checked, h.now(), true)
	return body, 200, err
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
		result, err = dayplan.Get(ctx, store, userID, searchParams(event).Get("date"))
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
				log.Printf("day plan rejected code=%s", invalid.Code)
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

func (h *Handler) optionalDraftStore() (draft.Store, error) {
	if h.drafts != nil {
		return h.drafts, nil
	}
	table := strings.TrimSpace(h.getenv("TABLE_NAME"))
	if table == "" || h.dynamo == nil {
		return nil, nil
	}
	return draft.NewDynamo(table, h.dynamo), nil
}

func (h *Handler) draftCRUD() (*draft.Service, error) {
	store, err := h.optionalDraftStore()
	if err != nil || store == nil {
		if err == nil {
			err = errors.New("TABLE_NAME が設定されていません")
		}
		return nil, err
	}
	plans, _ := h.dayPlanStore()
	return draft.New(store, plans, nil), nil
}

func (h *Handler) flushService(ctx context.Context) (*draft.Service, error) {
	store, err := h.optionalDraftStore()
	if err != nil || store == nil {
		if err == nil {
			err = errors.New("TABLE_NAME が設定されていません")
		}
		return nil, err
	}
	plans, err := h.dayPlanStore()
	if err != nil {
		return nil, err
	}
	writer, err := h.service(ctx)
	if err != nil {
		return nil, err
	}
	return draft.New(store, plans, writer), nil
}

func (h *Handler) draftUnavailable(err error) (any, int, error) {
	if err != nil && strings.Contains(err.Error(), "TABLE_NAME") {
		return map[string]string{
			"error":   "table_unconfigured",
			"message": "TABLE_NAME がありません",
		}, 503, nil
	}
	return nil, 0, err
}

func (h *Handler) requireUser(event events.APIGatewayV2HTTPRequest) (string, error) {
	return ddb.AssertUserID(jwtSubject(event))
}

func (h *Handler) draftReader(ctx context.Context) (*draft.Service, error) {
	store, err := h.optionalDraftStore()
	if err != nil || store == nil {
		return nil, err
	}
	return draft.New(store, nil, nil), nil
}

func (h *Handler) overlayBootstrap(ctx context.Context, event events.APIGatewayV2HTTPRequest, body model.Bootstrap) (model.Bootstrap, error) {
	history, ok, err := h.draftHistory(ctx, event, body.Date)
	if err != nil || !ok {
		return body, err
	}
	if body.Logs == nil {
		body.Logs = map[string]model.LogPair{}
	}
	for name, pair := range body.Logs {
		pair.Previous = draft.OverlayPrevious(pair.Previous, history.Open, name, body.Date)
		pair.Today = draft.OverlayToday(pair.Today, history.Session, name)
		body.Logs[name] = pair
	}
	body.DaySynced = history.Synced
	return body, nil
}

func (h *Handler) overlayPrevious(ctx context.Context, event events.APIGatewayV2HTTPRequest, exercise, before string, rows []model.ExerciseLog) ([]model.ExerciseLog, error) {
	history, ok, err := h.draftHistory(ctx, event, before)
	if err != nil || !ok {
		return rows, err
	}
	return draft.OverlayPrevious(rows, history.Open, exercise, before), nil
}

func (h *Handler) overlayToday(ctx context.Context, event events.APIGatewayV2HTTPRequest, exercise, date string, rows []model.ExerciseLog) ([]model.ExerciseLog, error) {
	history, ok, err := h.draftHistory(ctx, event, date)
	if err != nil || !ok {
		return rows, err
	}
	return draft.OverlayToday(rows, history.Session, exercise), nil
}

func (h *Handler) draftHistory(ctx context.Context, event events.APIGatewayV2HTTPRequest, date string) (draft.History, bool, error) {
	reader, err := h.draftReader(ctx)
	if err != nil || reader == nil {
		return draft.History{}, false, err
	}
	userID, err := ddb.AssertUserID(jwtSubject(event))
	if err != nil {
		return draft.History{}, false, nil
	}
	history, err := reader.History(ctx, userID, date)
	if err != nil {
		return draft.History{}, false, err
	}
	return history, true, nil
}

func (h *Handler) draftHTTPError(ctx context.Context, event events.APIGatewayV2HTTPRequest, err error) (events.APIGatewayV2HTTPResponse, bool) {
	var busy draft.BusyError
	if errors.As(err, &busy) {
		return jsonResponse(409, map[string]string{"error": busy.Error()}), true
	}
	var conflict draft.ConflictError
	if errors.As(err, &conflict) {
		return jsonResponse(409, map[string]string{"error": conflict.Error()}), true
	}
	var missing *draft.NotFoundError
	if errors.As(err, &missing) {
		return jsonResponse(404, map[string]string{"error": "見つかりません"}), true
	}
	var invalid *ddb.ItemValidationError
	if errors.As(err, &invalid) {
		if invalid.Code == "user_id" {
			return jsonResponse(401, map[string]string{"error": "ログインが必要です"}), true
		}
		log.Printf("draft rejected code=%s", invalid.Code)
		return jsonResponse(400, map[string]string{"error": "記録の形式を確認してください"}), true
	}
	var stored *draft.StorageError
	if errors.As(err, &stored) {
		id := logServerError(ctx, event, "draft failed", err, msgServer)
		return jsonResponse(502, faultBody(msgServer, id)), true
	}
	return events.APIGatewayV2HTTPResponse{}, false
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
	OK bool `json:"ok"`
}

// healthBody is the unauthenticated liveness payload. It does not report the
// stage, table name, or whether Notion is configured.
func healthBody() health {
	return health{OK: true}
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
