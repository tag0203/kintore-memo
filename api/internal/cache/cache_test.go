package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryExpires(t *testing.T) {
	clock := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	mem := NewMemory(func() time.Time { return clock })
	if err := mem.Put(context.Background(), []string{"exercises"}, `{"v":1}`, clock); err != nil {
		t.Fatal(err)
	}
	body, ok, err := mem.Get(context.Background(), []string{"exercises"})
	if err != nil || !ok || body != `{"v":1}` {
		t.Fatalf("hit %q ok=%v err=%v", body, ok, err)
	}
	clock = clock.Add(301 * time.Second)
	_, ok, err = mem.Get(context.Background(), []string{"exercises"})
	if err != nil || ok {
		t.Fatalf("expired ok=%v err=%v", ok, err)
	}
}

type errRemote struct{}

func (errRemote) Get(context.Context, string, string, string, any) (bool, error) {
	return false, errors.New("dynamo down")
}

func (errRemote) Put(context.Context, string, any) error {
	return errors.New("dynamo down")
}

func (errRemote) Delete(context.Context, string, string, string) error {
	return errors.New("dynamo down")
}

func TestTieredKeepsReadingWhenDynamoFails(t *testing.T) {
	clock := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	now := func() time.Time { return clock }
	tier := NewTiered(NewMemory(now), NewDynamo("kintore-memo-dev", errRemote{}, now))
	if body, ok, err := tier.Get(context.Background(), []string{"exercises"}); err != nil || ok || body != "" {
		t.Fatalf("miss body=%q ok=%v err=%v", body, ok, err)
	}
	if err := tier.Put(context.Background(), []string{"exercises"}, `{"v":1}`, clock); err != nil {
		t.Fatal(err)
	}
	body, ok, err := tier.Get(context.Background(), []string{"exercises"})
	if err != nil || !ok || body != `{"v":1}` {
		t.Fatalf("memory hit %q ok=%v err=%v", body, ok, err)
	}
}
