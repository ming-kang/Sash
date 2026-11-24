package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"go.yaml.in/yaml/v3"
)

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

type tailLog struct {
	mu sync.Mutex
	b  []byte
}

func (l *tailLog) Write(p []byte) (int, error) {
	const limit = 64000
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(p)
	if len(p) >= limit {
		l.b = append(l.b[:0], p[len(p)-limit:]...)
		return n, nil
	}
	if excess := len(l.b) + len(p) - limit; excess > 0 {
		l.b = l.b[:copy(l.b, l.b[excess:])]
	}
	l.b = append(l.b, p...)
	return n, nil
}
func (l *tailLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return string(l.b) }
func (l *tailLog) Reset()         { l.mu.Lock(); l.b = nil; l.mu.Unlock() }

type child struct {
	cmd    *exec.Cmd
	done   chan struct{}
	handle io.Closer
}

func (c *child) alive() bool {
	if c == nil {
		return false
	}
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

type helper struct {
	platform            Platform
	bin, work, expected string
	mu                  sync.Mutex
	owner               net.Conn
	core                *child
	corePID             atomic.Int64
	network             NetworkSession
	controller          *controller
	tun                 any
	digest              *string
	log                 tailLog
}

func within(a, b string) bool {
	rel, err := filepath.Rel(a, b)
	return err == nil && !filepath.IsAbs(rel) && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}
func (h *helper) verifyWork(ctx context.Context) error {
	if err := h.platform.VerifyProtectedPath(ctx, h.work); err != nil {
		return err
	}
	return canonicalDir(h.work)
}
func serve(ctx context.Context, p Platform, expected string) error {
	h := &helper{platform: p, bin: p.BinDir(), work: p.WorkDir(), expected: expected}
	if !filepath.IsAbs(h.bin) || !filepath.IsAbs(h.work) || within(h.bin, h.work) || within(h.work, h.bin) {
		return errors.New("Helper requires separate protected bin and work directories")
	}
	if err := h.verifyWork(ctx); err != nil {
		return err
	}
	var listener net.Listener
	if x, ok := p.(earlyListener); ok && x.ListenBeforeRecovery() {
		var err error
		listener, err = p.Listen(ctx)
		if err != nil {
			return err
		}
		defer listener.Close()
	}
	if err := p.RecoverNetwork(ctx); err != nil {
		return err
	}
	if listener == nil {
		var err error
		listener, err = p.Listen(ctx)
		if err != nil {
			return err
		}
		defer listener.Close()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var active sync.Map
	var connections sync.WaitGroup
	go func() { <-ctx.Done(); listener.Close() }()
	var acceptErr error
	for {
		c, err := listener.Accept()
		if err != nil {
			if ctx.Err() == nil {
				acceptErr = err
			}
			break
		}
		if !p.AuthorizePeer(c) {
			c.Close()
			continue
		}
		active.Store(c, struct{}{})
		connections.Go(func() {
			defer active.Delete(c)
			h.connection(ctx, c)
		})
	}
	cancel()
	active.Range(func(k, _ any) bool { k.(net.Conn).Close(); return true })
	connections.Wait()
	h.mu.Lock()
	stopErr := h.stop()
	h.mu.Unlock()
	return errors.Join(acceptErr, stopErr)
}
func (h *helper) connection(ctx context.Context, c net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer c.Close()
	defer cancel()
	b := bufio.NewReader(c)
	_ = c.SetReadDeadline(time.Now().Add(idleTimeout))
	first, err := b.Peek(1)
	if err != nil {
		return
	}
	if first[0] == controllerPreface {
		b.Discard(1)
		h.mu.Lock()
		gateway := h.controller
		live := h.core.alive()
		h.mu.Unlock()
		if gateway != nil && live {
			_ = c.SetReadDeadline(time.Time{})
			gateway.accept(bufferedConn{c, b})
		}
		return
	}
	var operation sync.WaitGroup
	var responseMu sync.Mutex
	busy := false
	defer func() {
		cancel()
		c.Close()
		operation.Wait()
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.owner == c {
			_ = h.stop()
		}
	}()
	for {
		line, err := readFrame(b)
		if err != nil {
			return
		}
		if !json.Valid(line) {
			return
		}
		responseMu.Lock()
		if busy {
			responseMu.Unlock()
			return
		}
		busy = true
		_ = c.SetReadDeadline(time.Time{})
		responseMu.Unlock()
		req, err := parseRequest(line)
		operation.Go(func() {
			var v any
			if err == nil {
				h.mu.Lock()
				if ctx.Err() == nil {
					v, err = h.dispatch(ctx, c, req)
				} else {
					err = ctx.Err()
				}
				h.mu.Unlock()
			}
			out := response{OK: err == nil, Value: v}
			if err != nil {
				out.Error = err.Error()
				if errors.Is(err, errReloadTimeout) {
					out.Code = "reload-timeout"
				}
			}
			responseMu.Lock()
			defer responseMu.Unlock()
			_ = c.SetDeadline(time.Now().Add(idleTimeout))
			if json.NewEncoder(c).Encode(out) != nil {
				c.Close()
			}
			busy = false
		})
	}
}
func (h *helper) dispatch(ctx context.Context, conn net.Conn, r request) (any, error) {
	switch r.Method {
	case "status":
		s := status{Digest: h.digest}
		if h.owner == conn && h.core.alive() {
			pid := h.core.cmd.Process.Pid
			s.PID = &pid
		}
		return s, nil
	case "logs":
		if h.owner == conn && h.controller != nil {
			return h.controller.redact(h.log.String()), nil
		}
		return "", nil
	case "stop":
		if h.owner != nil && h.owner != conn {
			return nil, errors.New("Core belongs to another helper session")
		}
		return nil, h.stop()
	case "start":
		return h.start(ctx, conn, []byte(r.Config))
	case "reload":
		if h.owner != conn || h.controller == nil || !h.core.alive() {
			return nil, errors.New("No privileged Core belongs to this helper session")
		}
		cfg, err := validateConfig([]byte(r.Config), h.work)
		if err != nil {
			return nil, err
		}
		if !reflect.DeepEqual(h.tun, cfg["tun"]) {
			return nil, errors.New("TUN settings changes require a supervised restart")
		}
		cfg, _, err = h.prepare(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err = h.controller.reload(ctx, cfg); err != nil {
			if errors.Is(err, errReloadTimeout) {
				return nil, errReloadTimeout
			}
			return nil, errors.New(h.controller.redact(err.Error()))
		}
		return nil, nil
	}
	return nil, errors.New("Invalid helper request")
}
func (h *helper) prepare(ctx context.Context, cfg config) (config, []byte, error) {
	b, err := yaml.Marshal(cfg)
	if err != nil {
		return nil, nil, err
	}
	exe := corePath(h.bin)
	if err = h.platform.ValidateConfig(ctx, exe, b, h.work); err != nil {
		return nil, nil, err
	}
	transformed, err := h.platform.PrepareConfig(ctx, b, h.work)
	if err != nil {
		return nil, nil, err
	}
	cfg, err = validateConfig(transformed, h.work)
	if err != nil {
		return nil, nil, err
	}
	b, err = yaml.Marshal(cfg)
	if err == nil {
		err = h.platform.ValidateConfig(ctx, exe, b, h.work)
	}
	return cfg, b, err
}
func (h *helper) start(ctx context.Context, conn net.Conn, b []byte) (answer any, retErr error) {
	if h.owner != nil || h.core != nil || h.network != nil {
		return nil, errors.New("Helper already owns a Core or pending cleanup")
	}
	if err := verifyCore(ctx, h.platform, h.bin, h.expected); err != nil {
		return nil, err
	}
	if err := h.verifyWork(ctx); err != nil {
		return nil, err
	}
	raw, err := validateConfig(b, h.work)
	if err != nil {
		return nil, err
	}
	cfg, prepared, err := h.prepare(ctx, raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	gateway, err := newController(h.platform, h.work, func() int { return int(h.corePID.Load()) })
	if err != nil {
		return nil, err
	}
	h.controller = gateway
	h.owner = conn
	defer func() {
		if retErr != nil {
			retErr = errors.New(gateway.redact(errors.Join(retErr, h.stop()).Error()))
		}
	}()
	private, err := gateway.coreConfig(cfg)
	if err != nil {
		return nil, err
	}
	h.network, err = h.platform.PrepareNetwork(ctx, prepared, h.work)
	if err != nil {
		return nil, err
	}
	if h.network == nil {
		return nil, errors.New("Platform did not return a network session")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.Command(corePath(h.bin), "-d", h.work, "-f", "-")
	cmd.Dir = h.work
	cmd.Env = coreEnvironment(os.Environ())
	h.log.Reset()
	cmd.Stdout = &h.log
	cmd.Stderr = &h.log
	procPlatform, platformTracks := h.platform.(coreProcessPlatform)
	if platformTracks {
		procPlatform.ConfigureCore(cmd)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		stdin.Close()
		return nil, err
	}
	core := &child{cmd: cmd, done: make(chan struct{})}
	h.core = core
	h.corePID.Store(int64(cmd.Process.Pid))
	go func() {
		_ = cmd.Wait()
		h.corePID.Store(0)
		close(core.done)
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.core == core {
			_ = h.clear()
		}
	}()
	if platformTracks {
		core.handle, err = procPlatform.TrackCore(ctx, cmd.Process.Pid)
		if err != nil {
			stdin.Close()
			return nil, err
		}
	}
	configured := make(chan error, 1)
	go func() {
		_, e := stdin.Write(private)
		if closeErr := stdin.Close(); e == nil {
			e = closeErr
		}
		configured <- e
	}()
	select {
	case err = <-configured:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	if err = h.network.RecordCoreStart(ctx, cmd.Process.Pid); err != nil {
		return nil, err
	}
	if !core.alive() {
		return nil, errors.New("Privileged Core exited during launch")
	}
	h.tun = raw["tun"]
	digest := h.expected
	h.digest = &digest
	pid := cmd.Process.Pid
	return status{PID: &pid, Digest: &digest}, nil
}
func (h *helper) clear() error {
	if h.controller != nil {
		_ = h.controller.close()
		h.controller = nil
	}
	h.tun = nil
	if h.core != nil && h.core.handle != nil {
		_ = h.core.handle.Close()
		h.core.handle = nil
	}
	if h.network != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := h.network.Cleanup(ctx); err != nil {
			return err
		}
		h.network = nil
	}
	h.owner = nil
	h.core = nil
	h.digest = nil
	return nil
}
func (h *helper) stop() error {
	if c := h.core; c.alive() {
		if runtime.GOOS == "windows" {
			_ = c.cmd.Process.Kill()
		} else {
			_ = c.cmd.Process.Signal(syscall.SIGTERM)
		}
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		select {
		case <-c.done:
			return h.clear()
		case <-timer.C:
		}
		_ = c.cmd.Process.Kill()
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		select {
		case <-c.done:
		case <-deadline.C:
			return errors.New("Helper could not stop Core")
		}
	}
	return h.clear()
}

func coreEnvironment(source []string) []string {
	var out []string
	for _, item := range source {
		key, _, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		k := strings.ToUpper(key)
		if strings.HasPrefix(k, "CLASH_") {
			continue
		}
		switch k {
		case "GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT", "GITHUB_ACCESS_TOKEN", "GH_PAT", "NPM_TOKEN", "NPM_AUTH_TOKEN", "NODE_AUTH_TOKEN", "NPM_ID_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL":
			continue
		}
		if strings.HasPrefix(k, "NPM_CONFIG_") && (strings.Contains(k, "AUTHTOKEN") || strings.Contains(k, "AUTH_TOKEN") || strings.HasSuffix(k, "_AUTH") || strings.Contains(k, "PASSWORD") || strings.Contains(k, "USERNAME") || k == "NPM_CONFIG_USERCONFIG" || k == "NPM_CONFIG_GLOBALCONFIG") {
			continue
		}
		out = append(out, item)
	}
	return out
}
