// SPDX-License-Identifier: MIT
package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJSONWireRejectsAmbiguousDocuments(t *testing.T) {
	for _, raw := range []string{`{"session":"a","session":"b"}`, `{"bundle":{"config":{"proxies":[],"proxies":[]}}}`, `{} {}`, `{"unknown":true}`, `{"bundle":{"config":[]}}`, strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34)} {
		var c command
		if err := decodeJSON([]byte(raw), &c); err == nil {
			t.Fatalf("ambiguous wire document accepted: %s", raw)
		}
	}
	var c command
	if err := decodeJSON([]byte(`{"session":"`+strings.Repeat("a", 64)+`","bundle":{"config":{"proxies":[]},"assets":[]}}`), &c); err != nil {
		t.Fatal(err)
	}
}
func TestGenerationAndBootProof(t *testing.T) {
	session := strings.Repeat("a", 64)
	o := ownership{Instance: "boot-a", Generation: 7, Session: session, Running: true}
	if err := o.check(command{Session: session, ServiceInstance: "boot-a", Generation: 7}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []command{{Session: session, ServiceInstance: "boot-b", Generation: 7}, {Session: session, ServiceInstance: "boot-a", Generation: 6}, {Session: strings.Repeat("b", 64), ServiceInstance: "boot-a", Generation: 7}, {Session: "bad", ServiceInstance: "boot-a", Generation: 7}} {
		if err := o.check(c); err == nil {
			t.Fatal("stale/foreign ownership accepted")
		}
	}
}
func TestErrorWireDoesNotSynthesizeStopped(t *testing.T) {
	w := httptest.NewRecorder()
	writeError(w, failure("SERVICE_UNAVAILABLE", "service is unavailable"))
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["core"]; ok {
		t.Fatal("error fabricated a Core state")
	}
	e, ok := body["error"].(map[string]any)
	if !ok || e["code"] != "SERVICE_UNAVAILABLE" {
		t.Fatal(body)
	}
}
func TestProtocolStatusShape(t *testing.T) {
	s := status{Protocol: 1, Supported: true, Installed: true, Running: true, Compatible: true, Version: version, Root: `C:\isolated`, ServiceInstance: "boot", CoreVersion: "v1", Generation: 0, Core: coreStatus{Running: false}}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"protocol":1`, `"generation":0`, `"serviceInstance":"boot"`, `"core":{"running":false}`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("missing wire field %s: %s", key, b)
		}
	}
}
func TestRandomCapabilities(t *testing.T) {
	a, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	if !sessionPattern.MatchString(a) || !sessionPattern.MatchString(b) || a == b {
		t.Fatal("invalid capability generation")
	}
}

func TestRunningUnhealthyIsExplicit(t *testing.T) {
	b, err := json.Marshal(coreStatus{Running: true, Healthy: false})
	if err != nil || !strings.Contains(string(b), `"healthy":false`) {
		t.Fatalf("unhealthy omitted: %s %v", b, err)
	}
	for _, bad := range []string{"1.19.30", "v1.19.300", "v1.19.30-dirty", " v1.19.30", "Mihomo Meta v1.19.30"} {
		if coreVersionMatches(bad, "v1.19.30") {
			t.Fatal("inexact controller version accepted", bad)
		}
	}
	if !coreVersionMatches("v1.19.30", "v1.19.30") {
		t.Fatal("exact version rejected")
	}
}
