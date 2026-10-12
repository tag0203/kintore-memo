package draft

import (
	"context"
	"errors"

	"github.com/tag0203/kintore-memo/api/internal/awsadapter"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

// Dynamo reads and writes DraftDay and FlushIndex in one table.
type Dynamo struct {
	table string
	api   Table
}

// NewDynamo binds drafts to TABLE_NAME. Reads are strongly consistent.
func NewDynamo(table string, api Table) *Dynamo {
	return &Dynamo{table: table, api: api}
}

func (d *Dynamo) GetDay(ctx context.Context, pk, sk string) (*ddb.DraftDayItem, error) {
	var item ddb.DraftDayItem
	found, err := d.api.GetConsistent(ctx, d.table, pk, sk, &item)
	if err != nil || !found {
		if err != nil {
			return nil, err
		}
		return nil, nil
	}
	if item.Drafts == nil {
		item.Drafts = []ddb.DraftRow{}
	}
	return &item, nil
}

func (d *Dynamo) PutDay(ctx context.Context, item ddb.DraftDayItem, previousVersion int, exists bool) error {
	if item.Drafts == nil {
		item.Drafts = []ddb.DraftRow{}
	}
	return versionErr(d.api.PutIf(ctx, d.table, item, previousVersion, exists))
}

func (d *Dynamo) DeleteDay(ctx context.Context, pk, sk string, previousVersion int) error {
	return versionErr(d.api.DeleteIf(ctx, d.table, pk, sk, previousVersion))
}

func (d *Dynamo) GetIndex(ctx context.Context) (*ddb.FlushIndexItem, error) {
	var item ddb.FlushIndexItem
	found, err := d.api.GetConsistent(ctx, d.table, ddb.FlushIndexPK, ddb.FlushIndexSK, &item)
	if err != nil || !found {
		if err != nil {
			return nil, err
		}
		return nil, nil
	}
	if item.Days == nil {
		item.Days = []ddb.PendingDay{}
	}
	return &item, nil
}

func (d *Dynamo) PutIndex(ctx context.Context, item ddb.FlushIndexItem, previousVersion int, exists bool) error {
	if item.Days == nil {
		item.Days = []ddb.PendingDay{}
	}
	return versionErr(d.api.PutIf(ctx, d.table, item, previousVersion, exists))
}

func (d *Dynamo) DeleteIndex(ctx context.Context, previousVersion int) error {
	return versionErr(d.api.DeleteIf(ctx, d.table, ddb.FlushIndexPK, ddb.FlushIndexSK, previousVersion))
}

func versionErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, awsadapter.ErrConditionalCheck) {
		return ErrVersionConflict
	}
	return err
}
