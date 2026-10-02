package validate

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode"
)

func trimSpace(value string) string {
	return strings.TrimFunc(value, unicode.IsSpace)
}

func hasControl(value string) bool {
	for _, r := range value {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

func containsHash(value string) bool {
	return strings.Contains(value, "#")
}

func splitComma(value string) []string {
	return strings.Split(value, ",")
}

func splitDate(value string) (int, int, int, bool) {
	year, err1 := strconv.Atoi(value[0:4])
	month, err2 := strconv.Atoi(value[5:7])
	day, err3 := strconv.Atoi(value[8:10])
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, 0, false
	}
	return year, month, day, true
}

func validDate(year, month, day int) bool {
	if month < 1 || month > 12 || day < 1 || day > 31 || year < 1 {
		return false
	}
	// Civil reconstruction: overflow means the day was not real.
	mdays := []int{0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if month == 2 && isLeap(year) {
		mdays[2] = 29
	}
	return day <= mdays[month]
}

func isLeap(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}

func asFloat(value any) (float64, bool) {
	switch n := value.(type) {
	case json.Number:
		parsed, err := n.Float64()
		if err != nil || mathIsBad(parsed) {
			return 0, false
		}
		return parsed, true
	case float64:
		if mathIsBad(n) {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func mathIsBad(value float64) bool {
	return math.IsNaN(value) || math.IsInf(value, 0)
}
