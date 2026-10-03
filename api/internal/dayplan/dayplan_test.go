package dayplan

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

const userID = "11111111-2222-4333-8444-555555555555"

type consistentTable struct {
	called bool
}

func (t *consistentTable) GetConsistent(_ context.Context, _, _, _ string, dest any) (bool, error) {
	t.called = true
	item := dest.(*ddb.DayPlanItem)
	*item = ddb.DayPlanItem{Exercises: nil}
	return true, nil
}

func (t *consistentTable) Put(context.Context, string, any) error { return nil }

func TestDynamoGetDoesNotInventAnEmptyMenu(t *testing.T) {
	table := &consistentTable{}
	item, err := NewDynamo("kintore-memo-dev", table).Get(context.Background(), "USER#sub", "DAY#2026-10-02")
	if err != nil || !table.called || item == nil || item.Exercises != nil {
		t.Fatalf("item=%#v called=%v err=%v", item, table.called, err)
	}
}

func TestStoredEmptyMenuStaysDistinctFromOmittedFields(t *testing.T) {
	now := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	store := NewMemory()
	item, err := ddb.BuildDayPlanItem(ddb.DayPlanInput{
		UserID: userID, Date: "2026-10-02", Memo: "", Exercises: []string{},
		Finished: false, FinishedSet: true, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	got, err := Get(context.Background(), store, userID, "2026-10-02", now)
	if err != nil || got.Memo != "" || got.Exercises == nil || len(got.Exercises) != 0 || got.Finished {
		t.Fatalf("empty = %#v %v", got, err)
	}

	ttl, err := ddb.DayPlanTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	omitted := NewMemory()
	if err := omitted.Put(context.Background(), ddb.DayPlanItem{
		PK: "USER#" + userID, SK: "DAY#2026-10-02", EntityType: ddb.EntityDayPlan,
		UserID: userID, Date: "2026-10-02", Memo: "", Exercises: []string{}, Finished: false,
		UpdatedAt: "2026-10-02T00:00:00.000Z", TTL: ttl,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = Get(context.Background(), omitted, userID, "2026-10-02", now)
	var storage *StorageError
	var invalid *ddb.ItemValidationError
	if !errors.As(err, &storage) || !errors.As(err, &invalid) || invalid.Code != "memo_invalid" {
		t.Fatalf("omitted = %v", err)
	}
}
