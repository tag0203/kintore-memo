package draft

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/tag0203/kintore-memo/api/internal/dayplan"
	"github.com/tag0203/kintore-memo/api/internal/ddb"
	"github.com/tag0203/kintore-memo/api/internal/model"
	"github.com/tag0203/kintore-memo/api/internal/validate"
)

const pageTitle = "－"

const (
	// StatusOpen is a day that is not being written to Notion.
	StatusOpen = "open"
	// StatusFlushing means a finish has been accepted and the worker still holds the lease.
	StatusFlushing = "flushing"
	// StatusSynced means every row for the day is in Notion.
	StatusSynced = "synced"
	// StatusFailed means the last finish stopped before the day was synced.
	StatusFailed = "failed"

	flushRunning = "running"
	flushFailed  = "failed"
)

// acceptLeaseFor covers the gap between accepting a finish and the worker
// claiming the day. flushLeaseFor outlives the flush Lambda (300s).
// Draft edits are rejected while either lease is still in the future.
const (
	acceptLeaseFor = 60 * time.Second
	flushLeaseFor  = 360 * time.Second
)

// PageWriter creates one Notion page for a draft id.
// AppendLog must look up that id before creating, and must return the page
// even when a following cache delete fails, so the caller can store the page id.
type PageWriter interface {
	AppendLog(ctx context.Context, draftID string, input model.NewExerciseLog) (model.ExerciseLog, error)
}

// Service is draft CRUD and the idempotent Notion flush.
type Service struct {
	store  Store
	plans  dayplan.Store
	writer PageWriter
}

// New builds a service. plans and writer are used by Flush.
func New(store Store, plans dayplan.Store, writer PageWriter) *Service {
	return &Service{store: store, plans: plans, writer: writer}
}

// ListResult is GET /api/drafts.
type ListResult struct {
	Date   string              `json:"date"`
	Synced bool                `json:"synced"`
	Status string              `json:"status"`
	Drafts []model.ExerciseLog `json:"drafts"`
}

// FinishResult is POST /api/day/{date}/finish.
// Status is open, flushing, synced, or failed. The HTTP handler returns this
// before Notion replies. Flushed is how many pages this call stored.
type FinishResult struct {
	Date    string `json:"date"`
	Flushed int    `json:"flushed"`
	Synced  bool   `json:"synced"`
	Status  string `json:"status"`
}

// FlushJob is the payload the API hands to the flush Lambda.
type FlushJob struct {
	UserID string `json:"userId"`
	Date   string `json:"date"`
	Lease  string `json:"lease"`
}

// History is the session day plus other unfinished days for this user.
type History struct {
	Session *ddb.DraftDayItem
	Open    []ddb.DraftDayItem
	Synced  bool
	Status  string
}

// Create appends one draft. It does not call Notion.
func (s *Service) Create(ctx context.Context, userID string, input validate.CreateInput, now time.Time) (model.ExerciseLog, error) {
	if err := s.writable(userID, input.Date, now); err != nil {
		return model.ExerciseLog{}, err
	}
	existing, found, err := s.loadDay(ctx, userID, input.Date)
	if err != nil {
		return model.ExerciseLog{}, err
	}
	if found && existing.Synced {
		return model.ExerciseLog{}, ConflictError{}
	}
	if err := s.ensurePending(ctx, userID, input.Date, now); err != nil {
		return model.ExerciseLog{}, err
	}
	id, err := newDraftID()
	if err != nil {
		return model.ExerciseLog{}, err
	}
	stamp := ddb.FormatUTC(now)
	row := ddb.DraftRow{
		ID:         id,
		Exercise:   input.Exercise,
		WeightKg:   input.WeightKg,
		Reps:       input.Reps,
		Sets:       input.Sets,
		Difficulty: input.Difficulty,
		Title:      titleOrDash(input.Title),
		CreatedAt:  stamp,
		UpdatedAt:  stamp,
	}
	item, err := s.updateDay(ctx, userID, input.Date, now, func(day *ddb.DraftDayItem) error {
		if leaseActive(*day, now) {
			return BusyError{}
		}
		if day.Synced {
			return ConflictError{}
		}
		if len(day.Drafts) >= ddb.DraftRowLimit {
			return &validate.Error{Msg: "記録が多すぎます"}
		}
		day.Drafts = append(day.Drafts, row)
		day.Synced = false
		return nil
	})
	if err != nil {
		return model.ExerciseLog{}, err
	}
	return logFromRow(item, row), nil
}

// Update replaces weight, reps, sets, and difficulty on an unsynced draft.
// Exercise and date stay on the row that was saved.
func (s *Service) Update(ctx context.Context, userID, id string, input validate.CreateInput, now time.Time) (model.ExerciseLog, error) {
	if _, err := ddb.AssertDraftID(id); err != nil {
		return model.ExerciseLog{}, &NotFoundError{}
	}
	if err := s.writable(userID, input.Date, now); err != nil {
		return model.ExerciseLog{}, err
	}
	var saved ddb.DraftRow
	item, err := s.updateDay(ctx, userID, input.Date, now, func(day *ddb.DraftDayItem) error {
		if leaseActive(*day, now) {
			return BusyError{}
		}
		index := rowIndex(day.Drafts, id)
		if index < 0 {
			return &NotFoundError{}
		}
		if day.Synced || day.Drafts[index].NotionPageID != "" {
			return ConflictError{}
		}
		if day.Drafts[index].Exercise != input.Exercise {
			return &validate.Error{Msg: "種目名を確認してください"}
		}
		day.Drafts[index].WeightKg = input.WeightKg
		day.Drafts[index].Reps = input.Reps
		day.Drafts[index].Sets = input.Sets
		day.Drafts[index].Difficulty = input.Difficulty
		day.Drafts[index].Title = titleOrDash(input.Title)
		day.Drafts[index].UpdatedAt = ddb.FormatUTC(now)
		saved = day.Drafts[index]
		return nil
	})
	if err != nil {
		return model.ExerciseLog{}, err
	}
	return logFromRow(item, saved), nil
}

// Delete removes an unsynced draft. The last draft on a day drops the item and the flush index entry.
func (s *Service) Delete(ctx context.Context, userID, id string, now time.Time) error {
	if _, err := ddb.AssertDraftID(id); err != nil {
		return &NotFoundError{}
	}
	if _, err := ddb.AssertUserID(userID); err != nil {
		return err
	}
	day, row, err := s.findRow(ctx, userID, id, now)
	if err != nil {
		return err
	}
	if day.Synced || row.NotionPageID != "" {
		return ConflictError{}
	}
	writable, err := ddb.IsWritableSessionDate(day.Date, now)
	if err != nil {
		return err
	}
	if !writable {
		return &validate.Error{Msg: "日付を確認してください"}
	}
	_, err = s.updateDay(ctx, userID, day.Date, now, func(current *ddb.DraftDayItem) error {
		if leaseActive(*current, now) {
			return BusyError{}
		}
		index := rowIndex(current.Drafts, id)
		if index < 0 {
			return &NotFoundError{}
		}
		if current.Synced || current.Drafts[index].NotionPageID != "" {
			return ConflictError{}
		}
		current.Drafts = append(current.Drafts[:index], current.Drafts[index+1:]...)
		if len(current.Drafts) == 0 {
			return errDeleteDay
		}
		return nil
	})
	if err != nil {
		return err
	}
	_, stillThere, err := s.loadDay(ctx, userID, day.Date)
	if err != nil {
		return err
	}
	if stillThere {
		return nil
	}
	return s.removePending(ctx, userID, day.Date, now)
}

// List returns the drafts for one writable session date.
func (s *Service) List(ctx context.Context, userID, date string, now time.Time) (ListResult, error) {
	if err := s.writable(userID, date, now); err != nil {
		return ListResult{}, err
	}
	item, found, err := s.loadDay(ctx, userID, date)
	if err != nil {
		return ListResult{}, err
	}
	if !found {
		return ListResult{Date: date, Status: StatusOpen, Drafts: emptyLogs()}, nil
	}
	return ListResult{Date: date, Synced: item.Synced, Status: dayStatus(item, true, now), Drafts: logsFromDay(item)}, nil
}

// History loads the session day and other unfinished days for previous-log merge.
func (s *Service) History(ctx context.Context, userID, date string, now time.Time) (History, error) {
	if _, err := ddb.AssertUserID(userID); err != nil {
		return History{}, err
	}
	if _, err := ddb.AssertISODate(date); err != nil {
		return History{}, err
	}
	session, found, err := s.loadDay(ctx, userID, date)
	if err != nil {
		return History{}, err
	}
	index, _, err := s.loadIndex(ctx)
	if err != nil {
		return History{}, err
	}
	open := make([]ddb.DraftDayItem, 0)
	for _, pending := range index.Days {
		if pending.UserID != userID || pending.Date == date {
			continue
		}
		day, dayFound, err := s.loadDay(ctx, pending.UserID, pending.Date)
		if err != nil {
			return History{}, err
		}
		if !dayFound || day.Synced {
			continue
		}
		open = append(open, day)
	}
	history := History{Open: open, Synced: found && session.Synced, Status: dayStatus(session, found, now)}
	if found {
		history.Session = &session
	}
	return history, nil
}

// Due lists unfinished days whose session date is at least two Tokyo days old.
func (s *Service) Due(ctx context.Context, now time.Time) ([]ddb.PendingDay, error) {
	through, err := ddb.AutoFlushThroughDate(now)
	if err != nil {
		return nil, err
	}
	index, found, err := s.loadIndex(ctx)
	if err != nil || !found {
		return nil, err
	}
	due := make([]ddb.PendingDay, 0)
	for _, day := range index.Days {
		if _, err := ddb.AssertISODate(day.Date); err != nil {
			continue
		}
		if day.Date <= through {
			due = append(due, day)
		}
	}
	return due, nil
}

// Accept records a finish and returns without calling Notion.
// enqueue receives the lease token the worker must claim. A day that is already
// synced, or already flushing, does not enqueue again. An empty day is closed here.
func (s *Service) Accept(ctx context.Context, userID, date string, now time.Time, enqueue func(context.Context, FlushJob) error) (FinishResult, error) {
	if _, err := ddb.AssertUserID(userID); err != nil {
		return FinishResult{}, err
	}
	if _, err := ddb.AssertISODate(date); err != nil {
		return FinishResult{}, err
	}
	if err := s.writable(userID, date, now); err != nil {
		return FinishResult{}, err
	}
	lease, err := newDraftID()
	if err != nil {
		return FinishResult{}, err
	}
	outcome := ""
	_, err = s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
		if day.Synced {
			outcome = "synced"
			return errNoWrite
		}
		if leaseActive(*day, now) {
			outcome = "busy"
			return errNoWrite
		}
		if !hasPendingDraft(day) {
			outcome = "close"
			day.Synced = true
			day.FlushStatus = ""
			day.FlushLeaseToken = ""
			day.FlushJobLease = ""
			day.FlushLeaseUntil = 0
			if day.Drafts == nil {
				day.Drafts = []ddb.DraftRow{}
			}
			return nil
		}
		outcome = "queued"
		day.FlushLeaseToken = lease
		day.FlushJobLease = lease
		day.FlushLeaseUntil = now.Add(acceptLeaseFor).Unix()
		day.FlushStatus = flushRunning
		return nil
	})
	if err != nil {
		return FinishResult{Date: date, Status: StatusFailed}, err
	}
	switch outcome {
	case "synced":
		return FinishResult{Date: date, Status: StatusSynced, Synced: true}, nil
	case "busy":
		return FinishResult{Date: date, Status: StatusFlushing}, nil
	case "close":
		if err = s.markFinished(ctx, userID, date, now); err != nil {
			return FinishResult{Date: date, Status: StatusFailed}, err
		}
		if err = s.removePending(ctx, userID, date, now); err != nil {
			return FinishResult{Date: date, Status: StatusFailed}, err
		}
		return FinishResult{Date: date, Status: StatusSynced, Synced: true}, nil
	default:
		if enqueue == nil {
			_ = s.clearLease(ctx, userID, date, now, lease, true)
			return FinishResult{Date: date, Status: StatusFailed}, &EnqueueError{}
		}
		if err = enqueue(ctx, FlushJob{UserID: userID, Date: date, Lease: lease}); err != nil {
			_ = s.clearLease(ctx, userID, date, now, lease, true)
			return FinishResult{Date: date, Status: StatusFailed}, &EnqueueError{Err: err}
		}
		return FinishResult{Date: date, Status: StatusFlushing}, nil
	}
}

// RunAccepted is the worker path for a finish Accept already leased.
// It claims that lease, then writes Notion. A second worker for the same job gets BusyError.
func (s *Service) RunAccepted(ctx context.Context, userID, date string, now time.Time, lease string) (FinishResult, error) {
	if _, err := ddb.AssertDraftID(lease); err != nil {
		return FinishResult{}, err
	}
	return s.flush(ctx, userID, date, now, true, lease)
}

// Flush writes every row that does not yet have a Notion page id, then marks the day synced.
// closeDay is the manual 「終了」 path: an empty day is still closed.
// The nightly job passes closeDay false and must only call this for due dates.
// A second call does not create another Notion page for a row that already has an id.
// Overlapping calls take a conditional lease on the DraftDay item. The writer
// looks up the draft id in Notion before creating a page.
func (s *Service) Flush(ctx context.Context, userID, date string, now time.Time, closeDay bool) (FinishResult, error) {
	return s.flush(ctx, userID, date, now, closeDay, "")
}

func (s *Service) flush(ctx context.Context, userID, date string, now time.Time, closeDay bool, jobLease string) (result FinishResult, err error) {
	if _, err = ddb.AssertUserID(userID); err != nil {
		return FinishResult{}, err
	}
	if _, err = ddb.AssertISODate(date); err != nil {
		return FinishResult{}, err
	}
	if !closeDay {
		var due bool
		due, err = ddb.IsAutoFlushDue(date, now)
		if err != nil {
			return FinishResult{}, err
		}
		if !due {
			return FinishResult{Date: date, Status: StatusOpen}, nil
		}
	} else if err = s.writable(userID, date, now); err != nil {
		return FinishResult{}, err
	}
	owner := ""
	held := false
	if jobLease != "" {
		var claimed string
		claimed, err = s.claimAcceptedLease(ctx, userID, date, now, jobLease)
		if errors.Is(err, errAlreadyDone) {
			return FinishResult{Date: date, Status: StatusSynced, Synced: true}, nil
		}
		if err != nil {
			status := StatusFailed
			if errors.As(err, new(BusyError)) {
				status = StatusFlushing
			}
			return FinishResult{Date: date, Status: status}, err
		}
		owner = claimed
		held = true
	} else {
		owner, err = newDraftID()
		if err != nil {
			return FinishResult{}, err
		}
	}
	defer func() {
		if !held {
			return
		}
		_ = s.clearLease(ctx, userID, date, now, owner, err != nil)
	}()
	created := 0
	for {
		item, found, loadErr := s.loadDay(ctx, userID, date)
		if loadErr != nil {
			return FinishResult{}, loadErr
		}
		if !found && !closeDay {
			if err = s.removePending(ctx, userID, date, now); err != nil {
				return FinishResult{}, err
			}
			held = false
			return FinishResult{Date: date, Flushed: created, Status: StatusSynced, Synced: true}, nil
		}
		if found && item.Synced {
			break
		}
		if !held {
			if err = s.acquireLease(ctx, userID, date, now, owner); err != nil {
				return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, err
			}
			held = true
			continue
		}
		if found && leaseHeldByOther(item, now, owner) {
			held = false
			return FinishResult{Date: date, Flushed: created, Status: StatusFlushing}, BusyError{}
		}
		var pending *ddb.DraftRow
		if found {
			for i := range item.Drafts {
				if item.Drafts[i].NotionPageID == "" {
					pending = &item.Drafts[i]
					break
				}
			}
		}
		if pending == nil {
			if _, err = s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
				if leaseHeldByOther(*day, now, owner) {
					return BusyError{}
				}
				day.Synced = true
				day.FlushStatus = ""
				day.FlushLeaseToken = ""
				day.FlushJobLease = ""
				day.FlushLeaseUntil = 0
				if day.Drafts == nil {
					day.Drafts = []ddb.DraftRow{}
				}
				return nil
			}); err != nil {
				return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, err
			}
			break
		}
		row := *pending
		pageID, writeErr := s.writePage(ctx, date, row)
		if writeErr != nil {
			return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, writeErr
		}
		if _, err = s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
			if leaseHeldByOther(*day, now, owner) {
				return BusyError{}
			}
			for i := range day.Drafts {
				if day.Drafts[i].ID == row.ID && day.Drafts[i].NotionPageID == "" {
					day.Drafts[i].NotionPageID = pageID
					day.Drafts[i].UpdatedAt = ddb.FormatUTC(now)
				}
			}
			return nil
		}); err != nil {
			return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, err
		}
		created++
	}
	if err = s.markFinished(ctx, userID, date, now); err != nil {
		return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, err
	}
	if err = s.removePending(ctx, userID, date, now); err != nil {
		return FinishResult{Date: date, Flushed: created, Status: StatusFailed}, err
	}
	held = false
	return FinishResult{Date: date, Flushed: created, Status: StatusSynced, Synced: true}, nil
}

var errAlreadyDone = errors.New("draft day already synced")

func hasPendingDraft(day *ddb.DraftDayItem) bool {
	if day == nil {
		return false
	}
	for i := range day.Drafts {
		if day.Drafts[i].NotionPageID == "" {
			return true
		}
	}
	return false
}

func dayStatus(day ddb.DraftDayItem, found bool, now time.Time) string {
	if !found {
		return StatusOpen
	}
	if day.Synced {
		return StatusSynced
	}
	if leaseActive(day, now) {
		return StatusFlushing
	}
	if day.FlushStatus == flushFailed || day.FlushStatus == flushRunning {
		return StatusFailed
	}
	return StatusOpen
}

func leaseActive(day ddb.DraftDayItem, now time.Time) bool {
	return day.FlushLeaseToken != "" && day.FlushLeaseUntil > now.Unix()
}

func leaseHeldByOther(day ddb.DraftDayItem, now time.Time, owner string) bool {
	if day.FlushLeaseToken == "" || day.FlushLeaseUntil <= now.Unix() {
		return false
	}
	return day.FlushLeaseToken != owner
}

func (s *Service) acquireLease(ctx context.Context, userID, date string, now time.Time, owner string) error {
	_, err := s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
		if day.Synced {
			return errNoWrite
		}
		if leaseHeldByOther(*day, now, owner) {
			return BusyError{}
		}
		day.FlushLeaseToken = owner
		day.FlushLeaseUntil = now.Add(flushLeaseFor).Unix()
		day.FlushStatus = flushRunning
		return nil
	})
	return err
}

func (s *Service) claimAcceptedLease(ctx context.Context, userID, date string, now time.Time, jobLease string) (string, error) {
	owner, err := newDraftID()
	if err != nil {
		return "", err
	}
	synced := false
	_, err = s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
		if day.Synced {
			synced = true
			return errNoWrite
		}
		// The accept token may be replaced once. A second delivery of this job,
		// or any other finish, waits until that lease expires.
		if leaseActive(*day, now) && day.FlushLeaseToken != jobLease {
			return BusyError{}
		}
		day.FlushJobLease = jobLease
		day.FlushLeaseToken = owner
		day.FlushLeaseUntil = now.Add(flushLeaseFor).Unix()
		day.FlushStatus = flushRunning
		return nil
	})
	if err != nil {
		return "", err
	}
	if synced {
		return "", errAlreadyDone
	}
	return owner, nil
}

func (s *Service) clearLease(ctx context.Context, userID, date string, now time.Time, owner string, failed bool) error {
	_, err := s.updateDay(ctx, userID, date, now, func(day *ddb.DraftDayItem) error {
		if day.FlushLeaseToken != owner {
			return errNoWrite
		}
		day.FlushLeaseToken = ""
		day.FlushJobLease = ""
		day.FlushLeaseUntil = 0
		if failed && !day.Synced {
			day.FlushStatus = flushFailed
		}
		return nil
	})
	return err
}

func (s *Service) writePage(ctx context.Context, date string, row ddb.DraftRow) (string, error) {
	if s.writer == nil {
		return "", errors.New("Notion の設定がありません")
	}
	created, err := s.writer.AppendLog(ctx, row.ID, model.NewExerciseLog{
		Exercise:   row.Exercise,
		WeightKg:   row.WeightKg,
		Reps:       row.Reps,
		Sets:       row.Sets,
		Difficulty: row.Difficulty,
		Date:       date,
		Title:      titleOrDash(row.Title),
	})
	if err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("Notion API: empty page")
	}
	return created.ID, nil
}

func (s *Service) writable(userID, date string, now time.Time) error {
	if _, err := ddb.AssertUserID(userID); err != nil {
		return err
	}
	if _, err := ddb.AssertISODate(date); err != nil {
		return &validate.Error{Msg: "日付 は YYYY-MM-DD で指定してください"}
	}
	ok, err := ddb.IsWritableSessionDate(date, now)
	if err != nil {
		return err
	}
	if !ok {
		return &validate.Error{Msg: "日付を確認してください"}
	}
	return nil
}

func (s *Service) markFinished(ctx context.Context, userID, date string, now time.Time) error {
	if s.plans == nil {
		return nil
	}
	key, err := ddb.DayPlanKey(userID, date)
	if err != nil {
		return err
	}
	item, err := s.plans.Get(ctx, key.PK, key.SK)
	if err != nil {
		return &StorageError{Err: err}
	}
	if item == nil {
		writable, err := ddb.IsWritableSessionDate(date, now)
		if err != nil || !writable {
			return err
		}
		built, err := ddb.BuildDayPlanItem(ddb.DayPlanInput{
			UserID:      userID,
			Date:        date,
			Memo:        "",
			Exercises:   []string{},
			Finished:    true,
			FinishedSet: true,
			Now:         now,
		})
		if err != nil {
			return err
		}
		if err := s.plans.Put(ctx, built); err != nil {
			return &StorageError{Err: err}
		}
		return nil
	}
	read, err := ddb.ReadDayPlanItem(*item)
	if err != nil {
		return &StorageError{Err: err}
	}
	read.Finished = true
	read.UpdatedAt = ddb.FormatUTC(now)
	read.NoteStoredAttributes(true, true, true)
	if err := s.plans.Put(ctx, read); err != nil {
		return &StorageError{Err: err}
	}
	return nil
}

var (
	errDeleteDay = errors.New("delete draft day")
	errNoWrite   = errors.New("draft day unchanged")
)

func (s *Service) updateDay(ctx context.Context, userID, date string, now time.Time, fn func(*ddb.DraftDayItem) error) (ddb.DraftDayItem, error) {
	key, err := ddb.DraftDayKey(userID, date)
	if err != nil {
		return ddb.DraftDayItem{}, err
	}
	var last error
	for range 5 {
		current, found, err := s.loadDay(ctx, userID, date)
		if err != nil {
			return ddb.DraftDayItem{}, err
		}
		previous := 0
		if found {
			previous = current.Version
		} else {
			current = ddb.DraftDayItem{
				PK:         key.PK,
				SK:         key.SK,
				EntityType: ddb.EntityDraftDay,
				UserID:     userID,
				Date:       date,
				Drafts:     []ddb.DraftRow{},
			}
		}
		if err := fn(&current); err != nil {
			if errors.Is(err, errNoWrite) {
				if !found {
					return ddb.DraftDayItem{}, nil
				}
				return current, nil
			}
			if errors.Is(err, errDeleteDay) {
				if !found {
					return ddb.DraftDayItem{}, nil
				}
				if err := s.store.DeleteDay(ctx, key.PK, key.SK, previous); err != nil {
					if errors.Is(err, ErrVersionConflict) {
						last = err
						continue
					}
					return ddb.DraftDayItem{}, &StorageError{Err: err}
				}
				return ddb.DraftDayItem{}, nil
			}
			return ddb.DraftDayItem{}, err
		}
		current.UpdatedAt = ddb.FormatUTC(now)
		ttl, err := dayTTL(current.Synced, date, now)
		if err != nil {
			return ddb.DraftDayItem{}, err
		}
		current.TTL = ttl
		current.Version = previous + 1
		if !found {
			current.Version = 1
		}
		err = s.store.PutDay(ctx, current, previous, found)
		if errors.Is(err, ErrVersionConflict) {
			last = err
			continue
		}
		if err != nil {
			return ddb.DraftDayItem{}, &StorageError{Err: err}
		}
		return current, nil
	}
	if last == nil {
		last = ErrVersionConflict
	}
	return ddb.DraftDayItem{}, &StorageError{Err: last}
}

func dayTTL(synced bool, date string, now time.Time) (int64, error) {
	if synced {
		return ddb.DraftSyncedTTLEpochSeconds(now)
	}
	return ddb.DraftUnsyncedTTLEpochSeconds(date)
}

func (s *Service) loadDay(ctx context.Context, userID, date string) (ddb.DraftDayItem, bool, error) {
	key, err := ddb.DraftDayKey(userID, date)
	if err != nil {
		return ddb.DraftDayItem{}, false, err
	}
	item, err := s.store.GetDay(ctx, key.PK, key.SK)
	if err != nil {
		return ddb.DraftDayItem{}, false, &StorageError{Err: err}
	}
	if item == nil {
		return ddb.DraftDayItem{}, false, nil
	}
	if item.EntityType != ddb.EntityDraftDay || item.PK != key.PK || item.SK != key.SK || item.UserID != userID || item.Date != date {
		return ddb.DraftDayItem{}, false, &StorageError{Err: errors.New("stored draft day does not match the key")}
	}
	if item.Drafts == nil {
		item.Drafts = []ddb.DraftRow{}
	}
	return *item, true, nil
}

func (s *Service) loadIndex(ctx context.Context) (ddb.FlushIndexItem, bool, error) {
	item, err := s.store.GetIndex(ctx)
	if err != nil {
		return ddb.FlushIndexItem{}, false, &StorageError{Err: err}
	}
	if item == nil {
		return ddb.FlushIndexItem{}, false, nil
	}
	if item.PK != ddb.FlushIndexPK || item.SK != ddb.FlushIndexSK || item.EntityType != ddb.EntityFlushIndex {
		return ddb.FlushIndexItem{}, false, &StorageError{Err: errors.New("stored flush index does not match the key")}
	}
	if item.Days == nil {
		item.Days = []ddb.PendingDay{}
	}
	return *item, true, nil
}

func (s *Service) ensurePending(ctx context.Context, userID, date string, now time.Time) error {
	return s.withIndex(ctx, now, func(index *ddb.FlushIndexItem) (bool, error) {
		for _, day := range index.Days {
			if day.UserID == userID && day.Date == date {
				return false, errIndexUnchanged
			}
		}
		if len(index.Days) >= ddb.FlushIndexLimit {
			return false, &validate.Error{Msg: "記録が多すぎます"}
		}
		index.Days = append(index.Days, ddb.PendingDay{UserID: userID, Date: date})
		return false, nil
	})
}

func (s *Service) removePending(ctx context.Context, userID, date string, now time.Time) error {
	return s.withIndex(ctx, now, func(index *ddb.FlushIndexItem) (bool, error) {
		next := make([]ddb.PendingDay, 0, len(index.Days))
		for _, day := range index.Days {
			if day.UserID == userID && day.Date == date {
				continue
			}
			next = append(next, day)
		}
		if len(next) == len(index.Days) {
			return false, errIndexUnchanged
		}
		index.Days = next
		return len(next) == 0, nil
	})
}

var errIndexUnchanged = errors.New("flush index unchanged")

func (s *Service) withIndex(ctx context.Context, now time.Time, fn func(*ddb.FlushIndexItem) (bool, error)) error {
	var last error
	for range 5 {
		current, found, err := s.loadIndex(ctx)
		if err != nil {
			return err
		}
		previous := 0
		if found {
			previous = current.Version
		} else {
			current = ddb.FlushIndexItem{
				PK:         ddb.FlushIndexPK,
				SK:         ddb.FlushIndexSK,
				EntityType: ddb.EntityFlushIndex,
				Days:       []ddb.PendingDay{},
			}
		}
		deleteIndex, err := fn(&current)
		if errors.Is(err, errIndexUnchanged) {
			return nil
		}
		if err != nil {
			return err
		}
		if deleteIndex {
			if !found {
				return nil
			}
			err = s.store.DeleteIndex(ctx, previous)
		} else {
			current.UpdatedAt = ddb.FormatUTC(now)
			current.Version = previous + 1
			if !found {
				current.Version = 1
			}
			err = s.store.PutIndex(ctx, current, previous, found)
		}
		if errors.Is(err, ErrVersionConflict) {
			last = err
			continue
		}
		if err != nil {
			return &StorageError{Err: err}
		}
		return nil
	}
	if last == nil {
		last = ErrVersionConflict
	}
	return &StorageError{Err: last}
}

func (s *Service) findRow(ctx context.Context, userID, id string, now time.Time) (ddb.DraftDayItem, ddb.DraftRow, error) {
	dates, err := s.candidateDates(ctx, userID, now)
	if err != nil {
		return ddb.DraftDayItem{}, ddb.DraftRow{}, err
	}
	for _, date := range dates {
		item, found, err := s.loadDay(ctx, userID, date)
		if err != nil {
			return ddb.DraftDayItem{}, ddb.DraftRow{}, err
		}
		if !found {
			continue
		}
		index := rowIndex(item.Drafts, id)
		if index >= 0 {
			return item, item.Drafts[index], nil
		}
	}
	return ddb.DraftDayItem{}, ddb.DraftRow{}, &NotFoundError{}
}

func (s *Service) candidateDates(ctx context.Context, userID string, now time.Time) ([]string, error) {
	seen := map[string]struct{}{}
	dates := make([]string, 0, 4)
	add := func(date string) {
		if _, ok := seen[date]; ok {
			return
		}
		if _, err := ddb.AssertISODate(date); err != nil {
			return
		}
		seen[date] = struct{}{}
		dates = append(dates, date)
	}
	today, err := ddb.TokyoCivilDate(now)
	if err != nil {
		return nil, err
	}
	for _, offset := range []int{-ddb.SessionDateWindowDays, 0, ddb.SessionDateWindowDays} {
		date, err := ddb.AddCalendarDays(today, offset)
		if err != nil {
			return nil, err
		}
		add(date)
	}
	index, _, err := s.loadIndex(ctx)
	if err != nil {
		return nil, err
	}
	for _, day := range index.Days {
		if day.UserID == userID {
			add(day.Date)
		}
	}
	return dates, nil
}

func rowIndex(rows []ddb.DraftRow, id string) int {
	for i := range rows {
		if rows[i].ID == id {
			return i
		}
	}
	return -1
}

func titleOrDash(title string) string {
	if title == "" {
		return pageTitle
	}
	return title
}

func newDraftID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func logFromRow(day ddb.DraftDayItem, row ddb.DraftRow) model.ExerciseLog {
	synced := day.Synced || row.NotionPageID != ""
	return model.ExerciseLog{
		ID:         row.ID,
		Exercise:   row.Exercise,
		WeightKg:   row.WeightKg,
		Reps:       row.Reps,
		Sets:       row.Sets,
		Difficulty: row.Difficulty,
		Date:       day.Date,
		Title:      row.Title,
		CreatedAt:  row.CreatedAt,
		Synced:     &synced,
	}
}
