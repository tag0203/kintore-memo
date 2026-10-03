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

	var decoded ddb.DayPlanItem
	if err := attributevalue.UnmarshalMap(av, &decoded); err != nil {
		t.Fatal(err)
	}
	noteDayPlan(&decoded, av)
	if _, err := ddb.ReadDayPlanItem(decoded); err != nil {
		t.Fatal(err)
	}

	delete(av, "memo")
	delete(av, "exercises")
	delete(av, "finished")
	decoded = ddb.DayPlanItem{}
	if err := attributevalue.UnmarshalMap(av, &decoded); err != nil {
		t.Fatal(err)
	}
	noteDayPlan(&decoded, av)
	if _, err := ddb.ReadDayPlanItem(decoded); err == nil {
		t.Fatal("omitted zero attributes were accepted")
	}
}

func TestDayPlanGetItemConsistentRead(t *testing.T) {
	eventual := newGetItemInput("kintore-memo-dev", "USER#sub", "DAY#2026-10-02", false)
	if eventual.ConsistentRead != nil {
		t.Fatalf("cache read consistent = %v", *eventual.ConsistentRead)
	}
	strong := newGetItemInput("kintore-memo-dev", "USER#sub", "DAY#2026-10-02", true)
	if strong.ConsistentRead == nil || !*strong.ConsistentRead {
		t.Fatal("DayPlan read is not strongly consistent")
	}
}
