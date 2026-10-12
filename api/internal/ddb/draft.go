package ddb

import "time"

const (
	EntityDraftDay   = "DraftDay"
	EntityFlushIndex = "FlushIndex"

	// FlushIndexPK is the single known key the nightly job reads.
	// One item lists unfinished user-days, so the job does not Scan or Query.
	FlushIndexPK = "FLUSH#pending"
	FlushIndexSK = "INDEX"

	// DraftUnsyncedTTLDays keeps a draft past the DayPlan window and past
	// several failed nightly retries. date + 30 days, 00:00 Asia/Tokyo.
	DraftUnsyncedTTLDays = 30
	// DraftSyncedTTLSeconds is the shorter life after a successful Notion write.
	DraftSyncedTTLSeconds = 7 * 24 * 60 * 60

	DraftRowLimit   = 40
	FlushIndexLimit = 60

	// AutoFlushAgeDays is how old a session date must be before the nightly
	// job writes it. Tokyo today minus 2 days, which is the first midnight
	// after the date leaves the writable window (yesterday, today, tomorrow).
	AutoFlushAgeDays = 2
)

// DraftRow is one unsynced or just-synced workout line inside a DraftDay.
type DraftRow struct {
	ID           string  `dynamodbav:"id"`
	Exercise     string  `dynamodbav:"exercise"`
	WeightKg     float64 `dynamodbav:"weightKg"`
	Reps         int     `dynamodbav:"reps"`
	Sets         int     `dynamodbav:"sets"`
	Difficulty   int     `dynamodbav:"difficulty"`
	Title        string  `dynamodbav:"title"`
	CreatedAt    string  `dynamodbav:"createdAt"`
	UpdatedAt    string  `dynamodbav:"updatedAt"`
	NotionPageID string  `dynamodbav:"notionPageId,omitempty"`
}

// DraftDayItem is every draft for one user on one session date.
// pk = USER#<sub>, sk = DRAFTS#<YYYY-MM-DD>. No GSI and no Query.
type DraftDayItem struct {
	PK         string     `dynamodbav:"pk"`
	SK         string     `dynamodbav:"sk"`
	EntityType string     `dynamodbav:"entityType"`
	UserID     string     `dynamodbav:"userId"`
	Date       string     `dynamodbav:"date"`
	Drafts     []DraftRow `dynamodbav:"drafts"`
	Synced     bool       `dynamodbav:"synced"`
	UpdatedAt  string     `dynamodbav:"updatedAt"`
	TTL        int64      `dynamodbav:"ttl"`
	Version    int        `dynamodbav:"version"`
	// FlushLeaseToken is the in-flight flush. Another finish, and draft edits,
	// wait until it is cleared or FlushLeaseUntil (unix seconds) has passed.
	FlushLeaseToken string `dynamodbav:"flushLeaseToken,omitempty"`
	FlushLeaseUntil int64  `dynamodbav:"flushLeaseUntil,omitempty"`
	// FlushJobLease is the token from Accept. A retry of that same finish may
	// claim it. A different finish cannot, while the lease is still in the future.
	FlushJobLease string `dynamodbav:"flushJobLease,omitempty"`
	// FlushStatus is "running" or "failed". Empty means no finish is in flight.
	FlushStatus string `dynamodbav:"flushStatus,omitempty"`
}

// PendingDay is one unfinished user-day on the flush index.
type PendingDay struct {
	UserID string `dynamodbav:"userId"`
	Date   string `dynamodbav:"date"`
}

// FlushIndexItem is pk=FLUSH#pending, sk=INDEX. The nightly Lambda GetItem's this key.
type FlushIndexItem struct {
	PK         string       `dynamodbav:"pk"`
	SK         string       `dynamodbav:"sk"`
	EntityType string       `dynamodbav:"entityType"`
	Days       []PendingDay `dynamodbav:"days"`
	UpdatedAt  string       `dynamodbav:"updatedAt"`
	Version    int          `dynamodbav:"version"`
}

// DraftDayKey is USER#<sub> / DRAFTS#<YYYY-MM-DD>.
func DraftDayKey(userID, date string) (Key, error) {
	checkedID, err := AssertUserID(userID)
	if err != nil {
		return Key{}, err
	}
	checkedDate, err := AssertISODate(date)
	if err != nil {
		return Key{}, err
	}
	return Key{PK: "USER#" + checkedID, SK: "DRAFTS#" + checkedDate}, nil
}

// AssertDraftID accepts the UUID this API generated for a draft.
func AssertDraftID(value string) (string, error) {
	if !userIDPattern.MatchString(value) {
		return "", invalid("draft_id", "draft id must be a UUID")
	}
	return value, nil
}

// DraftUnsyncedTTLEpochSeconds expires at 00:00 Asia/Tokyo, 30 civil days after date.
func DraftUnsyncedTTLEpochSeconds(isoDate string) (int64, error) {
	return tokyoMidnightPlusDays(isoDate, DraftUnsyncedTTLDays)
}

// DraftSyncedTTLEpochSeconds is a short TTL after the Notion page exists.
func DraftSyncedTTLEpochSeconds(now time.Time) (int64, error) {
	checked, err := assertNow(now)
	if err != nil {
		return 0, err
	}
	return checked.UTC().Unix() + DraftSyncedTTLSeconds, nil
}

// AutoFlushThroughDate is the newest session date the nightly job may flush.
// At 00:00 Asia/Tokyo on D, that date is D minus 2 days. The job runs at 00:10.
func AutoFlushThroughDate(now time.Time) (string, error) {
	today, err := TokyoCivilDate(now)
	if err != nil {
		return "", err
	}
	return AddCalendarDays(today, -AutoFlushAgeDays)
}

// IsAutoFlushDue reports whether date is on or before Tokyo today minus 2 days.
// A date still inside the writable window (yesterday, today, tomorrow) is never due.
func IsAutoFlushDue(date string, now time.Time) (bool, error) {
	through, err := AutoFlushThroughDate(now)
	if err != nil {
		return false, err
	}
	checked, err := AssertISODate(date)
	if err != nil {
		return false, err
	}
	return checked <= through, nil
}

// FormatUTC is the ISO-8601 millisecond timestamp stored on items.
func FormatUTC(now time.Time) string {
	return isoMillis(now)
}

func tokyoMidnightPlusDays(isoDate string, days int) (int64, error) {
	checked, err := AssertISODate(isoDate)
	if err != nil {
		return 0, err
	}
	parsed, err := time.Parse("2006-01-02", checked)
	if err != nil {
		return 0, err
	}
	jst := time.FixedZone("Asia/Tokyo", int(tokyoOffset/time.Second))
	expires := time.Date(parsed.Year(), parsed.Month(), parsed.Day()+days, 0, 0, 0, 0, jst)
	return expires.Unix(), nil
}
