package draft

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/model"
	"github.com/tag0203/kintore-memo/api/internal/validate"
)

const userID = "11111111-2222-4333-8444-555555555555"

var now = time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)

func input(weight float64) validate.CreateInput {
	return validate.CreateInput{
		Exercise: "スクワット", WeightKg: weight, Reps: 8, Sets: 3, Difficulty: 4, Date: "2026-10-02", Title: "－",
	}
}

type fakeWriter struct {
	calls  int
	failAt int
	seen   []model.NewExerciseLog
}

func (f *fakeWriter) AppendLog(_ context.Context, draftID string, in model.NewExerciseLog) (model.ExerciseLog, error) {
	f.calls++
	f.seen = append(f.seen, in)
	if f.failAt > 0 && f.calls == f.failAt {
		return model.ExerciseLog{}, errors.New("Notion API: boom")
	}
	return model.ExerciseLog{
		ID: "page-" + itoa(f.calls), Exercise: in.Exercise, WeightKg: in.WeightKg,
		Reps: in.Reps, Sets: in.Sets, Difficulty: in.Difficulty, Date: in.Date,
		Title: "－", CreatedAt: "2026-10-02T00:00:00.000Z",
	}, nil
}

func containsID(logs []model.ExerciseLog, id string) bool {
	for _, log := range logs {
		if log.ID == id {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func newService(t *testing.T) (*Service, *Memory, *fakeWriter, *dayplan.Memory) {
	t.Helper()
	store := NewMemory()
	writer := &fakeWriter{}
	plans := dayplan.NewMemory()
	return New(store, plans, writer), store, writer, plans
}

func TestDraftCRUD(t *testing.T) {
	svc, store, writer, _ := newService(t)
	ctx := context.Background()
	first, err := svc.Create(ctx, userID, input(80), now)
	if err != nil {
		t.Fatal(err)
	}
	if first.Synced == nil || *first.Synced || first.Date != "2026-10-02" || first.WeightKg != 80 {
		t.Fatalf("first = %+v", first)
	}
	second, err := svc.Create(ctx, userID, input(90), now)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := svc.List(ctx, userID, "2026-10-02", now)
	if err != nil {
		t.Fatal(err)
	}
	if listed.Synced || len(listed.Drafts) != 2 || !containsID(listed.Drafts, first.ID) || !containsID(listed.Drafts, second.ID) {
		t.Fatalf("list = %+v", listed)
	}
	updated, err := svc.Update(ctx, userID, first.ID, input(82.5), now)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != first.ID || updated.WeightKg != 82.5 || updated.CreatedAt != first.CreatedAt {
		t.Fatalf("updated = %+v", updated)
	}
	if err := svc.Delete(ctx, userID, second.ID, now); err != nil {
		t.Fatal(err)
	}
	listed, err = svc.List(ctx, userID, "2026-10-02", now)
	if err != nil || len(listed.Drafts) != 1 || listed.Drafts[0].WeightKg != 82.5 {
		t.Fatalf("after delete %+v %v", listed, err)
	}
	index, err := store.GetIndex(ctx)
	if err != nil || index == nil || len(index.Days) != 1 {
		t.Fatalf("index = %+v %v", index, err)
	}
	if err := svc.Delete(ctx, userID, first.ID, now); err != nil {
		t.Fatal(err)
	}
	index, err = store.GetIndex(ctx)
	if err != nil || index != nil {
		t.Fatalf("index after last delete = %+v %v", index, err)
	}
	if writer.calls != 0 {
		t.Fatalf("notion calls = %d", writer.calls)
	}
	if _, err := svc.Update(ctx, userID, first.ID, input(70), now); !errors.As(err, new(*NotFoundError)) {
		t.Fatalf("missing update = %v", err)
	}
}

func TestFlushIsIdempotentAndRetriesAfterPartialFailure(t *testing.T) {
	svc, _, writer, plans := newService(t)
	ctx := context.Background()
	first, err := svc.Create(ctx, userID, input(80), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, userID, input(90), now); err != nil {
		t.Fatal(err)
	}
	writer.failAt = 2
	result, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err == nil || result.Synced || result.Flushed != 1 || writer.calls != 2 {
		t.Fatalf("partial = %+v calls %d err %v", result, writer.calls, err)
	}
	listed, err := svc.List(ctx, userID, "2026-10-02", now)
	if err != nil {
		t.Fatal(err)
	}
	syncedRows := 0
	for _, row := range listed.Drafts {
		if row.Synced != nil && *row.Synced {
			syncedRows++
		}
	}
	if syncedRows != 1 || listed.Synced {
		t.Fatalf("partial list synced=%v rows=%d", listed.Synced, syncedRows)
	}
	if _, err := svc.Update(ctx, userID, first.ID, input(70), now); !errors.As(err, new(ConflictError)) {
		t.Fatalf("synced row update = %v", err)
	}

	writer.failAt = 0
	again, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err != nil || !again.Synced || again.Flushed != 1 || writer.calls != 3 {
		t.Fatalf("retry = %+v calls %d err %v", again, writer.calls, err)
	}
	third, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err != nil || !third.Synced || third.Flushed != 0 || writer.calls != 3 {
		t.Fatalf("second finish = %+v calls %d err %v", third, writer.calls, err)
	}
	if err := svc.Delete(ctx, userID, first.ID, now); !errors.As(err, new(ConflictError)) {
		t.Fatalf("delete after sync = %v", err)
	}
	if _, err := svc.Create(ctx, userID, input(100), now); !errors.As(err, new(ConflictError)) {
		t.Fatalf("create after sync = %v", err)
	}
	key, err := ddb.DayPlanKey(userID, "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := plans.Get(ctx, key.PK, key.SK)
	if err != nil || plan == nil || !plan.Finished {
		t.Fatalf("day plan = %+v %v", plan, err)
	}
}

func TestAutoFlushCutoffSkipsTheWritableWindow(t *testing.T) {
	svc, _, writer, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Create(ctx, userID, input(80), now); err != nil {
		t.Fatal(err)
	}
	// Also a draft on the previous writable day.
	older := input(60)
	older.Date = "2026-10-01"
	if _, err := svc.Create(ctx, userID, older, now); err != nil {
		t.Fatal(err)
	}
	due, err := svc.Due(ctx, now)
	if err != nil || len(due) != 0 {
		t.Fatalf("nothing is 2 days old on 2026-10-02: %+v %v", due, err)
	}
	// 2026-10-04 00:10 JST. 2026-10-02 is due. 2026-10-01 is older and still due. 2026-10-03 is not.
	job := time.Date(2026, 10, 3, 15, 10, 0, 0, time.UTC)
	due, err = svc.Due(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, day := range due {
		if day.UserID != userID {
			t.Fatalf("user = %s", day.UserID)
		}
		got[day.Date] = true
	}
	if !got["2026-10-02"] || !got["2026-10-01"] || got["2026-10-03"] || len(due) != 2 {
		t.Fatalf("due = %+v", due)
	}
	// The job must not flush a day that is still writable.
	skipped, err := svc.Flush(ctx, userID, "2026-10-03", job, false)
	if err != nil || skipped.Synced || writer.calls != 0 {
		t.Fatalf("skip = %+v calls %d err %v", skipped, writer.calls, err)
	}
	flushed, err := svc.Flush(ctx, userID, "2026-10-02", job, false)
	if err != nil || !flushed.Synced || flushed.Flushed != 1 || writer.calls != 1 {
		t.Fatalf("auto = %+v calls %d err %v", flushed, writer.calls, err)
	}
	left, err := svc.Due(ctx, job)
	if err != nil || len(left) != 1 || left[0].Date != "2026-10-01" {
		t.Fatalf("left = %+v %v", left, err)
	}
	// A failed night is retried: 2026-10-01 is still pending.
	if _, err := svc.Flush(ctx, userID, "2026-10-01", job, false); err != nil {
		t.Fatal(err)
	}
	left, err = svc.Due(ctx, job)
	if err != nil || len(left) != 0 || writer.calls != 2 {
		t.Fatalf("cleared = %+v calls %d err %v", left, writer.calls, err)
	}
}

func TestPreviousIncludesUnsyncedDrafts(t *testing.T) {
	notionPrev := []model.ExerciseLog{{
		ID: "old", Exercise: "スクワット", WeightKg: 60, Reps: 8, Sets: 3, Difficulty: 3,
		Date: "2026-09-25", Title: "－", CreatedAt: "2026-09-25T00:00:00.000Z",
	}}
	open := []ddb.DraftDayItem{{
		Date: "2026-10-01",
		Drafts: []ddb.DraftRow{{
			ID: "draft-1", Exercise: "スクワット", WeightKg: 70, Reps: 5, Sets: 3, Difficulty: 4,
			Title: "－", CreatedAt: "2026-10-01T01:00:00.000Z",
		}},
	}}
	previous := OverlayPrevious(notionPrev, open, "スクワット", "2026-10-02")
	if len(previous) != 1 || previous[0].ID != "draft-1" || previous[0].Date != "2026-10-01" {
		t.Fatalf("previous = %+v", previous)
	}
	if previous[0].Synced == nil || *previous[0].Synced {
		t.Fatal("unsynced draft should be editable")
	}

	// Same day as Notion: keep the draft and drop the Notion row that shares the page id.
	same := []ddb.DraftDayItem{{
		Date: "2026-09-25",
		Drafts: []ddb.DraftRow{{
			ID: "draft-2", Exercise: "スクワット", WeightKg: 62, Reps: 8, Sets: 3, Difficulty: 3,
			Title: "－", CreatedAt: "2026-09-25T02:00:00.000Z", NotionPageID: "old",
		}},
	}}
	merged := OverlayPrevious(notionPrev, same, "スクワット", "2026-10-02")
	if len(merged) != 1 || merged[0].ID != "draft-2" {
		t.Fatalf("merged = %+v", merged)
	}

	todayNotion := []model.ExerciseLog{{
		ID: "page-9", Exercise: "スクワット", WeightKg: 40, Reps: 8, Sets: 3, Difficulty: 2,
		Date: "2026-10-02", Title: "－", CreatedAt: "2026-10-02T00:00:00.000Z",
	}}
	session := &ddb.DraftDayItem{Date: "2026-10-02", Drafts: []ddb.DraftRow{{
		ID: "draft-3", Exercise: "スクワット", WeightKg: 80, Reps: 8, Sets: 3, Difficulty: 4,
		Title: "－", CreatedAt: "2026-10-02T01:00:00.000Z",
	}}}
	today := OverlayToday(todayNotion, session, "スクワット")
	if len(today) != 2 {
		t.Fatalf("today = %+v", today)
	}
}

// rememberingWriter keeps a page per draft id. loseNext returns an error after
// the page exists, like a lost Notion response. failPut is not used here.
type rememberingWriter struct {
	mu       sync.Mutex
	pages    map[string]string
	creates  int
	loseNext bool
}

func (w *rememberingWriter) AppendLog(_ context.Context, draftID string, in model.NewExerciseLog) (model.ExerciseLog, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pages == nil {
		w.pages = map[string]string{}
	}
	if id, ok := w.pages[draftID]; ok {
		return model.ExerciseLog{
			ID: id, Exercise: in.Exercise, WeightKg: in.WeightKg, Reps: in.Reps, Sets: in.Sets,
			Difficulty: in.Difficulty, Date: in.Date, Title: "－", CreatedAt: "2026-10-02T00:00:00.000Z",
		}, nil
	}
	w.creates++
	id := "page-" + draftID
	w.pages[draftID] = id
	if w.loseNext {
		w.loseNext = false
		return model.ExerciseLog{}, errors.New("Notion API: response lost")
	}
	return model.ExerciseLog{
		ID: id, Exercise: in.Exercise, WeightKg: in.WeightKg, Reps: in.Reps, Sets: in.Sets,
		Difficulty: in.Difficulty, Date: in.Date, Title: "－", CreatedAt: "2026-10-02T00:00:00.000Z",
	}, nil
}

type putFailStore struct {
	*Memory
	skip int
	fail int
}

func (s *putFailStore) PutDay(ctx context.Context, item ddb.DraftDayItem, previousVersion int, exists bool) error {
	if s.skip > 0 {
		s.skip--
		return s.Memory.PutDay(ctx, item, previousVersion, exists)
	}
	if s.fail > 0 {
		s.fail--
		return errors.New("dynamo timeout")
	}
	return s.Memory.PutDay(ctx, item, previousVersion, exists)
}

func TestFlushReusesNotionPageWhenTheResponseOrSaveIsLost(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	writer := &rememberingWriter{loseNext: true}
	svc := New(store, dayplan.NewMemory(), writer)
	created, err := svc.Create(ctx, userID, input(80), now)
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err == nil || result.Synced || writer.creates != 1 {
		t.Fatalf("lost response = %+v creates %d err %v", result, writer.creates, err)
	}
	key, err := ddb.DraftDayKey(userID, "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	day, err := store.GetDay(ctx, key.PK, key.SK)
	if err != nil || day == nil || len(day.Drafts) != 1 || day.Drafts[0].NotionPageID != "" {
		t.Fatalf("page id stored after lost response: %+v %v", day, err)
	}

	again, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err != nil || !again.Synced || writer.creates != 1 {
		t.Fatalf("retry = %+v creates %d err %v", again, writer.creates, err)
	}
	day, err = store.GetDay(ctx, key.PK, key.SK)
	if err != nil || day == nil || day.Drafts[0].NotionPageID != "page-"+created.ID {
		t.Fatalf("reused page = %+v %v", day, err)
	}

	flaky := &putFailStore{Memory: NewMemory()}
	writer = &rememberingWriter{}
	svc = New(flaky, dayplan.NewMemory(), writer)
	created, err = svc.Create(ctx, userID, input(70), now)
	if err != nil {
		t.Fatal(err)
	}
	// The lease put succeeds. The put that stores the page id fails once.
	flaky.skip = 1
	flaky.fail = 1
	failed, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err == nil || failed.Synced || writer.creates != 1 {
		t.Fatalf("dynamo fail = %+v creates %d err %v", failed, writer.creates, err)
	}
	saved, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err != nil || !saved.Synced || writer.creates != 1 {
		t.Fatalf("dynamo retry = %+v creates %d err %v", saved, writer.creates, err)
	}
	day, err = flaky.GetDay(ctx, key.PK, key.SK)
	if err != nil || day == nil || day.Drafts[0].NotionPageID != "page-"+created.ID {
		t.Fatalf("saved after dynamo retry = %+v %v", day, err)
	}
}

type gateWriter struct {
	inner   *fakeWriter
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (g *gateWriter) AppendLog(ctx context.Context, draftID string, in model.NewExerciseLog) (model.ExerciseLog, error) {
	g.once.Do(func() { close(g.entered) })
	<-g.release
	return g.inner.AppendLog(ctx, draftID, in)
}

func TestFlushLeaseBlocksAConcurrentFinish(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	inner := &fakeWriter{}
	writer := &gateWriter{inner: inner, entered: make(chan struct{}), release: make(chan struct{})}
	svc := New(store, dayplan.NewMemory(), writer)
	if _, err := svc.Create(ctx, userID, input(80), now); err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 2)
	go func() {
		_, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
		errCh <- err
	}()
	go func() {
		_, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
		errCh <- err
	}()
	select {
	case <-writer.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("flush did not reach Notion")
	}
	select {
	case err := <-errCh:
		if !errors.As(err, new(BusyError)) {
			t.Fatalf("concurrent flush = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second flush did not stop on the lease")
	}
	close(writer.release)
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("holding flush did not finish")
	}
	if inner.calls != 1 {
		t.Fatalf("notion creates = %d", inner.calls)
	}

	key, err := ddb.DraftDayKey(userID, "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	day, err := store.GetDay(ctx, key.PK, key.SK)
	if err != nil || day == nil {
		t.Fatal(err)
	}
	day.Synced = false
	day.Drafts[0].NotionPageID = ""
	day.FlushLeaseToken = "someone-else"
	day.FlushLeaseUntil = now.Add(time.Minute).Unix()
	if err := store.PutDay(ctx, *day, day.Version, true); err != nil {
		t.Fatal(err)
	}
	blocked, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if !errors.As(err, new(BusyError)) || blocked.Synced || inner.calls != 1 {
		t.Fatalf("held lease = %+v calls %d err %v", blocked, inner.calls, err)
	}
	day.FlushLeaseUntil = now.Add(-time.Second).Unix()
	if err := store.PutDay(ctx, *day, day.Version, true); err != nil {
		t.Fatal(err)
	}
	done, err := svc.Flush(ctx, userID, "2026-10-02", now, true)
	if err != nil || !done.Synced || inner.calls != 2 {
		t.Fatalf("expired lease = %+v calls %d err %v", done, inner.calls, err)
	}
}
