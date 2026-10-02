package ddb

import (
	"regexp"
	"strings"
	"unicode"
)

var userIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var newReplacer = strings.NewReplacer("\r", "", "\n", "")

func trimSpace(value string) string {
	return strings.TrimFunc(value, unicode.IsSpace)
}

func containsHash(value string) bool {
	return strings.Contains(value, "#")
}

func joinHash(parts []string) string {
	return strings.Join(parts, "#")
}
