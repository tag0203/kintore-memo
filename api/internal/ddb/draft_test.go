package ddb

import "testing"
import "time"

func TestDraftDayKeyAndUnsyncedTTL(t *testing.T) {
	key, err := DraftDayKey(userID, "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if key.PK != "USER#"+userID || key.SK != "DRAFTS#2026-10-02" {
		t.Fatalf("key = %+v", key)
	}
	ttl, err := DraftUnsyncedTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	// 30 civil days later, 00:00 Asia/Tokyo. 2026-11-01 00:00 +09:00 = 2026-10-31 15:00 UTC.
	want := time.Date(2026, 10, 31, 15, 0, 0, 0, time.UTC).Unix()
	if ttl != want {
		t.Fatalf("ttl = %d, want %d", ttl, want)
	}
	dayPlan, err := DayPlanTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if ttl <= dayPlan {
		t.Fatal("unsynced draft TTL must outlive the DayPlan item")
	}
}

func TestAutoFlushCutoffInJST(t *testing.T) {
	// Session date 2026-10-02 becomes due at 2026-10-04 00:00 Asia/Tokyo
	// (date + 2 days). The schedule fires at 00:10, which is 15:10 UTC
	// the previous UTC date, because Japan has no daylight saving.
	session := "2026-10-02"
	beforeMidnight := time.Date(2026, 10, 3, 14, 59, 59, 0, time.UTC) // 2026-10-03 23:59:59 JST
	atMidnight := time.Date(2026, 10, 3, 15, 0, 0, 0, time.UTC)       // 2026-10-04 00:00:00 JST
	jobTime := time.Date(2026, 10, 3, 15, 10, 0, 0, time.UTC)         // 2026-10-04 00:10:00 JST

	through, err := AutoFlushThroughDate(beforeMidnight)
	if err != nil {
		t.Fatal(err)
	}
	if through != "2026-10-01" {
		t.Fatalf("through before midnight = %s", through)
	}
	due, err := IsAutoFlushDue(session, beforeMidnight)
	if err != nil || due {
		t.Fatalf("due before midnight = %v %v", due, err)
	}
	// Yesterday relative to 2026-10-03 is still writable, so it is not flushed.
	writable, err := IsWritableSessionDate(session, beforeMidnight)
	if err != nil || !writable {
		t.Fatalf("2026-10-02 should still be writable on 2026-10-03 JST: %v %v", writable, err)
	}

	through, err = AutoFlushThroughDate(atMidnight)
	if err != nil || through != session {
		t.Fatalf("through at midnight = %s %v", through, err)
	}
	due, err = IsAutoFlushDue(session, atMidnight)
	if err != nil || !due {
		t.Fatalf("due at midnight = %v %v", due, err)
	}
	due, err = IsAutoFlushDue(session, jobTime)
	if err != nil || !due {
		t.Fatalf("due at 00:10 JST = %v %v", due, err)
	}
	// Older unfinished days stay due so the next night retries them.
	older, err := IsAutoFlushDue("2026-09-30", jobTime)
	if err != nil || !older {
		t.Fatalf("older day due = %v %v", older, err)
	}
	// 2026-10-03 is yesterday on 2026-10-04 and is still inside the writable window.
	yesterday, err := IsAutoFlushDue("2026-10-03", jobTime)
	if err != nil || yesterday {
		t.Fatalf("yesterday should not auto-flush: %v %v", yesterday, err)
	}
	stillWritable, err := IsWritableSessionDate("2026-10-03", jobTime)
	if err != nil || !stillWritable {
		t.Fatalf("yesterday writable = %v %v", stillWritable, err)
	}
}

func TestDraftSyncedTTLIsShorter(t *testing.T) {
	now := time.Date(2026, 10, 4, 15, 10, 0, 0, time.UTC)
	synced, err := DraftSyncedTTLEpochSeconds(now)
	if err != nil {
		t.Fatal(err)
	}
	unsynced, err := DraftUnsyncedTTLEpochSeconds("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if synced >= unsynced {
		t.Fatalf("synced ttl %d should be sooner than unsynced %d", synced, unsynced)
	}
	if synced != now.UTC().Unix()+DraftSyncedTTLSeconds {
		t.Fatalf("synced ttl = %d", synced)
	}
}
