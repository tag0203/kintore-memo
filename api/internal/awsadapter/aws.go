// Package awsadapter binds the DynamoDB and SSM clients used in Lambda.
package awsadapter

import (
	"context"
	"errors"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

// ErrConditionalCheck is a rejected Put or Delete condition. Draft writes retry it.
var ErrConditionalCheck = errors.New("conditional check failed")

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
// The read is eventually consistent. DayPlan uses GetConsistent.
func (c *Client) Get(ctx context.Context, table, pk, sk string, dest any) (bool, error) {
	return c.get(ctx, table, pk, sk, dest, false)
}

// GetConsistent is a strongly consistent GetItem for DayPlan reloads.
func (c *Client) GetConsistent(ctx context.Context, table, pk, sk string, dest any) (bool, error) {
	return c.get(ctx, table, pk, sk, dest, true)
}

func (c *Client) get(ctx context.Context, table, pk, sk string, dest any, consistent bool) (bool, error) {
	out, err := c.dynamo.GetItem(ctx, newGetItemInput(table, pk, sk, consistent))
	if err != nil {
		return false, err
	}
	if out.Item == nil {
		return false, nil
	}
	if err := attributevalue.UnmarshalMap(out.Item, dest); err != nil {
		return false, err
	}
	noteDayPlan(dest, out.Item)
	return true, nil
}

func newGetItemInput(table, pk, sk string, consistent bool) *dynamodb.GetItemInput {
	input := &dynamodb.GetItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	}
	if consistent {
		input.ConsistentRead = aws.Bool(true)
	}
	return input
}

// noteDayPlan records attribute presence. Zero values from a missing
// memo, exercises, or finished attribute are not a stored empty menu.
func noteDayPlan(dest any, item map[string]types.AttributeValue) {
	plan, ok := dest.(*ddb.DayPlanItem)
	if !ok {
		return
	}
	_, memo := item["memo"].(*types.AttributeValueMemberS)
	_, exercises := item["exercises"].(*types.AttributeValueMemberL)
	_, finished := item["finished"].(*types.AttributeValueMemberBOOL)
	plan.NoteStoredAttributes(memo, exercises, finished)
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

// PutIf writes the whole item when the stored version matches.
// exists false inserts only when the key is absent.
func (c *Client) PutIf(ctx context.Context, table string, item any, previousVersion int, exists bool) error {
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return err
	}
	input := &dynamodb.PutItemInput{
		TableName: aws.String(table),
		Item:      av,
	}
	if exists {
		input.ConditionExpression = aws.String("#version = :previous")
		input.ExpressionAttributeNames = map[string]string{"#version": "version"}
		input.ExpressionAttributeValues = map[string]types.AttributeValue{
			":previous": &types.AttributeValueMemberN{Value: strconv.Itoa(previousVersion)},
		}
	} else {
		input.ConditionExpression = aws.String("attribute_not_exists(pk)")
	}
	_, err = c.dynamo.PutItem(ctx, input)
	return conditionErr(err)
}

// DeleteIf removes a key when the stored version matches.
func (c *Client) DeleteIf(ctx context.Context, table, pk, sk string, previousVersion int) error {
	_, err := c.dynamo.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
		ConditionExpression:       aws.String("#version = :previous"),
		ExpressionAttributeNames:  map[string]string{"#version": "version"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":previous": &types.AttributeValueMemberN{Value: strconv.Itoa(previousVersion)}},
	})
	return conditionErr(err)
}

func conditionErr(err error) error {
	if err == nil {
		return nil
	}
	var cond *types.ConditionalCheckFailedException
	if errors.As(err, &cond) {
		return ErrConditionalCheck
	}
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
