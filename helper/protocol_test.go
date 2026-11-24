package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestFrames(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("{\"method\":\"status\"}\n{\"method\":\"logs\"}\n"))
	for _, want := range []string{"status", "logs"} {
		b, err := readFrame(r)
		if err != nil {
			t.Fatal(err)
		}
		req, err := parseRequest(b)
		if err != nil || req.Method != want {
			t.Fatalf("%v %v", req, err)
		}
	}
	for _, tc := range []struct {
		b  string
		ok bool
	}{
		{"{\"method\":\"stop\"}", true}, {"{\"method\":\"start\",\"configText\":\"x\"}", true},
		{"{\"method\":\"reload\",\"configText\":null}", false}, {"{\"method\":\"status\",\"extra\":1}", false},
		{"{\"method\":\"status\",\"method\":\"stop\"}", false}, {"{\"method\":\"stop\"}{}", false}, {"null", false},
	} {
		if _, err := parseRequest([]byte(tc.b)); (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.b, err)
		}
	}
	for _, n := range []int{maxFrame, maxFrame + 1} {
		b, err := readFrame(bufio.NewReader(io.MultiReader(bytes.NewReader(bytes.Repeat([]byte{'x'}, n)), strings.NewReader("\n"))))
		if n == maxFrame && (err != nil || len(b) != n) || n > maxFrame && err == nil {
			t.Fatalf("frame %d: got %d, %v", n, len(b), err)
		}
	}
	b, err := json.Marshal(response{OK: true, Value: status{}})
	if err != nil || string(b) != "{\"ok\":true,\"value\":{\"pid\":null,\"coreSha256\":null}}" {
		t.Fatalf("%s %v", b, err)
	}
	for _, tc := range []struct {
		frame response
		want  string
	}{
		{response{OK: true}, `{"ok":true}`},
		{response{Error: "timed out", Code: "reload-timeout"}, `{"ok":false,"error":"timed out","code":"reload-timeout"}`},
	} {
		b, err := json.Marshal(tc.frame)
		if err != nil || string(b) != tc.want {
			t.Fatalf("%s %v", b, err)
		}
	}
}

func TestConfigLengthUsesUTF16(t *testing.T) {
	text := strings.Repeat("😀", maxConfig/2)
	if !validConfigLength(text) || validConfigLength(text+"a") {
		t.Fatal("configuration limit does not match JS string length")
	}
}
