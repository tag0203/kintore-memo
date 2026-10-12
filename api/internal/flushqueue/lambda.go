// Package flushqueue starts the flush Lambda without waiting for Notion.
package flushqueue

import (
	"context"
	"encoding/json"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/tag0203/kintore-memo/api/internal/draft"
)

// Queue invokes the flush function asynchronously.
type Queue struct {
	name   string
	invoke func(context.Context, string, []byte) error
}

// New uses the Lambda execution role. name is the flush function name, not an ARN.
func New(cfg aws.Config, name string) *Queue {
	client := lambda.NewFromConfig(cfg)
	return &Queue{
		name: name,
		invoke: func(ctx context.Context, functionName string, payload []byte) error {
			_, err := client.Invoke(ctx, &lambda.InvokeInput{
				FunctionName:   aws.String(functionName),
				InvocationType: lambdatypes.InvocationTypeEvent,
				Payload:        payload,
			})
			return err
		},
	}
}

// Enqueue asks the flush Lambda to claim this lease and write Notion.
// The error is the SDK error. Callers wrap it so the function name stays out of logs.
func (q *Queue) Enqueue(ctx context.Context, job draft.FlushJob) error {
	if q == nil || q.name == "" || q.invoke == nil {
		return errNoQueue
	}
	body, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return q.invoke(ctx, q.name, body)
}

type noQueueError struct{}

func (noQueueError) Error() string { return "flush enqueue failed" }

var errNoQueue = noQueueError{}
