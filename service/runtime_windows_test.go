// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func isolatedRuntime(t *testing.T) *serviceRuntime {
	t.Helper()
	return &serviceRuntime{root: t.TempDir(), policy: enrollment{Root: `C:\isolated-user-root`, Core: approval{Version: "v-test"}}, identity: ownership{Instance: "boot-test", Generation: 3, Session: strings.Repeat("a", 64)}, secret: "private-test", controller: "127.0.0.1:18380", providers: map[string]bool{}}
}
func invokeRuntime(s *serviceRuntime, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set(rootHeader, s.policy.Root)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestServiceIPCStatusAndUnavailableSemantics(t *testing.T) {
	s := isolatedRuntime(t)
	w := invokeRuntime(s, "GET", "/sash-service/status", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var state status
	if err := decodeJSON(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Generation != 3 || state.ServiceInstance != "boot-test" || state.Core.Running {
		t.Fatal(state)
	}
	s.fault = failure("OWNERSHIP_UNCERTAIN", "injected uncertainty")
	w = invokeRuntime(s, "GET", "/sash-service/status", "")
	if w.Code != 503 || strings.Contains(w.Body.String(), `"running":false`) {
		t.Fatal("uncertainty synthesized stopped", w.Body.String())
	}
}
func TestServiceIPCRejectsRootAndOwnershipMismatch(t *testing.T) {
	s := isolatedRuntime(t)
	r := httptest.NewRequest("GET", "/sash-service/status", nil)
	r.Header.Set(rootHeader, `C:\different`)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 409 {
		t.Fatal(w.Body.String())
	}
	for _, c := range []command{{Session: strings.Repeat("a", 64), ServiceInstance: "other-boot", Generation: 3}, {Session: strings.Repeat("b", 64), ServiceInstance: "boot-test", Generation: 3}, {Session: strings.Repeat("a", 64), ServiceInstance: "boot-test", Generation: 1}} {
		b, _ := json.Marshal(c)
		w := invokeRuntime(s, "POST", "/sash-service/stop", string(b))
		if w.Code != 409 {
			t.Fatal(w.Body.String())
		}
	}
}
func TestConfirmedStopIdempotency(t *testing.T) {
	s := isolatedRuntime(t)
	for _, generation := range []uint64{3, 2} {
		b, _ := json.Marshal(command{Session: s.identity.Session, ServiceInstance: s.identity.Instance, Generation: generation})
		w := invokeRuntime(s, "POST", "/sash-service/stop", string(b))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
}
func TestIPCRejectsExecutableAndEnvironmentFields(t *testing.T) {
	s := isolatedRuntime(t)
	for _, body := range []string{`{"exe":"C:/bad"}`, `{"argv":["-d","C:/"]}`, `{"env":{"GITHUB_TOKEN":"bad"}}`, `{"bundle":{"config":{"listeners":[]}}}`, `{"bundle":{"config":{},"assets":[],"core":"base64"}}`} {
		w := invokeRuntime(s, "POST", "/sash-service/validate", body)
		if w.Code != 400 {
			t.Fatalf("unsafe IPC accepted: %s: %s", body, w.Body.String())
		}
	}
}
func TestIPCOnlyReservedOperations(t *testing.T) {
	s := isolatedRuntime(t)
	for _, path := range []string{"/sash-service/install", "/sash-service/upgrade", "/sash-service/restart", "/sash-service/start?exe=x"} {
		w := invokeRuntime(s, "POST", path, `{}`)
		if w.Code == 200 || w.Code == 204 {
			t.Fatalf("unsupported operation accepted: %s", path)
		}
	}
}

func TestAbortedControllerStreamDoesNotUnlockMutationMutexTwice(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "20")
		_, _ = w.Write([]byte("short"))
	}))
	defer upstream.Close()
	s := isolatedRuntime(t)
	s.controller = strings.TrimPrefix(upstream.URL, "http://")
	s.transport = &http.Transport{Proxy: nil}
	defer s.transport.CloseIdleConnections()
	// Observe only this live test process through its pseudo-handle. This route
	// never calls stopOwned and no termination rights/signals are exercised.
	s.process = &ownedProcess{process: windows.CurrentProcess()}
	r := httptest.NewRequest("GET", "/traffic", nil)
	r.Header.Set(rootHeader, s.policy.Root)
	r = r.WithContext(context.WithValue(r.Context(), http.ServerContextKey, &http.Server{}))
	func() {
		defer func() {
			if p := recover(); p != nil && p != http.ErrAbortHandler {
				t.Fatalf("unexpected proxy panic: %v", p)
			}
		}()
		s.ServeHTTP(httptest.NewRecorder(), r)
	}()
	if !s.mu.TryLock() {
		t.Fatal("stream retained mutation mutex")
	}
	s.mu.Unlock()
}

func TestSnapshotObservesActualTunEveryTime(t *testing.T) {
	config := `{"tun":{"enable":true}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version" {
			_, _ = w.Write([]byte(`{"version":"v-test"}`))
			return
		}
		_, _ = w.Write([]byte(config))
	}))
	defer upstream.Close()
	s := isolatedRuntime(t)
	s.controller = strings.TrimPrefix(upstream.URL, "http://")
	s.transport = &http.Transport{Proxy: nil}
	defer s.transport.CloseIdleConnections()
	s.process = &ownedProcess{process: windows.CurrentProcess()}
	for _, item := range []struct {
		body           string
		known, enabled bool
	}{{`{"tun":{"enable":true}}`, true, true}, {`{"tun":{"enable":false}}`, true, false}, {`{"tun":{}}`, false, false}, {`invalid`, false, false}} {
		config = item.body
		state, err := s.snapshot()
		if err != nil {
			t.Fatal(err)
		}
		if (state.Core.TunActive != nil) != item.known || item.known && *state.Core.TunActive != item.enabled {
			t.Fatalf("incorrect observation: %+v", state.Core)
		}
	}
}

func TestFailedLaunchBeforeProcessCreationClearsIntent(t *testing.T) {
	root, _ := recoveryFixture(t)
	if err := os.Remove(filepath.Join(root, "private", "active.json")); err != nil {
		t.Fatal(err)
	}
	if err := createPrivateDir(filepath.Join(root, "private", "runtime"), "", false); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(root, "private", "core.exe")
	if err := atomicWrite(exe, []byte("not an executable")); err != nil {
		t.Fatal(err)
	}
	hash, err := hashFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	s := isolatedRuntime(t)
	s.root = root
	s.identity.Instance = strings.Repeat("b", 64)
	s.policy.Core.SHA256 = hash
	s.transport = &http.Transport{Proxy: nil}
	if err = s.launch(&preparedBundle{}); err == nil {
		t.Fatal("invalid executable launched")
	}
	if s.fault != nil || s.process != nil || s.executable != 0 {
		t.Fatalf("confirmed launch failure permanently faulted: %v", s.fault)
	}
	if _, err = os.Stat(s.activePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("launch marker retained", err)
	}
}
func TestFailedStartRollsBackAdministrativeApproval(t *testing.T) {
	root, _ := recoveryFixture(t)
	if err := os.Remove(filepath.Join(root, "private", "active.json")); err != nil {
		t.Fatal(err)
	}
	prior := []byte("approved prior fixture bytes")
	next := []byte("invalid refreshed fixture bytes")
	current := filepath.Join(root, "private", "core.exe")
	backup := current + ".bak"
	if err := atomicWrite(current, next); err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(backup, prior); err != nil {
		t.Fatal(err)
	}
	priorHash, err := hashFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	nextHash, err := hashFile(current)
	if err != nil {
		t.Fatal(err)
	}
	s := isolatedRuntime(t)
	s.root = root
	s.policy.Core = approval{nextHash, "new"}
	s.policy.PreviousCore = &approval{priorHash, "old"}
	if _, err = s.start(command{Session: s.identity.Session, Bundle: nil}); err == nil {
		t.Fatal("invalid candidate accepted")
	}
	if s.fault != nil || s.policy.PreviousCore != nil || s.policy.Core.SHA256 != priorHash {
		t.Fatalf("failed approval not rolled back: %+v %v", s.policy, s.fault)
	}
	b, err := os.ReadFile(current)
	if err != nil || string(b) != string(prior) {
		t.Fatal("old bytes not restored", err)
	}
}

func TestUncertainStopRetainsLaunchEvidence(t *testing.T) {
	s := isolatedRuntime(t)
	if err := os.MkdirAll(filepath.Dir(s.activePath()), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.activePath(), []byte("retained test evidence"), 0600); err != nil {
		t.Fatal(err)
	}
	// A null job handle cannot identify or terminate any process. This injects
	// an API failure without PID signalling or touching the test runner process.
	s.process = &ownedProcess{}
	if err := s.stopOwned(); err == nil {
		t.Fatal("uncertain stop succeeded")
	}
	if s.fault == nil || s.process == nil {
		t.Fatal("uncertain ownership forgotten")
	}
	if _, err := os.Stat(s.activePath()); err != nil {
		t.Fatal("uncertain marker removed", err)
	}
}
