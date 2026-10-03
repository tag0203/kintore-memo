// Package syntax marks JSON parse failures so the handler can return 400.
package syntax

// Error is a JSON parse failure (request body or a corrupt cache entry).
type Error struct {
	Err error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return "JSON を確認してください"
	}
	return e.Err.Error()
}

func (e *Error) Unwrap() error { return e.Err }
