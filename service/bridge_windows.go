// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

func pipeTransport() *http.Transport {
	return &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return dialVerifiedPipe(ctx) }, ForceAttemptHTTP2: false, MaxIdleConns: 16, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 60 * time.Second}
}

// Protocol, not a package release version, is the wire compatibility boundary.
var serviceVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

func fetchStatus(ctx context.Context, root string, transport http.RoundTripper) (status, error) {
	var state status
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://sash-service/sash-service/status", nil)
	if err != nil {
		return state, err
	}
	req.Header.Set(rootHeader, root)
	res, err := transport.RoundTrip(req)
	if err != nil {
		return state, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil {
		return state, err
	}
	if len(b) > 65536 {
		return state, failure("PROTOCOL_MISMATCH", "Oversized status response")
	}
	if res.StatusCode != 200 {
		var body struct {
			Error wireError `json:"error"`
		}
		if err := decodeJSON(b, &body); err != nil || body.Error.Code == "" {
			return state, failure("SERVICE_UNAVAILABLE", "Service status failed")
		}
		return state, &body.Error
	}
	// Missing Core observation must not decode to the zero-value stopped state.
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(b, &fields); err != nil {
		return state, err
	}
	var coreFields map[string]json.RawMessage
	if err = json.Unmarshal(fields["core"], &coreFields); err != nil {
		return state, err
	}
	if string(coreFields["running"]) != "false" && string(coreFields["running"]) != "true" {
		return state, failure("PROTOCOL_MISMATCH", "Missing positive Core observation")
	}
	if len(fields["generation"]) == 0 || string(fields["generation"]) == "null" {
		return state, failure("PROTOCOL_MISMATCH", "Missing Core generation")
	}
	if err = decodeJSON(b, &state); err != nil {
		return state, err
	}
	if state.Protocol != protocol || !serviceVersionPattern.MatchString(state.Version) || !state.Compatible || !state.Supported || !state.Installed || !state.Running || state.ServiceInstance == "" {
		return state, failure("PROTOCOL_MISMATCH", "Service protocol is incompatible")
	}
	if !strings.EqualFold(root, state.Root) {
		return state, failure("ROOT_MISMATCH", "Service is enrolled to a different root")
	}
	return state, nil
}
func bridge(root string) error {
	transport := pipeTransport()
	defer transport.CloseIdleConnections()
	return serveBridge(root, transport, os.Stdin, os.Stdout)
}
func serveBridge(root string, transport *http.Transport, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	_, err := fetchStatus(ctx, root, transport)
	cancel()
	if err != nil {
		return err
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	target := &url.URL{Scheme: "http", Host: "sash-service"}
	proxy := &httputil.ReverseProxy{Transport: transport, FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Host = "sash-service"
		pr.Out.Header.Del("Authorization")
		pr.Out.Header.Del("Origin")
		pr.Out.Header.Del(rootHeader)
		pr.Out.Header.Set(rootHeader, root)
		pr.Out.Header.Del("Forwarded")
		pr.Out.Header.Del("X-Forwarded-For")
		pr.Out.Header.Del("X-Forwarded-Host")
		pr.Out.Header.Del("X-Forwarded-Proto")
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		writeError(w, failure("SERVICE_UNAVAILABLE", "Authenticated service transport is unavailable"))
	}}
	var mu sync.Mutex
	connections := map[net.Conn]bool{}
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384,
		ConnState: func(c net.Conn, state http.ConnState) {
			mu.Lock()
			defer mu.Unlock()
			if state == http.StateClosed {
				delete(connections, c)
			} else {
				connections[c] = true
			}
		},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Values("Authorization")
			if len(auth) != 1 || subtle.ConstantTimeCompare([]byte(auth[0]), []byte("Bearer "+token)) != 1 {
				writeError(w, failure("FORBIDDEN", "Bridge bearer is required"))
				return
			}
			if r.Host != listener.Addr().String() {
				writeError(w, failure("FORBIDDEN", "Invalid loopback authority"))
				return
			}
			// The user gateway may forward a browser Origin. The required bearer
			// (never accepted in a query/cookie/subprotocol) is the capability.
			r.Body = http.MaxBytesReader(w, r.Body, maxRequest)
			proxy.ServeHTTP(w, r)
		})}
	eof := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, input)
		close(eof)
		_ = server.Close()
		mu.Lock()
		defer mu.Unlock()
		for c := range connections {
			_ = c.Close()
		}
	}()
	if err = json.NewEncoder(output).Encode(struct {
		Protocol   int    `json:"protocol"`
		Controller string `json:"controller"`
		Secret     string `json:"secret"`
	}{protocol, listener.Addr().String(), token}); err != nil {
		return err
	}
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	select {
	case <-eof:
		return nil
	default:
		return &bridgeRuntimeError{err}
	}
}

type bridgeRuntimeError struct{ err error }

func (e *bridgeRuntimeError) Error() string { return e.err.Error() }
func (e *bridgeRuntimeError) Unwrap() error { return e.err }
