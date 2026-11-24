//go:build windows && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ownsControllerConnection scans a `netstat -ano -p tcp` table for the
// exact established loopback connection (server port, client port) owned by
// pid — the proof the privileged Core holds the controller socket.
func ownsControllerConnection(table string, port, clientPort, pid int) bool {
	local := fmt.Sprintf("127.0.0.1:%d", port)
	remote := fmt.Sprintf("127.0.0.1:%d", clientPort)
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		if fields[0] == "TCP" &&
			fields[1] == local &&
			fields[2] == remote &&
			fields[3] == "ESTABLISHED" &&
			fields[4] == strconv.Itoa(pid) {
			return true
		}
	}
	return false
}

// VerifyControllerPeer proves the client on this exact socket is the
// expected Core process: netstat's PID column on the established
// server-side row must be the Core's PID.
func (p *windowsPlatform) VerifyControllerPeer(ctx context.Context, conn net.Conn, corePID int) error {
	if corePID <= 0 {
		return errors.New("privileged Core connection ownership is unavailable")
	}
	local, lok := conn.LocalAddr().(*net.TCPAddr)
	remote, rok := conn.RemoteAddr().(*net.TCPAddr)
	if !lok || !rok {
		return errors.New("controller connection is not TCP")
	}
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" || !filepath.IsAbs(systemRoot) {
		return errors.New("privileged Core connection ownership is unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(
		ctx, filepath.Join(systemRoot, "System32", "netstat.exe"),
		"-ano", "-p", "tcp",
	).Output()
	if err != nil {
		return fmt.Errorf("could not verify privileged Core controller connection: %w", err)
	}
	if !ownsControllerConnection(string(out), remote.Port, local.Port, corePID) {
		return errors.New("privileged Core did not own the controller connection")
	}
	return nil
}
