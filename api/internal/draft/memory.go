package draft

import (
	"context"
	"sync"

	"github.com/tag0203/kintore-memo/api/internal/ddb"
)

// Memory is an in-process draft table for tests.
type Memory struct {
	mu    sync.Mutex
	days  map[string]ddb.DraftDayItem
	index *ddb.FlushIndexItem
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{days: map[string]ddb.DraftDayItem{}}
}

func dayKey(pk, sk string) string { return pk + "\x00" + sk }

func cloneDay(item ddb.DraftDayItem) ddb.DraftDayItem {
	item.Drafts = append([]ddb.DraftRow(nil), item.Drafts...)
	return item
}

func cloneIndex(item ddb.FlushIndexItem) ddb.FlushIndexItem {
	item.Days = append([]ddb.PendingDay(nil), item.Days...)
	return item
}

func (m *Memory) GetDay(_ context.Context, pk, sk string) (*ddb.DraftDayItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item, ok := m.days[dayKey(pk, sk)]
	if !ok {
		return nil, nil
	}
	cloned := cloneDay(item)
	return &cloned, nil
}

func (m *Memory) PutDay(_ context.Context, item ddb.DraftDayItem, previousVersion int, exists bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := dayKey(item.PK, item.SK)
	current, ok := m.days[key]
	if exists {
		if !ok || current.Version != previousVersion {
			return ErrVersionConflict
		}
	} else if ok {
		return ErrVersionConflict
	}
	m.days[key] = cloneDay(item)
	return nil
}

func (m *Memory) DeleteDay(_ context.Context, pk, sk string, previousVersion int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := dayKey(pk, sk)
	current, ok := m.days[key]
	if !ok || current.Version != previousVersion {
		return ErrVersionConflict
	}
	delete(m.days, key)
	return nil
}

func (m *Memory) GetIndex(context.Context) (*ddb.FlushIndexItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.index == nil {
		return nil, nil
	}
	cloned := cloneIndex(*m.index)
	return &cloned, nil
}

func (m *Memory) PutIndex(_ context.Context, item ddb.FlushIndexItem, previousVersion int, exists bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if exists {
		if m.index == nil || m.index.Version != previousVersion {
			return ErrVersionConflict
		}
	} else if m.index != nil {
		return ErrVersionConflict
	}
	cloned := cloneIndex(item)
	m.index = &cloned
	return nil
}

func (m *Memory) DeleteIndex(_ context.Context, previousVersion int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.index == nil || m.index.Version != previousVersion {
		return ErrVersionConflict
	}
	m.index = nil
	return nil
}
