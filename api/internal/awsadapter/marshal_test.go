package awsadapter

import (
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

func TestMarshalDayPlanKeepsEmptyMenu(t *testing.T) {
	item, err := ddb.BuildDayPlanItem(ddb.DayPlanInput{
		UserID:      "11111111-2222-4333-8444-555555555555",
		Date:        "2026-10-02",
		Memo:        "",
		Exercises:   []string{},
		Finished:    false,
		FinishedSet: true,
		Now:         time.Date(2026, 10, 2, 3, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := av["exercises"].(*types.AttributeValueMemberL); !ok {
		t.Fatalf("exercises = %#v", av["exercises"])
	}
	finished, ok := av["finished"].(*types.AttributeValueMemberBOOL)
	if !ok || finished.Value {
		t.Fatalf("finished = %#v", av["finished"])
	}
	if _, ok := av["ttl"].(*types.AttributeValueMemberN); !ok {
		t.Fatalf("ttl = %#v", av["ttl"])
	}
	if _, ok := av["pk"].(*types.AttributeValueMemberS); !ok {
		t.Fatal("pk missing")
	}
}
