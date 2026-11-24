package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
)

const maxControllerConnections = 128

var websocketKey = regexp.MustCompile("^[A-Za-z0-9+/]{22}==$")

type connListener struct {
	incoming chan net.Conn
	closed   chan struct{}
	once     sync.Once
}
type trackedConn struct {
	net.Conn
	done chan struct{}
	once sync.Once
}

func (c *trackedConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}
func (l *connListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.incoming:
		return c, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *connListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *connListener) Addr() net.Addr { return &net.UnixAddr{Name: "helper-controller", Net: "unix"} }

type controller struct {
	dir, socket, address, secret string
	transport                    *http.Transport
	gateway                      *http.Server
	listener                     *connListener
	mu                           sync.Mutex
	conns                        map[*trackedConn]struct{}
	closed                       bool
}

func newController(p Platform, dir string, pid func() int) (*controller, error) {
	private, err := os.MkdirTemp(dir, ".api-")
	if err != nil {
		return nil, err
	}
	c := &controller{dir: private, conns: make(map[*trackedConn]struct{}), listener: &connListener{incoming: make(chan net.Conn), closed: make(chan struct{})}}
	t := &http.Transport{ResponseHeaderTimeout: 30 * time.Second, ForceAttemptHTTP2: false}
	if runtime.GOOS == "windows" {
		verifier, ok := p.(controllerPeerPlatform)
		if !ok {
			os.RemoveAll(private)
			return nil, errors.New("Windows controller peer verification unavailable")
		}
		reservation, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			os.RemoveAll(private)
			return nil, err
		}
		c.address = reservation.Addr().String()
		if err = reservation.Close(); err != nil {
			os.RemoveAll(private)
			return nil, err
		}
		var key [32]byte
		if _, err := rand.Read(key[:]); err != nil {
			os.RemoveAll(private)
			return nil, err
		}
		c.secret = hex.EncodeToString(key[:])
		t.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, "tcp4", c.address)
			if err != nil {
				return nil, err
			}
			corePID := pid()
			if corePID <= 0 {
				conn.Close()
				return nil, errors.New("controller Core unavailable")
			}
			if err = verifier.VerifyControllerPeer(ctx, conn, corePID); err != nil {
				conn.Close()
				return nil, err
			}
			return conn, nil
		}
	} else {
		c.socket = filepath.Join(private, "c")
		if len(c.socket) > 103 {
			os.RemoveAll(private)
			return nil, errors.New("Private controller socket path is too long")
		}
		t.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", c.socket)
		}
	}
	c.transport = t
	c.gateway = &http.Server{Handler: http.HandlerFunc(c.forward), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 2 * time.Second}
	go func() { _ = c.gateway.Serve(c.listener) }()
	return c, nil
}
func (c *controller) coreConfig(cfg config) ([]byte, error) {
	out := config{}
	for k, v := range cfg {
		out[k] = v
	}
	delete(out, "external-controller")
	delete(out, "external-ui")
	delete(out, "secret")
	if c.socket != "" {
		out["external-controller-unix"] = c.socket
	} else {
		if out["log-level"] == "debug" {
			out["log-level"] = "info"
		}
		out["external-controller"] = c.address
		out["secret"] = c.secret
	}
	return yaml.Marshal(out)
}
func (c *controller) redact(s string) string {
	if c.secret != "" {
		return strings.ReplaceAll(s, c.secret, "[REDACTED]")
	}
	return s
}
func (c *controller) reload(ctx context.Context, cfg config) error {
	b, err := c.coreConfig(cfg)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"payload": string(b)})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, reloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "PUT", "http://localhost/configs", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.secret)
	}
	res, err := c.transport.RoundTrip(req)
	if err == nil {
		defer res.Body.Close()
		_, err = io.Copy(io.Discard, res.Body)
		if err == nil && (res.StatusCode < 200 || res.StatusCode >= 300) {
			err = fmt.Errorf("Privileged Core rejected configuration: HTTP %d", res.StatusCode)
		}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errReloadTimeout
	}
	return err
}
func (c *controller) accept(conn net.Conn) {
	t := &trackedConn{Conn: conn, done: make(chan struct{})}
	c.mu.Lock()
	if c.closed || len(c.conns) >= maxControllerConnections {
		c.mu.Unlock()
		conn.Close()
		return
	}
	c.conns[t] = struct{}{}
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.conns, t); c.mu.Unlock(); t.Close() }()
	select {
	case c.listener.incoming <- t:
	case <-c.listener.closed:
		return
	}
	select {
	case <-t.done:
	case <-c.listener.closed:
	}
}
func (c *controller) close() error {
	c.mu.Lock()
	c.closed = true
	for t := range c.conns {
		t.Close()
	}
	c.mu.Unlock()
	c.listener.Close()
	c.gateway.Close()
	c.transport.CloseIdleConnections()
	return os.RemoveAll(c.dir)
}
func (c *controller) forward(w http.ResponseWriter, r *http.Request) {
	route, ok := controllerTarget(r.Method, r.RequestURI)
	if !ok || route.action == restartAction || r.Method == "CONNECT" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	upgrade := r.Header.Get("Upgrade") != ""
	if upgrade && (r.Method != "GET" || route.action != proxyAction ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!websocketKey.MatchString(r.Header.Get("Sec-WebSocket-Key")) ||
		r.Header.Get("Sec-WebSocket-Version") != "13" || len(r.TransferEncoding) != 0 || r.ContentLength != 0) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var body []byte
	if !upgrade {
		storage := r.Method == "PUT" && strings.HasPrefix(route.path, "/storage/")
		limit := int64(4096)
		if storage {
			limit = 1 << 20
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
		if err != nil || int64(len(b)) > limit {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err = controllerBody(b, route.action, storage)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
	}
	target, err := url.ParseRequestURI(route.path)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	proxy := &httputil.ReverseProxy{
		Transport:    c.transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) },
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL = &url.URL{Scheme: "http", Host: "localhost", Path: target.Path, RawPath: target.RawPath, RawQuery: target.RawQuery}
			p.Out.Host = "localhost"
			p.Out.Header = make(http.Header)
			p.Out.TransferEncoding = nil
			p.Out.Trailer = nil
			p.Out.ContentLength = int64(len(body))
			p.Out.Body = http.NoBody
			if len(body) != 0 {
				p.Out.Body = io.NopCloser(bytes.NewReader(body))
				p.Out.Header.Set("Content-Type", "application/json")
			}
			if upgrade {
				p.Out.Header.Set("Connection", "Upgrade")
				p.Out.Header.Set("Upgrade", "websocket")
				for _, k := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"} {
					if v := r.Header.Get(k); v != "" {
						p.Out.Header.Set(k, v)
					}
				}
			}
			if c.secret != "" {
				p.Out.Header.Set("Authorization", "Bearer "+c.secret)
			}
		},
	}
	proxy.ServeHTTP(w, r)
}
