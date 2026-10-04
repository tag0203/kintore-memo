package secrets

import (
	"context"
	"testing"
	"time"
)

type fakeGetter struct {
	calls []string
	value func(name string) string
}

func (f *fakeGetter) GetParameter(_ context.Context, name string) (string, error) {
	f.calls = append(f.calls, name)
	return f.value(name), nil
}

func TestDirectEnvSkipsSSM(t *testing.T) {
	getter := &fakeGetter{value: func(string) string { return "from-ssm" }}
	loader := NewLoader(getter, time.Now)
	pair, err := loader.Load(context.Background(), func(key string) string {
		switch key {
		case "NOTION_TOKEN":
			return " secret_local "
		case "NOTION_DATABASE_ID":
			return " db-1 "
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if pair.Token != "secret_local" || pair.DatabaseID != "db-1" || len(getter.calls) != 0 {
		t.Fatalf("pair = %+v calls = %v", pair, getter.calls)
	}
}

func TestSSMIsCachedUntilTTL(t *testing.T) {
	now := time.Unix(0, 0).UTC()
	getter := &fakeGetter{value: func(name string) string {
		if len(name) >= 5 && name[len(name)-5:] == "token" {
			return "secret_from_ssm"
		}
		return "db-1"
	}}
	loader := NewLoader(getter, func() time.Time { return now })
	loader.SetTTL(time.Second)
	env := map[string]string{
		"NOTION_TOKEN_PARAM":       "/app/notion/token",
		"NOTION_DATABASE_ID_PARAM": "/app/notion/database-id",
	}
	getenv := func(key string) string { return env[key] }
	first, err := loader.Load(context.Background(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loader.Load(context.Background(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(getter.calls) != 2 {
		t.Fatalf("calls = %v", getter.calls)
	}
	now = now.Add(time.Second)
	if _, err := loader.Load(context.Background(), getenv); err != nil {
		t.Fatal(err)
	}
	if len(getter.calls) != 4 {
		t.Fatalf("calls after ttl = %v", getter.calls)
	}
}

func TestEmptyParameterFailsClosed(t *testing.T) {
	loader := NewLoader(&fakeGetter{value: func(string) string { return "  " }}, time.Now)
	_, err := loader.Load(context.Background(), func(key string) string {
		switch key {
		case "NOTION_TOKEN_PARAM":
			return "/app/notion/token"
		case "NOTION_DATABASE_ID_PARAM":
			return "/app/notion/database-id"
		default:
			return ""
		}
	})
	if err == nil || err.Error() != "Notion の設定がありません" {
		t.Fatal(err)
	}
}

func TestConfigured(t *testing.T) {
	if Configured(func(string) string { return "" }) {
		t.Fatal("empty env is not configured")
	}
	if !Configured(func(key string) string {
		switch key {
		case "NOTION_TOKEN_PARAM":
			return "/t"
		case "NOTION_DATABASE_ID_PARAM":
			return "/d"
		default:
			return ""
		}
	}) {
		t.Fatal("parameter names should count as configured")
	}
}
