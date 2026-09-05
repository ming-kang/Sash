// SPDX-License-Identifier: MIT
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
)

const protocol = 1
var version = "0.1.0"
const serviceName = "SashService"
const pipeName = `\\.\pipe\SashService-v1`
const maxRequest = 176 << 20
const maxConfig = 8 << 20
const rootHeader = "X-Sash-Root"

var sessionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type asset struct {
	Path string `json:"path"`
	Data string `json:"data"`
}
type bundle struct {
	Config map[string]any `json:"config"`
	Assets []asset        `json:"assets"`
}
type command struct {
	Session         string  `json:"session,omitempty"`
	ServiceInstance string  `json:"serviceInstance,omitempty"`
	Generation      uint64  `json:"generation,omitempty"`
	Bundle          *bundle `json:"bundle,omitempty"`
}
type coreStatus struct {
	Running   bool   `json:"running"`
	PID       uint32 `json:"pid,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	Healthy   bool   `json:"healthy,omitempty"`
	Version   string `json:"version,omitempty"`
	TunActive *bool  `json:"tunActive,omitempty"`
}
type status struct {
	Protocol        int        `json:"protocol"`
	Supported       bool       `json:"supported"`
	Installed       bool       `json:"installed"`
	Running         bool       `json:"running"`
	Compatible      bool       `json:"compatible"`
	Version         string     `json:"version"`
	Root            string     `json:"root"`
	ServiceInstance string     `json:"serviceInstance"`
	CoreVersion     string     `json:"coreVersion"`
	Generation      uint64     `json:"generation"`
	Core            coreStatus `json:"core"`
}
type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *wireError) Error() string       { return e.Code + ": " + e.Message }
func failure(code, message string) error { return &wireError{code, message} }
func writeError(w http.ResponseWriter, err error) {
	e := &wireError{"SERVICE_ERROR", "Service operation failed; inspect protected diagnostics"}
	var wire *wireError
	if errors.As(err, &wire) {
		e = wire
	}
	code := http.StatusServiceUnavailable
	switch e.Code {
	case "INVALID_REQUEST", "UNSAFE_CONFIG":
		code = 400
	case "FORBIDDEN", "OWNER_MISMATCH":
		code = 403
	case "CONFLICT", "STALE_INSTANCE", "ROOT_MISMATCH":
		code = 409
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": e})
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func randomToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// Reject duplicate keys before struct/map decoding: a single semantic document
// must reach policy checking and the Core. Go's default last-key-wins is unsafe
// at a protocol boundary shared with other parsers.
func uniqueJSON(d *json.Decoder, depth int) error {
	if depth > 32 {
		return errors.New("JSON nesting limit")
	}
	t, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			t, err := d.Token()
			if err != nil {
				return err
			}
			k, ok := t.(string)
			if !ok || seen[k] {
				return errors.New("duplicate JSON key")
			}
			seen[k] = true
			if err := uniqueJSON(d, depth+1); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := uniqueJSON(d, depth+1); err != nil {
				return err
			}
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	_, err = d.Token()
	return err
}
func decodeJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := uniqueJSON(d, 0); err != nil {
		return failure("INVALID_REQUEST", err.Error())
	}
	if _, err := d.Token(); err != io.EOF {
		return failure("INVALID_REQUEST", "Exactly one JSON value is required")
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return failure("INVALID_REQUEST", fmt.Sprintf("Invalid JSON: %s", err))
	}
	return nil
}
func readCommand(r *http.Request) (command, error) {
	var c command
	b, err := io.ReadAll(io.LimitReader(r.Body, maxRequest+1))
	if err != nil {
		return c, err
	}
	if len(b) > maxRequest {
		return c, failure("INVALID_REQUEST", "Request exceeds size limit")
	}
	err = decodeJSON(b, &c)
	return c, err
}

type ownership struct {
	Instance   string
	Generation uint64
	Session    string
	Running    bool
}

func (o ownership) check(c command) error {
	if !sessionPattern.MatchString(c.Session) {
		return failure("INVALID_REQUEST", "Invalid session")
	}
	if c.ServiceInstance != o.Instance || c.Generation != o.Generation {
		return failure("STALE_INSTANCE", "Service boot or Core generation changed")
	}
	if o.Session != "" && c.Session != o.Session {
		return failure("CONFLICT", "Core belongs to a different session")
	}
	return nil
}

// Compare complete controller release tokens, never substrings or numeric prefixes.
func coreVersionMatches(observed any, approved string) bool {
	value, ok := observed.(string)
	return ok && approved != "" && value == approved
}
func (c coreStatus) MarshalJSON() ([]byte, error) {
	type plain coreStatus
	if !c.Running {
		return json.Marshal(plain(c))
	}
	return json.Marshal(struct {
		plain
		Healthy bool `json:"healthy"`
	}{plain(c), c.Healthy})
}

// SCM availability does not observe Core ownership. Keep the full live wire
// shape (including generation zero), but omit unobserved runtime fields.
func (s status) MarshalJSON() ([]byte, error) {
	type plain status
	if s.Running {
		return json.Marshal(plain(s))
	}
	return json.Marshal(struct {
		plain
		Root            string      `json:"root,omitempty"`
		CoreVersion     string      `json:"coreVersion,omitempty"`
		ServiceInstance *string     `json:"serviceInstance,omitempty"`
		Generation      *uint64     `json:"generation,omitempty"`
		Core            *coreStatus `json:"core,omitempty"`
	}{plain: plain(s), Root: s.Root, CoreVersion: s.CoreVersion})
}
