// Package ddb builds the single-table items described in docs/dynamodb.md.
// It does not talk to AWS. The shapes match backend/dynamodb.mjs.
package ddb

import (
	"time"
	"unicode/utf8"
)

const (
	PartitionKey = "pk"
	SortKey      = "sk"
	TTLAttribute = "ttl"

	EntityDayPlan     = "DayPlan"
	EntityNotionCache = "NotionCache"

	NotionCachePK         = "CACHE#notion"
	NotionCacheTTLSeconds = 300
	DayPlanTTLDays        = 2
	SessionDateWindowDays = 1

	memoLength         = 80
	exerciseNameLength = 80
	exerciseCount      = 40
	cacheSegments      = 4
	cacheSegmentLength = 80
	cacheBodyLength    = 350_000
)

const tokyoOffset = 9 * time.Hour

// ItemValidationError is a rejected DayPlan or NotionCache attribute.
type ItemValidationError struct {
	Code string
	Msg  string
}

func (e *ItemValidationError) Error() string { return e.Msg }

func invalid(code, message string) error {
	return &ItemValidationError{Code: code, Msg: message}
}

func hasControl(value string) bool {
	for _, r := range value {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

// AssertUserID accepts a Cognito sub UUID and nothing else.
func AssertUserID(userID string) (string, error) {
	if !userIDPattern.MatchString(userID) {
		return "", invalid("user_id", "userId must be the Cognito sub UUID")
	}
	return userID, nil
}

// AssertISODate accepts a real YYYY-MM-DD calendar day.
func AssertISODate(value string) (string, error) {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return "", invalid("date", "date must be YYYY-MM-DD")
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return "", invalid("date", "date is not a real calendar day")
	}
	return value, nil
}

func assertNow(now time.Time) (time.Time, error) {
	if now.IsZero() {
		return time.Time{}, invalid("now", "now must be a Date")
	}
	return now, nil
}

// TokyoCivilDate is YYYY-MM-DD in Asia/Tokyo.
func TokyoCivilDate(now time.Time) (string, error) {
	checked, err := assertNow(now)
	if err != nil {
		return "", err
	}
	return checked.UTC().Add(tokyoOffset).Format("2006-01-02"), nil
}

// AddCalendarDays adds civil days without a timezone shift.
func AddCalendarDays(isoDate string, days int) (string, error) {
	checked, err := AssertISODate(isoDate)
	if err != nil {
		return "", err
	}
	parsed, err := time.Parse("2006-01-02", checked)
	if err != nil {
		return "", err
	}
	return parsed.AddDate(0, 0, days).Format("2006-01-02"), nil
}

// IsWritableSessionDate is Tokyo yesterday, today, or tomorrow.
func IsWritableSessionDate(date string, now time.Time) (bool, error) {
	today, err := TokyoCivilDate(now)
	if err != nil {
		return false, err
	}
	checked, err := AssertISODate(date)
	if err != nil {
		return false, err
	}
	prev, err := AddCalendarDays(today, -SessionDateWindowDays)
	if err != nil {
		return false, err
	}
	next, err := AddCalendarDays(today, SessionDateWindowDays)
	if err != nil {
		return false, err
	}
	return checked == prev || checked == today || checked == next, nil
}

// DayPlanTTLEpochSeconds expires at 00:00 Asia/Tokyo, two civil days after date.
func DayPlanTTLEpochSeconds(isoDate string) (int64, error) {
	checked, err := AssertISODate(isoDate)
	if err != nil {
		return 0, err
	}
	parsed, err := time.Parse("2006-01-02", checked)
	if err != nil {
		return 0, err
	}
	jst := time.FixedZone("Asia/Tokyo", int(tokyoOffset/time.Second))
	expires := time.Date(parsed.Year(), parsed.Month(), parsed.Day()+DayPlanTTLDays, 0, 0, 0, 0, jst)
	return expires.Unix(), nil
}

// Key is a single-table primary key.
type Key struct {
	PK string
	SK string
}

// DayPlanKey is USER#<sub> / DAY#<YYYY-MM-DD>.
func DayPlanKey(userID, date string) (Key, error) {
	checkedID, err := AssertUserID(userID)
	if err != nil {
		return Key{}, err
	}
	checkedDate, err := AssertISODate(date)
	if err != nil {
		return Key{}, err
	}
	return Key{PK: "USER#" + checkedID, SK: "DAY#" + checkedDate}, nil
}

func normalizeMemo(memo string) (string, error) {
	stripped := newReplacer.Replace(memo)
	if hasControl(stripped) {
		return "", invalid("memo_invalid", "memo contains control characters")
	}
	if utf8.RuneCountInString(stripped) > memoLength {
		return "", invalid("memo_too_long", "memo is longer than 80 characters")
	}
	return stripped, nil
}

func normalizeExerciseName(name string) (string, error) {
	trimmed := trimSpace(name)
	if trimmed == "" {
		return "", invalid("exercise_invalid", "exercise name is empty")
	}
	if utf8.RuneCountInString(trimmed) > exerciseNameLength {
		return "", invalid("exercise_too_long", "exercise name is longer than 80 characters")
	}
	if hasControl(trimmed) || containsHash(trimmed) {
		return "", invalid("exercise_invalid", "exercise name contains a control character or '#'")
	}
	return trimmed, nil
}

func normalizeExercises(exercises []string) ([]string, error) {
	if exercises == nil {
		return nil, invalid("exercises_invalid", "exercises must be an array")
	}
	if len(exercises) > exerciseCount {
		return nil, invalid("exercises_too_many", "exercises exceeds 40")
	}
	names := make([]string, 0, len(exercises))
	seen := make(map[string]struct{}, len(exercises))
	for _, name := range exercises {
		normalized, err := normalizeExerciseName(name)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[normalized]; ok {
			return nil, invalid("duplicate_exercise", "exercises contains a duplicate")
		}
		seen[normalized] = struct{}{}
		names = append(names, normalized)
	}
	return names, nil
}

// DayPlanItem is one menu row. Workout numbers are not stored here.
type DayPlanItem struct {
	PK         string   `dynamodbav:"pk"`
	SK         string   `dynamodbav:"sk"`
	EntityType string   `dynamodbav:"entityType"`
	UserID     string   `dynamodbav:"userId"`
	Date       string   `dynamodbav:"date"`
	Memo       string   `dynamodbav:"memo"`
	Exercises  []string `dynamodbav:"exercises"`
	Finished   bool     `dynamodbav:"finished"`
	UpdatedAt  string   `dynamodbav:"updatedAt"`
	TTL        int64    `dynamodbav:"ttl"`
}

// DayPlanInput is the writable menu. UserID comes from the JWT sub.
type DayPlanInput struct {
	UserID    string
	Date      string
	Memo      string
	Exercises []string
	Finished  bool
	Now       time.Time
	// FinishedSet distinguishes a missing boolean from false.
	FinishedSet bool
}

// BuildDayPlanItem validates and returns a full PutItem payload.
func BuildDayPlanItem(input DayPlanInput) (DayPlanItem, error) {
	userID, err := AssertUserID(input.UserID)
	if err != nil {
		return DayPlanItem{}, err
	}
	date, err := AssertISODate(input.Date)
	if err != nil {
		return DayPlanItem{}, err
	}
	now, err := assertNow(input.Now)
	if err != nil {
		return DayPlanItem{}, err
	}
	writable, err := IsWritableSessionDate(date, now)
	if err != nil {
		return DayPlanItem{}, err
	}
	if !writable {
		return DayPlanItem{}, invalid("date_window", "date is outside the writable session window")
	}
	if !input.FinishedSet {
		return DayPlanItem{}, invalid("finished_invalid", "finished must be a boolean")
	}
	memo, err := normalizeMemo(input.Memo)
	if err != nil {
		return DayPlanItem{}, err
	}
	exercises, err := normalizeExercises(input.Exercises)
	if err != nil {
		return DayPlanItem{}, err
	}
	key, err := DayPlanKey(userID, date)
	if err != nil {
		return DayPlanItem{}, err
	}
	ttl, err := DayPlanTTLEpochSeconds(date)
	if err != nil {
		return DayPlanItem{}, err
	}
	return DayPlanItem{
		PK:         key.PK,
		SK:         key.SK,
		EntityType: EntityDayPlan,
		UserID:     userID,
		Date:       date,
		Memo:       memo,
		Exercises:  exercises,
		Finished:   input.Finished,
		UpdatedAt:  isoMillis(now),
		TTL:        ttl,
	}, nil
}

// ReadDayPlanItem checks a stored item still matches the key and TTL rules.
func ReadDayPlanItem(item DayPlanItem) (DayPlanItem, error) {
	if item.EntityType != EntityDayPlan {
		return DayPlanItem{}, invalid("entity_type", "item is not a DayPlan")
	}
	userID, err := AssertUserID(item.UserID)
	if err != nil {
		return DayPlanItem{}, err
	}
	date, err := AssertISODate(item.Date)
	if err != nil {
		return DayPlanItem{}, err
	}
	key, err := DayPlanKey(userID, date)
	if err != nil {
		return DayPlanItem{}, err
	}
	if item.PK != key.PK || item.SK != key.SK {
		return DayPlanItem{}, invalid("key_mismatch", "DayPlan key does not match userId and date")
	}
	if item.UpdatedAt == "" {
		return DayPlanItem{}, invalid("updated_at", "updatedAt must be a string")
	}
	ttl, err := DayPlanTTLEpochSeconds(date)
	if err != nil {
		return DayPlanItem{}, err
	}
	if item.TTL != ttl {
		return DayPlanItem{}, invalid("ttl", "DayPlan ttl does not match the session date")
	}
	memo, err := normalizeMemo(item.Memo)
	if err != nil {
		return DayPlanItem{}, err
	}
	if item.Exercises == nil {
		return DayPlanItem{}, invalid("exercises_invalid", "exercises must be an array")
	}
	exercises, err := normalizeExercises(item.Exercises)
	if err != nil {
		return DayPlanItem{}, err
	}
	return DayPlanItem{
		PK:         key.PK,
		SK:         key.SK,
		EntityType: EntityDayPlan,
		UserID:     userID,
		Date:       date,
		Memo:       memo,
		Exercises:  exercises,
		Finished:   item.Finished,
		UpdatedAt:  item.UpdatedAt,
		TTL:        ttl,
	}, nil
}

// NotionCacheTTLEpochSeconds is now plus 300 seconds.
func NotionCacheTTLEpochSeconds(now time.Time) (int64, error) {
	checked, err := assertNow(now)
	if err != nil {
		return 0, err
	}
	return checked.UTC().Unix() + NotionCacheTTLSeconds, nil
}

func normalizeCacheSegments(segments []string) ([]string, error) {
	if len(segments) < 1 || len(segments) > cacheSegments {
		return nil, invalid("cache_key", "cache key needs 1 to 4 segments")
	}
	out := make([]string, len(segments))
	for i, segment := range segments {
		trimmed := trimSpace(segment)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > cacheSegmentLength {
			return nil, invalid("cache_key", "cache segment length is out of range")
		}
		if hasControl(trimmed) || containsHash(trimmed) {
			return nil, invalid("cache_key", "cache segment contains a control character or '#'")
		}
		out[i] = trimmed
	}
	return out, nil
}

// NotionCacheKey joins 1–4 segments with '#'.
func NotionCacheKey(segments []string) (Key, string, error) {
	normalized, err := normalizeCacheSegments(segments)
	if err != nil {
		return Key{}, "", err
	}
	cacheKey := joinHash(normalized)
	return Key{PK: NotionCachePK, SK: cacheKey}, cacheKey, nil
}

// NotionCacheItem is one short-lived Notion response. Body is opaque JSON text.
type NotionCacheItem struct {
	PK         string `dynamodbav:"pk"`
	SK         string `dynamodbav:"sk"`
	EntityType string `dynamodbav:"entityType"`
	CacheKey   string `dynamodbav:"cacheKey"`
	Body       string `dynamodbav:"body"`
	CachedAt   string `dynamodbav:"cachedAt"`
	TTL        int64  `dynamodbav:"ttl"`
}

// BuildNotionCacheItem replaces any previous body for the same segments.
func BuildNotionCacheItem(segments []string, body string, now time.Time) (NotionCacheItem, error) {
	key, cacheKey, err := NotionCacheKey(segments)
	if err != nil {
		return NotionCacheItem{}, err
	}
	checked, err := assertNow(now)
	if err != nil {
		return NotionCacheItem{}, err
	}
	if body == "" {
		return NotionCacheItem{}, invalid("cache_body", "cache body must be a non-empty string")
	}
	if len([]rune(body)) > cacheBodyLength {
		return NotionCacheItem{}, invalid("cache_body", "cache body exceeds the size limit")
	}
	ttl, err := NotionCacheTTLEpochSeconds(checked)
	if err != nil {
		return NotionCacheItem{}, err
	}
	return NotionCacheItem{
		PK:         key.PK,
		SK:         key.SK,
		EntityType: EntityNotionCache,
		CacheKey:   cacheKey,
		Body:       body,
		CachedAt:   isoMillis(checked),
		TTL:        ttl,
	}, nil
}

// ReadNotionCacheItem checks the stored cache envelope.
func ReadNotionCacheItem(item NotionCacheItem) (NotionCacheItem, error) {
	if item.EntityType != EntityNotionCache {
		return NotionCacheItem{}, invalid("entity_type", "item is not a NotionCache")
	}
	if item.PK != NotionCachePK {
		return NotionCacheItem{}, invalid("key_mismatch", "NotionCache partition key is wrong")
	}
	if item.CacheKey == "" || item.SK != item.CacheKey {
		return NotionCacheItem{}, invalid("key_mismatch", "NotionCache sort key does not match cacheKey")
	}
	if item.Body == "" {
		return NotionCacheItem{}, invalid("cache_body", "cache body must be a non-empty string")
	}
	if item.CachedAt == "" {
		return NotionCacheItem{}, invalid("cached_at", "cachedAt must be a string")
	}
	if item.TTL == 0 {
		return NotionCacheItem{}, invalid("ttl", "NotionCache ttl must be a number")
	}
	return item, nil
}

func isoMillis(now time.Time) string {
	return now.UTC().Format("2006-01-02T15:04:05.000Z")
}
