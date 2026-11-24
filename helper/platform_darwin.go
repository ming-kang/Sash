//go:build darwin && !helpercontract

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
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const sessionFile = ".tun-session.json"

// runCommand is the single command lane for the platform layer; tests swap
// it to replay command fixtures.
var runCommand = func(ctx context.Context, timeout time.Duration, tool string, argv ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, tool, argv...).CombinedOutput()
	return string(out), err
}

type darwinPlatform struct {
	bin, work, socket string
	ownerUID          int
}

// newPlatform implements the three entry modes of helper-entry-darwin.ts:
// --recover, --install-consent, and serve. Non-serve modes run eagerly and
// return errDone.
func newPlatform(args []string) (Platform, error) {
	pick := func(flag string) string {
		for i, a := range args {
			if a == flag && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	has := func(flag string) bool {
		for _, a := range args {
			if a == flag {
				return true
			}
		}
		return false
	}
	switch {
	case has("--recover"):
		workDir := pick("--work")
		if workDir == "" {
			return nil, errors.New("Usage: sash-helper --work <workDir> --recover")
		}
		if err := recoverTunSession(workDir); err != nil {
			return nil, err
		}
		fmt.Println("[sash-helper] recovered tun session state")
		return nil, errDone
	case has("--install-consent"):
		binDir, helperSource := pick("--bin"), pick("--helper-src")
		helperSha256, coreSource := pick("--helper-sha"), pick("--core-src")
		if binDir == "" || helperSource == "" || helperSha256 == "" || coreSource == "" {
			return nil, errors.New("Usage: sash-helper --bin <binDir> --install-consent --helper-src <f> --helper-sha <sha> --core-src <f>")
		}
		digest, err := installConsentedPair(
			binDir, helperSource, helperSha256, coreSource, verifyProtectedPath, durableRename,
		)
		if err != nil {
			return nil, err
		}
		fmt.Printf("[sash-helper] installed consented helper+core %s\n", digest)
		return nil, errDone
	}
	binDir, workDir, socketPath := pick("--bin"), pick("--work"), pick("--socket")
	ownerUID, convErr := strconv.Atoi(pick("--owner-uid"))
	if binDir == "" || workDir == "" || socketPath == "" || convErr != nil {
		return nil, errors.New("Usage: sash-helper --bin <binDir> --work <workDir> --socket <socketPath> --owner-uid <uid>")
	}
	if os.Geteuid() != 0 {
		return nil, errors.New("sash-helper must run as root (it is a LaunchDaemon)")
	}
	binDir, err := filepath.Abs(binDir)
	if err != nil {
		return nil, err
	}
	workDir, err = filepath.Abs(workDir)
	if err != nil {
		return nil, err
	}
	return &darwinPlatform{bin: binDir, work: workDir, socket: socketPath, ownerUID: ownerUID}, nil
}

func (p *darwinPlatform) BinDir() string  { return p.bin }
func (p *darwinPlatform) WorkDir() string { return p.work }

// Listen verifies the socket directory, normalizes ACLs BEFORE touching
// anything inside it, probes a stale socket only long enough to prove no
// live peer serves it, binds 0600, then grants the owner uid exactly write
// on the socket.
func (p *darwinPlatform) Listen(_ context.Context) (net.Listener, error) {
	// Stale controller temp dirs from a crashed run are wiped before serving.
	sweepControllerTempDirs(p.work)
	runDir := filepath.Dir(p.socket)
	if err := p.VerifyProtectedPath(context.Background(), runDir); err != nil {
		return nil, err
	}
	owner, err := ownerUserName(p.ownerUID)
	if err != nil {
		return nil, err
	}
	if err := aclStrip(runDir); err != nil {
		return nil, err
	}
	if err := aclGrant(runDir, owner, "search"); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(p.socket); err == nil {
		c, dialErr := net.DialTimeout("unix", p.socket, 2*time.Second)
		if dialErr == nil {
			c.Close()
			return nil, fmt.Errorf("helper socket %s is already served", p.socket)
		}
		if err := os.Remove(p.socket); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", p.socket)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(p.socket, 0o600); err != nil {
		listener.Close()
		return nil, fmt.Errorf("could not restrict helper socket: %w", err)
	}
	if err := aclGrant(p.socket, owner, "write"); err != nil {
		listener.Close()
		return nil, fmt.Errorf("could not restrict helper socket: %w", err)
	}
	return listener, nil
}

// AuthorizePeer is the kernel-verified peer credential check: LOCAL_PEERCRED
// (the same mechanism getpeereid(2) wraps) reports the uid that opened this
// accepted socket. Only the installing uid may speak IPC. Any missing or
// failed credential check fails closed; the fs ACL stays as defence in depth.
func (p *darwinPlatform) AuthorizePeer(conn net.Conn) bool {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false
	}
	var peerUID uint32 = ^uint32(0)
	ok = false
	_ = raw.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err == nil {
			peerUID = cred.Uid
			ok = true
		}
	})
	return ok && peerUID == uint32(p.ownerUID)
}

// VerifyProtectedPath enforces the fixed protected install paths: the file
// and its direct parent must be root-owned, not symlinks, and not writable
// by group or others.
func (p *darwinPlatform) VerifyProtectedPath(_ context.Context, file string) error {
	return verifyProtectedPath(file)
}

// verifyProtectedPath is a var so tests can stub the root-ownership check.
var verifyProtectedPath = func(file string) error {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return err
	}
	dir := filepath.Dir(absolute)
	dirStat, err := os.Lstat(dir)
	if err != nil || !dirStat.IsDir() || dirStat.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to use %s: parent %s is not a real directory", file, dir)
	}
	if st, ok := dirStat.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 || dirStat.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("refusing to use %s: parent %s must be root-owned and not writable by group or others", file, dir)
	}
	leaf, err := os.Lstat(absolute)
	if err != nil {
		return err
	}
	if leaf.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to use %s: must not be a symlink", file)
	}
	stat, err := os.Stat(absolute)
	if err != nil {
		return err
	}
	if st, ok := stat.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 || stat.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("refusing to use %s: must be root-owned and not writable by group or others", file)
	}
	return nil
}

// ValidateConfig writes the candidate config to a probe file inside the
// protected work directory and asks the paired Core to validate it.
func (p *darwinPlatform) ValidateConfig(ctx context.Context, executable string, config []byte, root string) error {
	probe := filepath.Join(root, fmt.Sprintf(".validate-%d-%d.yaml", os.Getpid(), time.Now().UnixMilli()))
	if err := writeFileAtomic(probe, config, 0o600); err != nil {
		return err
	}
	defer os.Remove(probe)
	out, err := runCommand(ctx, 15*time.Second, executable, "-t", "-d", root, "-f", probe)
	if err != nil {
		return fmt.Errorf("Core config validation failed: %s %w", out, err)
	}
	return nil
}

// PrepareConfig injects the session-scoped `dns-mode: native` (the Core
// registers DNS with configd for the duration of the tunnel instead of
// rewriting persistent service DNS) unless the profile already pins the
// field. Only values the paired sing-tun understands may pass.
func (p *darwinPlatform) PrepareConfig(_ context.Context, configText []byte, _ string) ([]byte, error) {
	return prepareMacosConfig(configText)
}

func (p *darwinPlatform) RecoverNetwork(_ context.Context) error {
	return recoverTunSession(p.work)
}

func (p *darwinPlatform) PrepareNetwork(_ context.Context, _ []byte, workDir string) (NetworkSession, error) {
	return prepareMacosNetwork(workDir)
}

func ownerUserName(uid int) (string, error) {
	out, err := runCommand(context.Background(), 10*time.Second, "/usr/bin/id", "-un", strconv.Itoa(uid))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// aclGrant gives the owning uid exactly what it needs on a file/dir.
func aclGrant(target, user, rights string) error {
	_, err := runCommand(context.Background(), 10*time.Second, "/bin/chmod", "+a", fmt.Sprintf("user:%s allow %s", user, rights), target)
	return err
}

// aclStrip removes every ACL so a stale grant can never widen the directory.
func aclStrip(target string) error {
	_, err := runCommand(context.Background(), 10*time.Second, "/bin/chmod", "-N", target)
	return err
}
