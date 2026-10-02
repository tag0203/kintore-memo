package notion

import (
	"math"
	"strings"
	"unicode"
)

type stringError string

func (e stringError) Error() string { return string(e) }

func errString(message string) error { return stringError(message) }

func trim(value string) string {
	return strings.TrimFunc(value, unicode.IsSpace)
}

func isWhole(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}
