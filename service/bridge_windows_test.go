// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBridgeReadyBearerRootAndEOF(t *testing.T) {
	root := `C:\isolated-bridge-root`
	forwarded := make(chan http.Header, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sash-service/status" {
			writeJSON(w, status{Protocol: 1, Supported: true, Installed: true, Running: true, Compatible: true, Version: version, Root: root, ServiceInstance: "test-boot", CoreVersion: "fake", Core: coreStatus{Running: false}})
			return
		}
		forwarded <- r.Header.Clone()
		writeJSON(w, map[string]string{"version": "fake"})
	}))
	defer upstream.Close()
	address := strings.TrimPrefix(upstream.URL, "http://")
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp4", address)
	}}
	defer transport.CloseIdleConnections()
	input, inputWriter := io.Pipe()
	defer input.Close()
	defer inputWriter.Close()
	output, outputWriter := io.Pipe()
	defer output.Close()
	done := make(chan error, 1)
	go func() { err := serveBridge(root, transport, input, outputWriter); outputWriter.Close(); done <- err }()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Protocol   int    `json:"protocol"`
		Controller string `json:"controller"`
		Secret     string `json:"secret"`
	}
	if err = decodeJSON([]byte(line), &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Protocol != 1 || !sessionPattern.MatchString(ready.Secret) || !strings.HasPrefix(ready.Controller, "127.0.0.1:") {
		t.Fatal("invalid startup line", line)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	req, _ := http.NewRequest("GET", "http://"+ready.Controller+"/version", nil)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 403 {
		t.Fatal("missing bearer accepted")
	}
	res.Body.Close()
	req, _ = http.NewRequest("GET", "http://"+ready.Controller+"/version", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Secret)
	req.Header.Set(rootHeader, `C:\attacker-root`)
	req.Header.Set("Origin", "http://127.0.0.1:18379")
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err = json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	header := <-forwarded
	if header.Get("Authorization") != "" || header.Get(rootHeader) != root || header.Get("Origin") != "" {
		t.Fatal("bridge leaked bearer or accepted caller root", header)
	}
	inputWriter.Close()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stdin EOF did not close bridge")
	}
	if c, err := net.DialTimeout("tcp4", ready.Controller, 100*time.Millisecond); err == nil {
		c.Close()
		t.Fatal("bridge listener survived stdin EOF")
	}
}
func TestBridgeFailsBeforeReadyOnUnavailableObservation(t *testing.T) {
	transport := &http.Transport{Proxy: nil, DialContext: func(context.Context, string, string) (net.Conn, error) {
		return nil, failure("SERVICE_UNAVAILABLE", "injected unavailability")
	}}
	var output strings.Builder
	if err := serveBridge(`C:\isolated`, transport, strings.NewReader(""), &output); err == nil {
		t.Fatal("unavailable service accepted")
	}
	if output.Len() != 0 {
		t.Fatal("ready printed without verified service")
	}
}

func TestStatusAllowsCompatibleServerReleaseButReportsActualVersion(t *testing.T) {
	root := `C:\isolated-compatible-root`
	for _, mode := range []string{"compatible", "protocol", "root", "version", "core", "generation"} {
		t.Run(mode, func(t *testing.T) {
			state := map[string]any{"protocol": 1, "supported": true, "installed": true, "running": true, "compatible": true, "version": "0.0.2", "root": root, "serviceInstance": "old-server-boot", "generation": 0, "coreVersion": "fake", "core": map[string]any{"running": false}}
			switch mode {
			case "protocol":
				state["protocol"] = 2
			case "root":
				state["root"] = `C:\foreign`
			case "version":
				state["version"] = ""
			case "core":
				delete(state, "core")
			case "generation":
				delete(state, "generation")
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, state) }))
			defer server.Close()
			transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "tcp4", strings.TrimPrefix(server.URL, "http://"))
			}}
			defer transport.CloseIdleConnections()
			got, err := fetchStatus(context.Background(), root, transport)
			if mode == "compatible" {
				if err != nil || got.Version != "0.0.2" {
					t.Fatalf("actual compatible server version lost: %+v %v", got, err)
				}
			} else if err == nil {
				t.Fatal("invalid observation accepted")
			}
		})
	}
}
