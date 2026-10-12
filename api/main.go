// Command api is the production Lambda. API Gateway authorizes the JWT.
package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"

	"github.com/tag0203/kintore-memo/api/internal/awsadapter"
	"github.com/tag0203/kintore-memo/api/internal/httpapi"
)

func main() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	awsClient := awsadapter.New(cfg)
	handler := httpapi.New(httpapi.Deps{
		Parameters: awsClient,
		Dynamo:     awsClient,
	})
	if os.Getenv("HANDLER_MODE") == "flush" {
		lambda.Start(handler.HandleFlush)
		return
	}
	lambda.Start(handler.Handle)
}
