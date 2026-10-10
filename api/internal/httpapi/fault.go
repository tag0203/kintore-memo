package httpapi

import (
	"context"
	"errors"
	"log"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
	"github.com/aws/smithy-go"

	"github.com/tag0203/kintore-memo/api/internal/syntax"
	"github.com/tag0203/kintore-memo/api/internal/validate"
)

const (
	msgNotion = "Notion との通信に失敗しました"
	msgServer = "サーバーでエラーが発生しました"
)

var (
	bearerPattern   = regexp.MustCompile(`(?i)Bearer\s+\S+`)
	ntnPattern      = regexp.MustCompile(`ntn_[A-Za-z0-9]+`)
	secretPattern   = regexp.MustCompile(`secret_[A-Za-z0-9]+`)
	urlPattern      = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>]+`)
	arnPattern      = regexp.MustCompile(`arn:aws[a-zA-Z0-9-]*:[^\s"'<>]+`)
	uuidPattern     = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	notionIDPattern = regexp.MustCompile(`(?i)\b[0-9a-f]{32}\b`)
	accountPattern  = regexp.MustCompile(`\d{12}`)
	lambdaUUID      = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	compactNotionID = regexp.MustCompile(`(?i)^[0-9a-f]{32}$`)
	apigwRequestID  = regexp.MustCompile(`^[A-Za-z0-9+/]{8,128}={0,2}$`)
	letterPattern   = regexp.MustCompile(`[A-Za-z]`)
)

// notionError is the JSON body for workout routes.
// Validation stays specific. Everything else is a fixed message plus requestId.
func (h *Handler) notionError(ctx context.Context, event events.APIGatewayV2HTTPRequest, err error) events.APIGatewayV2HTTPResponse {
	var invalid *validate.Error
	if errors.As(err, &invalid) {
		return jsonResponse(400, map[string]string{"error": invalid.Error()})
	}
	var syntaxErr *syntax.Error
	if errors.As(err, &syntaxErr) {
		return jsonResponse(400, map[string]string{"error": "JSON を確認してください"})
	}
	status, message := publicFailure(err)
	id := logServerError(ctx, event, "api failed", err, message)
	return jsonResponse(status, faultBody(message, id))
}

func publicFailure(err error) (int, string) {
	if err == nil || isConfigError(err) {
		return 500, msgServer
	}
	if isAWS(err) {
		return 502, msgServer
	}
	if isNotionOrNetwork(err) {
		return 502, msgNotion
	}
	return 500, msgServer
}

func isConfigError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "設定されていません") || strings.Contains(message, "設定がありません")
}

func isAWS(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return true
	}
	var opErr *smithy.OperationError
	return errors.As(err, &opErr)
}

func isNotionOrNetwork(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	for range 8 {
		if err == nil {
			break
		}
		if strings.HasPrefix(err.Error(), "Notion API:") {
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}

func faultBody(message, requestID string) map[string]string {
	body := map[string]string{"error": message}
	if requestID != "" {
		body["requestId"] = requestID
	}
	return body
}

// logServerError records the error type, the fixed client message, and a redacted
// detail string. It does not log headers or the request body.
// The Lambda request ID stays in the log. The returned ID is the only value safe
// to show: an API Gateway token, never a UUID that could be a Notion ID.
func logServerError(ctx context.Context, event events.APIGatewayV2HTTPRequest, prefix string, err error, public string) string {
	publicID := publicRequestID(event)
	detail := ""
	if err != nil {
		detail = redact(err.Error())
	}
	log.Printf("%s lambdaRequestId=%s requestId=%s %T: %s detail=%s", prefix, lambdaRequestID(ctx), publicID, err, public, detail)
	return publicID
}

func lambdaRequestID(ctx context.Context) string {
	if lc, ok := lambdacontext.FromContext(ctx); ok {
		return strings.TrimSpace(lc.AwsRequestID)
	}
	return ""
}

// publicRequestID is the API Gateway request ID when it cannot be a Notion ID,
// an ARN, an account ID, or a token. Lambda IDs are UUIDs, so they stay in the log.
func publicRequestID(event events.APIGatewayV2HTTPRequest) string {
	id := strings.TrimSpace(event.RequestContext.RequestID)
	if !safePublicRequestID(id) {
		return ""
	}
	return id
}

func safePublicRequestID(id string) bool {
	if id == "" || lambdaUUID.MatchString(id) || compactNotionID.MatchString(id) {
		return false
	}
	lower := strings.ToLower(id)
	if strings.Contains(lower, "ntn_") || strings.Contains(lower, "secret_") {
		return false
	}
	if !apigwRequestID.MatchString(id) || accountPattern.MatchString(id) || !letterPattern.MatchString(id) {
		return false
	}
	return true
}

// redact hides tokens, ARNs, account IDs, Notion IDs, and URLs before logging.
func redact(message string) string {
	message = strings.ReplaceAll(message, "\n", " ")
	message = strings.ReplaceAll(message, "\r", " ")
	message = bearerPattern.ReplaceAllString(message, "Bearer [redacted]")
	message = ntnPattern.ReplaceAllString(message, "[redacted]")
	message = secretPattern.ReplaceAllString(message, "[redacted]")
	message = urlPattern.ReplaceAllString(message, "[redacted]")
	message = arnPattern.ReplaceAllString(message, "[redacted]")
	message = uuidPattern.ReplaceAllString(message, "[redacted]")
	message = notionIDPattern.ReplaceAllString(message, "[redacted]")
	message = accountPattern.ReplaceAllString(message, "[redacted]")
	return message
}
