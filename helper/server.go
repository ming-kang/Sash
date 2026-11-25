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

type controller interface {
	start(startOptions) error
	stop() error
	unguard() error
	status() (bool, int)
	guardState() guardState
}

// open prepares the Core host, the kill switch engine and the control pipe.
// The pipe admits only LocalSystem, Administrators and the installing
// account; remote clients are always rejected.
func open(cfg config) (*guardedCore, net.Listener, error) {
	engine, engineErr := openWfpEngine()
	core, listener, err := openWithEngine(cfg, engine, engineErr)
	if err != nil && engine != nil {
		engine.close()
	}
	return core, listener, err
}

func openWithEngine(cfg config, engine filterEngine, engineErr error) (*guardedCore, net.Listener, error) {
	host, err := newCoreHost(cfg)
	if err != nil {
		return nil, nil, err
	}
	core := newGuardedCore(host, newTunGuard(engine, engineErr))
	sddl := fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;%s)", cfg.user)
	listener, err := winio.ListenPipe(cfg.pipe, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		core.close()
		return nil, nil, fmt.Errorf("listen on %s: %w", cfg.pipe, err)
	}
	return core, listener, nil
}

// convergeStartup removes kill switch objects a previous helper life left
// behind: no Core can be running when the service starts, so a leftover
// guard would only block the machine without protecting a Core.
func convergeStartup(core *guardedCore, logPath string) {
	if err := core.guard.uninstall(); err != nil {
		reportIssue(logPath, fmt.Errorf("startup kill switch cleanup: %w", err))
	}
}

func serve(listener net.Listener, core controller, home string) {
	for {
		conn, err := listener.Accept()
		if errors.Is(err, winio.ErrPipeListenerClosed) || errors.Is(err, net.ErrClosed) {
			return
		}
		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go handle(conn, core, home)
	}
}

// handle answers exactly one request line per connection.
func handle(conn net.Conn, core controller, home string) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(stopTimeout + 20*time.Second))
	line, err := bufio.NewReader(io.LimitReader(conn, 4096)).ReadBytes('\n')
	res := response{Error: "expected one request line"}
	if err == nil {
		res = dispatch(core, line)
	}
	res.Protocol = protocolVersion
	res.Home = home
	_ = json.NewEncoder(conn).Encode(res)
}

func dispatch(core controller, line []byte) response {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return response{Error: "invalid request"}
	}
	var err error
	switch req.Op {
	case "status":
	case "start":
		if req.Device != "" && !devicePattern.MatchString(req.Device) {
			return response{Error: fmt.Sprintf("invalid device name %q", req.Device)}
		}
		err = core.start(startOptions{guard: req.Guard, device: req.Device})
	case "stop":
		err = core.stop()
	case "unguard":
		err = core.unguard()
	default:
		return response{Error: fmt.Sprintf("unknown op %q", req.Op)}
	}
	running, pid := core.status()
	res := response{OK: err == nil, Running: running, PID: pid, Guard: core.guardState()}
	if err != nil {
		res.Error = err.Error()
	}
	return res
}
