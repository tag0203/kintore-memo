// Package draft stores workout rows in DynamoDB until 「終了」 or the nightly
// job writes them to Notion. A synced day is not editable here.
package draft

import (
	"context"
	"errors"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

// ErrVersionConflict is a lost compare-and-swap. Callers retry.
var ErrVersionConflict = errors.New("draft version conflict")

// BusyError is a 409. Another flush holds this day's lease.
type BusyError struct{}

func (BusyError) Error() string {
	return "反映しています。少し待ってからもう一度終了してください"
}

// ConflictError is a 409. The day or the row was already written to Notion.
type ConflictError struct{}

func (ConflictError) Error() string {
	return "反映済みの記録は Notion で修正してください"
}

// NotFoundError is a 404 for a draft id.
type NotFoundError struct{}

func (NotFoundError) Error() string { return "見つかりません" }

// StorageError is a failed table call or a stored item that does not match the key rules.
type StorageError struct{ Err error }

func (e *StorageError) Error() string {
	if e == nil || e.Err == nil {
		return "draft storage failed"
	}
	return e.Err.Error()
}

func (e *StorageError) Unwrap() error { return e.Err }

// Store is the single-table port. Keys are known, so this is Get, conditional Put, and conditional Delete.
type Store interface {
	GetDay(ctx context.Context, pk, sk string) (*ddb.DraftDayItem, error)
	PutDay(ctx context.Context, item ddb.DraftDayItem, previousVersion int, exists bool) error
	DeleteDay(ctx context.Context, pk, sk string, previousVersion int) error
	GetIndex(ctx context.Context) (*ddb.FlushIndexItem, error)
	PutIndex(ctx context.Context, item ddb.FlushIndexItem, previousVersion int, exists bool) error
	DeleteIndex(ctx context.Context, previousVersion int) error
}

// Table is the DynamoDB adapter subset. Tests use Memory instead.
type Table interface {
	GetConsistent(ctx context.Context, table, pk, sk string, dest any) (bool, error)
	PutIf(ctx context.Context, table string, item any, previousVersion int, exists bool) error
	DeleteIf(ctx context.Context, table, pk, sk string, previousVersion int) error
}
