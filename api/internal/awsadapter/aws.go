// Package awsadapter binds the DynamoDB and SSM clients used in Lambda.
package awsadapter

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// Client implements the cache and DayPlan table port, plus SSM GetParameter.
type Client struct {
	dynamo *dynamodb.Client
	ssm    *ssm.Client
}

// New wraps the AWS config from the Lambda execution role.
func New(cfg aws.Config) *Client {
	return &Client{
		dynamo: dynamodb.NewFromConfig(cfg),
		ssm:    ssm.NewFromConfig(cfg),
	}
}

// Get reads one item into dest. found is false when the key is absent.
func (c *Client) Get(ctx context.Context, table, pk, sk string, dest any) (bool, error) {
	out, err := c.dynamo.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	})
	if err != nil {
		return false, err
	}
	if out.Item == nil {
		return false, nil
	}
	if err := attributevalue.UnmarshalMap(out.Item, dest); err != nil {
		return false, err
	}
	return true, nil
}

// Put writes the whole item. The same key replaces the previous attributes.
func (c *Client) Put(ctx context.Context, table string, item any) error {
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return err
	}
	_, err = c.dynamo.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(table),
		Item:      av,
	})
	return err
}

// Delete removes one key.
func (c *Client) Delete(ctx context.Context, table, pk, sk string) error {
	_, err := c.dynamo.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	})
	return err
}

// GetParameter reads a SecureString. The value is not logged.
func (c *Client) GetParameter(ctx context.Context, name string) (string, error) {
	out, err := c.ssm.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		return "", err
	}
	if out.Parameter == nil || out.Parameter.Value == nil {
		return "", nil
	}
	return *out.Parameter.Value, nil
}
