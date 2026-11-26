//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"time"

	"github.com/Microsoft/go-winio"
)

// protocolVersion changes only when the request or response shape does;
// Sash reinstalls a helper that reports another version. Version 2 adds the
// guard fields and unguard: version-1 helpers serve start/stop/status without
// the kill switch, which Sash treats as a degraded rather than broken service.
const protocolVersion = 2

var devicePattern = regexp.MustCompile(`^[\w.-]{1,64}$`)

type request struct {
	Op     string `json:"op"`
	Guard  bool   `json:"guard,omitempty"`
	Device string `json:"device,omitempty"`
}

type response struct {
	OK       bool       `json:"ok"`
	Protocol int        `json:"protocol"`
	Home     string     `json:"home"`
	Running  bool       `json:"running"`
	PID      int        `json:"pid,omitempty"`
	Guard    guardState `json:"guard"`
	Error    string     `json:"error,omitempty"`
}

type operationKind int

const (
	opStatus operationKind = iota
	opStart
	opStop
	opUnguard
)

type operation struct {
	kind  operationKind
	start startOptions
}

type operationResult struct {
	err error
}

type statusSnapshot struct {
	running bool
	pid     int
	guard   guardState
}

type controller interface {
	apply(operation) operationResult
	snapshot() statusSnapshot
}

type helper struct {
	cfg      config
	core     *guardedCore
	listener net.Listener
}

// openHelper prepares the Core host, the kill switch engine and the control
// pipe for one helper lifetime. The pipe admits only LocalSystem,
// Administrators and the installing account; remote clients are always
// rejected.
func openHelper(cfg config) (*helper, error) {
	engine, engineErr := openWfpEngine()
	h, err := openHelperWithEngine(cfg, engine, engineErr)
	if err != nil && engine != nil {
		engine.close()
	}
	return h, err
}

func openHelperWithEngine(cfg config, engine filterEngine, engineErr error) (*helper, error) {
	host, err := newCoreHost(cfg)
	if err != nil {
		return nil, err
	}
	core := newGuardedCore(host, newTunGuard(engine, engineErr))
	if err := core.convergeStaleGuard(); err != nil {
		reportIssue(cfg.stderr, fmt.Errorf("startup kill switch cleanup: %w", err))
	}
	listener, err := listenHelper(cfg)
	if err != nil {
		core.close()
		return nil, err
	}
	return &helper{cfg: cfg, core: core, listener: listener}, nil
}

func listenHelper(cfg config) (net.Listener, error) {
	sddl := fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;%s)", cfg.user)
	listener, err := winio.ListenPipe(cfg.pipe, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", cfg.pipe, err)
	}
	return listener, nil
}

func (h *helper) serve() {
	for {
		conn, err := h.listener.Accept()
		if errors.Is(err, winio.ErrPipeListenerClosed) || errors.Is(err, net.ErrClosed) {
			return
		}
		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go h.handle(conn)
	}
}

// handle answers exactly one request line per connection.
func (h *helper) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(stopTimeout + 20*time.Second))
	line, err := bufio.NewReader(io.LimitReader(conn, 4096)).ReadBytes('\n')
	res := response{Error: "expected one request line"}
	if err == nil {
		res = dispatch(h.core, line)
	}
	res.Protocol = protocolVersion
	res.Home = h.cfg.home
	_ = json.NewEncoder(conn).Encode(res)
}

func (h *helper) shutdown() error {
	_ = h.listener.Close()
	return h.core.shutdown()
}

func (h *helper) close() {
	_ = h.listener.Close()
	h.core.close()
}

func parseOperation(line []byte) (operation, error) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return operation{}, errors.New("invalid request")
	}
	switch req.Op {
	case "status":
		return operation{kind: opStatus}, nil
	case "start":
		if req.Device != "" && !devicePattern.MatchString(req.Device) {
			return operation{}, fmt.Errorf("invalid device name %q", req.Device)
		}
		return operation{kind: opStart, start: startOptions{guard: req.Guard, device: req.Device}}, nil
	case "stop":
		return operation{kind: opStop}, nil
	case "unguard":
		return operation{kind: opUnguard}, nil
	default:
		return operation{}, fmt.Errorf("unknown op %q", req.Op)
	}
}

func dispatch(core controller, line []byte) response {
	op, err := parseOperation(line)
	if err != nil {
		return response{Error: err.Error()}
	}
	result := core.apply(op)
	return result.withState(core.snapshot())
}

func (r operationResult) withState(state statusSnapshot) response {
	res := response{
		OK:      r.err == nil,
		Running: state.running,
		PID:     state.pid,
		Guard:   state.guard,
	}
	if r.err != nil {
		res.Error = r.err.Error()
	}
	return res
}
