// Package dayplan maps GET/PUT /api/day-plan onto one DynamoDB item.
// The user id is the JWT sub. Weight, reps, sets, and difficulty are not stored.
package dayplan

import (
	"context"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/model"
)

// Store is GetItem / PutItem. Tests use Memory.
type Store interface {
	Get(ctx context.Context, pk, sk string) (*ddb.DayPlanItem, error)
	Put(ctx context.Context, item ddb.DayPlanItem) error
}

// Table is the subset of the DynamoDB adapter this package needs.
type Table interface {
	Get(ctx context.Context, table, pk, sk string, dest any) (bool, error)
	Put(ctx context.Context, table string, item any) error
}

// StorageError means a stored item or the table call failed.
type StorageError struct{ Err error }

func (e *StorageError) Error() string {
	if e.Err == nil {
		return "stored DayPlan failed validation"
	}
	return e.Err.Error()
}

func (e *StorageError) Unwrap() error { return e.Err }

// Memory is an in-process DayPlan table.
type Memory struct {
	items map[string]ddb.DayPlanItem
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{items: map[string]ddb.DayPlanItem{}}
}

func (m *Memory) Get(_ context.Context, pk, sk string) (*ddb.DayPlanItem, error) {
	item, ok := m.items[pk+"\x00"+sk]
	if !ok {
		return nil, nil
	}
	cloned := cloneItem(item)
	return &cloned, nil
}

func (m *Memory) Put(_ context.Context, item ddb.DayPlanItem) error {
	m.items[item.PK+"\x00"+item.SK] = cloneItem(item)
	return nil
}

// Dynamo reads and writes one table.
type Dynamo struct {
	table string
	api   Table
}

// NewDynamo binds DayPlan to TABLE_NAME.
func NewDynamo(table string, api Table) *Dynamo {
	return &Dynamo{table: table, api: api}
}

func (d *Dynamo) Get(ctx context.Context, pk, sk string) (*ddb.DayPlanItem, error) {
	var item ddb.DayPlanItem
	found, err := d.api.Get(ctx, d.table, pk, sk, &item)
	if err != nil || !found {
		return nil, err
	}
	if item.Exercises == nil {
		item.Exercises = []string{}
	}
	return &item, nil
}

func (d *Dynamo) Put(ctx context.Context, item ddb.DayPlanItem) error {
	return d.api.Put(ctx, d.table, item)
}

// Get returns the day's menu, or an empty plan when the item is missing.
func Get(ctx context.Context, store Store, userID, date string, now time.Time) (model.DayPlan, error) {
	checkedID, err := ddb.AssertUserID(userID)
	if err != nil {
		return model.DayPlan{}, err
	}
	checkedDate, err := ddb.AssertISODate(date)
	if err != nil {
		return model.DayPlan{}, err
	}
	writable, err := ddb.IsWritableSessionDate(checkedDate, now)
	if err != nil {
		return model.DayPlan{}, err
	}
	if !writable {
		return model.DayPlan{}, &ddb.ItemValidationError{Code: "date_window", Msg: "date is outside the writable session window"}
	}
	key, err := ddb.DayPlanKey(checkedID, checkedDate)
	if err != nil {
		return model.DayPlan{}, err
	}
	item, err := store.Get(ctx, key.PK, key.SK)
	if err != nil {
		return model.DayPlan{}, &StorageError{Err: err}
	}
	if item == nil {
		return empty(checkedDate), nil
	}
	read, err := ddb.ReadDayPlanItem(*item)
	if err != nil {
		return model.DayPlan{}, &StorageError{Err: err}
	}
	return toDTO(read), nil
}

// Put replaces the whole item. userID is not taken from the body.
func Put(ctx context.Context, store Store, userID string, body any, now time.Time) (model.DayPlan, error) {
	record, ok := body.(map[string]any)
	if !ok || body == nil {
		return model.DayPlan{}, &ddb.ItemValidationError{Code: "body_invalid", Msg: "body must be an object"}
	}
	// Same order as BuildDayPlanItem: date, then the session window, then finished, memo, exercises.
	date, dateOK := record["date"].(string)
	if !dateOK {
		date = ""
	}
	if _, err := ddb.AssertISODate(date); err != nil {
		return model.DayPlan{}, err
	}
	writable, err := ddb.IsWritableSessionDate(date, now)
	if err != nil {
		return model.DayPlan{}, err
	}
	if !writable {
		return model.DayPlan{}, &ddb.ItemValidationError{Code: "date_window", Msg: "date is outside the writable session window"}
	}
	finished, finishedOK := record["finished"].(bool)
	if !finishedOK {
		return model.DayPlan{}, &ddb.ItemValidationError{Code: "finished_invalid", Msg: "finished must be a boolean"}
	}
	memo, memoOK := record["memo"].(string)
	if !memoOK {
		return model.DayPlan{}, &ddb.ItemValidationError{Code: "memo_invalid", Msg: "memo must be a string"}
	}
	exercises, err := exerciseNames(record["exercises"])
	if err != nil {
		return model.DayPlan{}, err
	}
	item, err := ddb.BuildDayPlanItem(ddb.DayPlanInput{
		UserID:      userID,
		Date:        date,
		Memo:        memo,
		Exercises:   exercises,
		Finished:    finished,
		FinishedSet: true,
		Now:         now,
	})
	if err != nil {
		return model.DayPlan{}, err
	}
	if err := store.Put(ctx, item); err != nil {
		return model.DayPlan{}, &StorageError{Err: err}
	}
	return toDTO(item), nil
}

func empty(date string) model.DayPlan {
	return model.DayPlan{Date: date, Memo: "", Exercises: []string{}, Finished: false}
}

func toDTO(item ddb.DayPlanItem) model.DayPlan {
	updated := item.UpdatedAt
	return model.DayPlan{
		Date:      item.Date,
		Memo:      item.Memo,
		Exercises: append([]string(nil), item.Exercises...),
		Finished:  item.Finished,
		UpdatedAt: &updated,
	}
}

func exerciseNames(value any) ([]string, error) {
	if value == nil {
		return nil, &ddb.ItemValidationError{Code: "exercises_invalid", Msg: "exercises must be an array"}
	}
	raw, ok := value.([]any)
	if !ok {
		return nil, &ddb.ItemValidationError{Code: "exercises_invalid", Msg: "exercises must be an array"}
	}
	names := make([]string, len(raw))
	for i, item := range raw {
		name, ok := item.(string)
		if !ok {
			return nil, &ddb.ItemValidationError{Code: "exercise_invalid", Msg: "exercise name must be a string"}
		}
		names[i] = name
	}
	return names, nil
}

func cloneItem(item ddb.DayPlanItem) ddb.DayPlanItem {
	item.Exercises = append([]string(nil), item.Exercises...)
	return item
}
