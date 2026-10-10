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
	accountPattern  = regexp.MustCompile(`\b\d{12}\b`)
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
func logServerError(ctx context.Context, event events.APIGatewayV2HTTPRequest, prefix string, err error, public string) string {
	id := requestID(ctx, event)
	detail := ""
	if err != nil {
		detail = redact(err.Error())
	}
	log.Printf("%s requestId=%s %T: %s detail=%s", prefix, id, err, public, detail)
	return id
}

// requestID prefers the Lambda request ID so the client value matches CloudWatch.
// API Gateway's request ID is the fallback.
func requestID(ctx context.Context, event events.APIGatewayV2HTTPRequest) string {
	if lc, ok := lambdacontext.FromContext(ctx); ok {
		if id := strings.TrimSpace(lc.AwsRequestID); id != "" {
			return id
		}
	}
	return strings.TrimSpace(event.RequestContext.RequestID)
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
