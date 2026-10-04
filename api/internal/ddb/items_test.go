package ddb

import (
	"errors"
	"strings"
	"testing"
	"time"
)

const userID = "11111111-2222-4333-8444-555555555555"

var now = time.Date(2026, 10, 2, 3, 0, 0, 0, time.UTC)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var itemErr *ItemValidationError
	if !errors.As(err, &itemErr) {
		t.Fatalf("expected ItemValidationError, got %v", err)
	}
	return itemErr.Code
}

func plan(t *testing.T, memo string, exercises []string, finished bool, date string) DayPlanItem {
	t.Helper()
	item, err := BuildDayPlanItem(DayPlanInput{
		UserID:      userID,
		Date:        date,
		Memo:        memo,
		Exercises:   exercises,
		Finished:    finished,
		FinishedSet: true,
		Now:         now,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	return item
}

func TestDayPlanKeyAndTTL(t *testing.T) {
	key, err := DayPlanKey(userID, "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if key.PK != "USER#"+userID || key.SK != "DAY#2026-10-02" {
		t.Fatalf("key = %+v", key)
	}

	ttl, err := DayPlanTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if got := time.Unix(ttl, 0).UTC().Format(time.RFC3339); got != "2026-10-03T15:00:00Z" {
		t.Fatalf("ttl = %s", got)
	}
	leap, err := DayPlanTTLEpochSeconds("2024-02-28")
	if err != nil {
		t.Fatal(err)
	}
	if got := time.Unix(leap, 0).UTC().Format(time.RFC3339); got != "2024-02-29T15:00:00Z" {
		t.Fatalf("leap ttl = %s", got)
	}
}

func TestDayPlanItemRoundTrip(t *testing.T) {
	item := plan(t, " 脚 \n", []string{"スクワット", "レッグプレス", "レッグカール"}, true, "2026-10-02")
	if item.Memo != " 脚 " || !item.Finished || item.UpdatedAt != "2026-10-02T03:00:00.000Z" {
		t.Fatalf("item = %+v", item)
	}
	if item.EntityType != EntityDayPlan || item.TTL != mustTTL(t, "2026-10-02") {
		t.Fatalf("item = %+v", item)
	}
	read, err := ReadDayPlanItem(item)
	if err != nil {
		t.Fatal(err)
	}
	if read.Memo != item.Memo || read.PK != item.PK || read.Finished != item.Finished {
		t.Fatalf("read = %+v", read)
	}

	trimmed := plan(t, "脚", []string{" レッグカール ", "スクワット"}, false, "2026-10-02")
	if strings.Join(trimmed.Exercises, ",") != "レッグカール,スクワット" {
		t.Fatalf("exercises = %#v", trimmed.Exercises)
	}

	empty := plan(t, "", []string{}, false, "2026-10-02")
	read, err = ReadDayPlanItem(empty)
	if err != nil || read.Memo != "" || read.Exercises == nil || len(read.Exercises) != 0 || read.Finished {
		t.Fatalf("empty read = %+v %v", read, err)
	}
	empty.NoteStoredAttributes(false, true, true)
	if codeOf(t, mustReadErr(empty)) != "memo_invalid" {
		t.Fatal("missing memo")
	}
	empty = plan(t, "", []string{}, false, "2026-10-02")
	empty.NoteStoredAttributes(true, false, true)
	empty.Exercises = nil
	if codeOf(t, mustReadErr(empty)) != "exercises_invalid" {
		t.Fatal("missing exercises")
	}
	empty = plan(t, "", []string{}, false, "2026-10-02")
	empty.NoteStoredAttributes(true, true, false)
	if codeOf(t, mustReadErr(empty)) != "finished_invalid" {
		t.Fatal("missing finished")
	}
}

func TestDayPlanWindowAndRejects(t *testing.T) {
	civil, err := TokyoCivilDate(now)
	if err != nil || civil != "2026-10-02" {
		t.Fatalf("tokyo = %s %v", civil, err)
	}
	for _, date := range []string{"2026-10-01", "2026-10-02", "2026-10-03"} {
		ok, err := IsWritableSessionDate(date, now)
		if err != nil || !ok {
			t.Fatalf("%s writable = %v %v", date, ok, err)
		}
	}
	ok, err := IsWritableSessionDate("2026-09-30", now)
	if err != nil || ok {
		t.Fatalf("far date writable = %v %v", ok, err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{
		UserID: userID, Date: "2026-10-04", Memo: "脚", Exercises: []string{"スクワット"},
		FinishedSet: true, Now: now,
	})
	if codeOf(t, err) != "date_window" {
		t.Fatal(err)
	}

	_, err = BuildDayPlanItem(DayPlanInput{UserID: "USER#other", Date: "2026-10-02", Memo: "脚", Exercises: []string{"スクワット"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "user_id" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-02-31", Memo: "脚", Exercises: []string{"スクワット"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "date" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-10-02", Memo: strings.Repeat("あ", 81), Exercises: []string{"スクワット"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "memo_too_long" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-10-02", Memo: "脚\x00", Exercises: []string{"スクワット"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "memo_invalid" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-10-02", Memo: "脚", Exercises: []string{"スクワット", "スクワット"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "duplicate_exercise" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-10-02", Memo: "脚", Exercises: []string{"スクワット#脚"}, FinishedSet: true, Now: now})
	if codeOf(t, err) != "exercise_invalid" {
		t.Fatal(err)
	}
	_, err = BuildDayPlanItem(DayPlanInput{UserID: userID, Date: "2026-10-02", Memo: "脚", Exercises: []string{"スクワット"}, FinishedSet: false, Now: now})
	if codeOf(t, err) != "finished_invalid" {
		t.Fatal(err)
	}

	item := plan(t, "脚", []string{"スクワット"}, false, "2026-10-02")
	item.PK = "USER#00000000-0000-4000-8000-000000000000"
	if codeOf(t, mustReadErr(item)) != "key_mismatch" {
		t.Fatal("expected key mismatch")
	}
	item = plan(t, "脚", []string{"スクワット"}, false, "2026-10-02")
	item.EntityType = EntityNotionCache
	if codeOf(t, mustReadErr(item)) != "entity_type" {
		t.Fatal("expected entity type")
	}
}

func TestNotionCacheItem(t *testing.T) {
	item, err := BuildNotionCacheItem([]string{"logs", "previous", "スクワット", "2026-10-02"}, `{"exercise":"スクワット"}`, now)
	if err != nil {
		t.Fatal(err)
	}
	if item.PK != NotionCachePK || item.SK != "logs#previous#スクワット#2026-10-02" || item.CacheKey != item.SK {
		t.Fatalf("item = %+v", item)
	}
	if item.TTL-now.Unix() != NotionCacheTTLSeconds {
		t.Fatalf("ttl delta = %d", item.TTL-now.Unix())
	}
	if _, err := ReadNotionCacheItem(item); err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(item.PK, "USER#") {
		t.Fatal("cache pk is per user")
	}

	_, err = BuildNotionCacheItem(nil, "{}", now)
	if codeOf(t, err) != "cache_key" {
		t.Fatal(err)
	}
	_, err = BuildNotionCacheItem([]string{"a", "b", "c", "d", "e"}, "{}", now)
	if codeOf(t, err) != "cache_key" {
		t.Fatal(err)
	}
	_, err = BuildNotionCacheItem([]string{"exercises"}, "", now)
	if codeOf(t, err) != "cache_body" {
		t.Fatal(err)
	}
	_, err = BuildNotionCacheItem([]string{"exercises"}, strings.Repeat("x", cacheBodyLength+1), now)
	if codeOf(t, err) != "cache_body" {
		t.Fatal(err)
	}
}

func TestAddCalendarDays(t *testing.T) {
	next, err := AddCalendarDays("2026-09-30", 1)
	if err != nil || next != "2026-10-01" {
		t.Fatalf("next = %s %v", next, err)
	}
	leap, err := AddCalendarDays("2024-02-28", 2)
	if err != nil || leap != "2024-03-01" {
		t.Fatalf("leap = %s %v", leap, err)
	}
}

func mustTTL(t *testing.T, date string) int64 {
	t.Helper()
	ttl, err := DayPlanTTLEpochSeconds(date)
	if err != nil {
		t.Fatal(err)
	}
	return ttl
}

func mustReadErr(item DayPlanItem) error {
	_, err := ReadDayPlanItem(item)
	return err
}
