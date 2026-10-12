// Command api is the production Lambda. API Gateway authorizes the JWT.
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"

	"github.com/tag0203/kintore-memo/api/internal/awsadapter"
	"github.com/tag0203/kintore-memo/api/internal/flushqueue"
	"github.com/tag0203/kintore-memo/api/internal/httpapi"
)

func main() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	awsClient := awsadapter.New(cfg)
	deps := httpapi.Deps{
		Parameters: awsClient,
		Dynamo:     awsClient,
	}
	if os.Getenv("HANDLER_MODE") != "flush" {
		if name := strings.TrimSpace(os.Getenv("FLUSH_FUNCTION_NAME")); name != "" {
			deps.Enqueue = flushqueue.New(cfg, name).Enqueue
		}
	}
	handler := httpapi.New(deps)
	if os.Getenv("HANDLER_MODE") == "flush" {
		lambda.Start(func(ctx context.Context, raw json.RawMessage) error {
			return handler.DispatchFlush(ctx, raw)
		})
		return
	}
	lambda.Start(handler.Handle)
}
