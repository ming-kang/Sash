//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// protocolVersion changes only when the request or response shape does;
// Sash reinstalls a helper that reports another version.
const protocolVersion = 1

type request struct {
	Op string `json:"op"`
}

type response struct {
	OK       bool   `json:"ok"`
	Protocol int    `json:"protocol"`
	Home     string `json:"home"`
	Running  bool   `json:"running"`
	PID      int    `json:"pid,omitempty"`
	Error    string `json:"error,omitempty"`
}

type controller interface {
	start() error
	stop() error
	status() (bool, int)
}

// open prepares the Core host and the control pipe. The pipe admits only
// LocalSystem, Administrators and the installing account; remote clients are
// always rejected.
func open(cfg config) (*coreHost, net.Listener, error) {
	host, err := newCoreHost(cfg)
	if err != nil {
		return nil, nil, err
	}
	sddl := fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;%s)", cfg.user)
	listener, err := winio.ListenPipe(cfg.pipe, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		host.close()
		return nil, nil, fmt.Errorf("listen on %s: %w", cfg.pipe, err)
	}
	return host, listener, nil
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
		err = core.start()
	case "stop":
		err = core.stop()
	default:
		return response{Error: fmt.Sprintf("unknown op %q", req.Op)}
	}
	running, pid := core.status()
	res := response{OK: err == nil, Running: running, PID: pid}
	if err != nil {
		res.Error = err.Error()
	}
	return res
}
