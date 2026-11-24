package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"time"
	"unicode/utf8"
)

const (
	maxFrame          = 20 << 20
	maxConfig         = 8 << 20
	idleTimeout       = 15 * time.Second
	reloadTimeout     = 180 * time.Second
	controllerPreface = 0
)

var errReloadTimeout = errors.New("Privileged Core configuration reload timed out")

type request struct {
	Method string
	Config string
}
type response struct {
	OK    bool   `json:"ok"`
	Value any    `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`
}
type status struct {
	PID    *int    `json:"pid"`
	Digest *string `json:"coreSha256"`
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	var b []byte
	for {
		p, err := r.ReadSlice('\n')
		if err == nil {
			p = p[:len(p)-1]
		}
		if len(b)+len(p) > maxFrame {
			return nil, errors.New("helper frame is too large")
		}
		b = append(b, p...)
		if err != bufio.ErrBufferFull {
			return b, err
		}
	}
}
func uniqueJSONObject(b []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, errors.New("expected JSON object")
	}
	m := map[string]json.RawMessage{}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, err
		}
		k := key.(string)
		if _, ok := m[k]; ok {
			return nil, errors.New("duplicate JSON key")
		}
		var val json.RawMessage
		if err = d.Decode(&val); err != nil {
			return nil, err
		}
		m[k] = val
	}
	if _, err = d.Token(); err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return m, nil
}
func parseRequest(b []byte) (request, error) {
	var r request
	invalid := errors.New("Invalid helper request")
	m, err := uniqueJSONObject(b)
	if err != nil || !utf8.Valid(b) || json.Unmarshal(m["method"], &r.Method) != nil {
		return r, invalid
	}
	switch r.Method {
	case "start", "reload":
		if len(m) != 2 || json.Unmarshal(m["configText"], &r.Config) != nil || !validConfigLength(r.Config) {
			return r, invalid
		}
	case "logs", "status", "stop":
		if len(m) != 1 {
			return r, invalid
		}
	default:
		return r, invalid
	}
	return r, nil
}

func validConfigLength(text string) bool {
	if len(text) <= maxConfig {
		return text != ""
	}
	units := 0
	for _, r := range text {
		units++
		if r > '\uFFFF' {
			units++
		}
		if units > maxConfig {
			return false
		}
	}
	return true
}
