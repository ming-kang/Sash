//go:build !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"go.yaml.in/yaml/v3"
	"golang.org/x/sys/unix"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	linuxHelperBinDir   = "/usr/local/lib/sash"
	linuxHelperWorkDir  = "/var/lib/sash-helper"
	linuxHelperRuntime  = "/run/sash-helper"
	linuxHelperSocket   = linuxHelperRuntime + "/helper.sock"
	linuxJournalName    = "network-journal.json"
	linuxHelperUnitFile = "/etc/systemd/system/sash-helper.service"
)

type runFunc func(ctx context.Context, cmd string, args ...string) (string, error)

var errNoPeerCred = errors.New("peer credentials unavailable")

type linuxPlatform struct {
	binDir, workDir, socket string
	ownerUid                int
	hasOwner                bool
	run                     runFunc
	peerUid                 func(net.Conn) (uint32, error)
	procRoot                string
}

func newPlatform(args []string) (Platform, error) {
	p := &linuxPlatform{
		binDir:   linuxHelperBinDir,
		workDir:  linuxHelperWorkDir,
		socket:   linuxHelperSocket,
		run:      linuxRun,
		peerUid:  linuxPeerUid,
		procRoot: "/proc",
	}
	var cleanup, consent bool
	var consentSrc, consentSha, consentCore string
	for i := 0; i < len(args); i++ {
		key, value := args[i], func() string {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		switch key {
		case "--socket":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--socket requires an absolute path")
			}
			p.socket, i = value(), i+1
		case "--bin-dir":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--bin-dir requires an absolute path")
			}
			p.binDir, i = value(), i+1
		case "--work-dir":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--work-dir requires an absolute path")
			}
			p.workDir, i = value(), i+1
		case "--uid":
			uid, err := strconv.Atoi(value())
			if err != nil || uid < 0 || uid > 0xffffffff {
				return nil, errors.New("--uid requires a numeric user id")
			}
			p.ownerUid, p.hasOwner, i = uid, true, i+1
		case "--cleanup":
			cleanup = true
		case "--install-consent":
			if i+3 >= len(args) || !filepath.IsAbs(args[i+1]) ||
				!digestPattern.MatchString(args[i+2]) || !filepath.IsAbs(args[i+3]) {
				return nil, errors.New("--install-consent requires <helper-src> <helper-sha256> <core-src>")
			}
			consentSrc, consentSha, consentCore, consent, i = args[i+1], args[i+2], args[i+3], true, i+3
		default:
			return nil, fmt.Errorf("Unknown argument: %s", key)
		}
	}
	if os.Getuid() != 0 {
		return nil, errors.New("The TUN helper must run as root (systemd sash-helper.service)")
	}
	if cleanup {
		// ExecStopPost and `helper uninstall` run this in a fresh process;
		// the journal records exactly what the last launch created.
		if err := recoverLinuxTunSession(context.Background(), p.run,
			filepath.Join(p.workDir, linuxJournalName), filepath.Join(p.workDir, ".cleanup.lock")); err != nil {
			return nil, err
		}
		return nil, errDone
	}
	if consent {
		digest, err := p.installConsent(consentSrc, consentSha, consentCore)
		if err != nil {
			return nil, err
		}
		fmt.Printf("[sash-helper] installed consented pair %s\n", digest)
		return nil, errDone
	}
	_ = os.Remove(p.socket)
	return p, nil
}

func (p *linuxPlatform) BinDir() string  { return p.binDir }
func (p *linuxPlatform) WorkDir() string { return p.workDir }

func (p *linuxPlatform) Listen(context.Context) (net.Listener, error) {
	// Stale controller temp dirs from a crashed run are wiped before serving.
	sweepControllerTempDirs(p.workDir)
	// The socket must be 0600 before any peer can see it, so set the
	// umask around bind rather than chmod afterwards. The installing
	// user is granted access through a file ACL which only root can set.
	old := unix.Umask(0o077)
	l, err := net.Listen("unix", p.socket)
	unix.Umask(old)
	if err != nil {
		return nil, err
	}
	if p.hasOwner {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "setfacl", "-m",
			fmt.Sprintf("u:%d:rw", p.ownerUid), p.socket).CombinedOutput()
		if err != nil {
			// Without the ACL no user can reach the socket — shut down
			// cleanly instead of leaving a listener nobody may connect to.
			_ = l.Close()
			_ = os.Remove(p.socket)
			return nil, fmt.Errorf("could not grant the control socket to uid %d: %s",
				p.ownerUid, strings.TrimSpace(string(out)))
		}
	}
	fmt.Printf("[sash-helper] listening on %s (bin %s, work %s)\n", p.socket, p.binDir, p.workDir)
	return l, nil
}

func (p *linuxPlatform) AuthorizePeer(conn net.Conn) bool {
	// Kernel peer-UID (SO_PEERCRED) against the installer uid, fail-
	// closed: missing credentials or an unknown owner rejects. Root is
	// always allowed; the socket file ACL is the second gate.
	uid, err := p.peerUid(conn)
	if err != nil || !p.hasOwner {
		return false
	}
	return uid == uint32(p.ownerUid) || uid == 0
}

func linuxPeerUid(conn net.Conn) (uint32, error) {
	u, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, errNoPeerCred
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *unix.Ucred
	var inner error
	if err = raw.Control(func(fd uintptr) {
		cred, inner = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if inner != nil || cred == nil {
		return 0, errNoPeerCred
	}
	return cred.Uid, nil
}

func (p *linuxPlatform) VerifyProtectedPath(_ context.Context, file string) error {
	return linuxVerifyProtectedPath(file)
}

// Everything the helper runs or reads must live on a root-owned path:
// the file itself and its direct parent directory must be owned by uid
// 0, writable only by root, and free of symbolic links.
func linuxVerifyProtectedPath(file string) error {
	if !filepath.IsAbs(file) {
		return fmt.Errorf("expected an absolute protected path: %s", file)
	}
	normalized := filepath.Clean(file)
	real, err := filepath.EvalSymlinks(normalized)
	if err != nil || real != normalized {
		return fmt.Errorf("protected path must not contain symbolic links: %s", file)
	}
	var leaf unix.Stat_t
	if err := unix.Lstat(normalized, &leaf); err != nil {
		return err
	}
	if leaf.Mode&unix.S_IFMT == unix.S_IFLNK {
		return fmt.Errorf("protected path must not contain symbolic links: %s", file)
	}
	if leaf.Mode&0o022 != 0 {
		return fmt.Errorf("protected path must not be writable by others: %s", file)
	}
	if leaf.Mode&unix.S_IFMT != unix.S_IFDIR && leaf.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("protected path must be a regular file or directory: %s", file)
	}
	for _, current := range []string{normalized, filepath.Dir(normalized)} {
		var st unix.Stat_t
		if err := unix.Lstat(current, &st); err != nil {
			return err
		}
		if st.Uid != 0 {
			return fmt.Errorf("protected path must be owned by root: %s", current)
		}
		if st.Mode&0o022 != 0 {
			return fmt.Errorf("protected path must not be writable by others: %s", current)
		}
	}
	return nil
}

func linuxRun(ctx context.Context, cmd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, args...)
	c.Env = coreEnvironment(os.Environ())
	out, err := c.Output()
	if err != nil {
		stderr := ""
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		return "", fmt.Errorf("%s %s: %w %s %s", cmd, strings.Join(args, " "), err, out, stderr)
	}
	return string(out), nil
}

func (p *linuxPlatform) ValidateConfig(ctx context.Context, executable string, configText []byte, root string) error {
	var cfg map[string]any
	if err := yaml.Unmarshal(configText, &cfg); err != nil {
		return errors.New("invalid Core configuration")
	}
	tun, ok := cfg["tun"].(map[string]any)
	if !ok {
		return errors.New("invalid Core configuration")
	}
	if v, ok := tun["device"]; ok {
		if name, ok := v.(string); !ok || !linuxDeviceName.MatchString(name) {
			return errors.New("invalid TUN device name")
		}
	}
	if _, ok := tun["file-descriptor"]; ok {
		return errors.New("TUN file-descriptor passthrough is not supported by the helper")
	}
	// A real parse with the protected binary catches malformed fields the
	// whitelist cannot see; -t exits before touching the network.
	candidate := filepath.Join(root,
		fmt.Sprintf(".validate-%d-%d.yaml", os.Getpid(), time.Now().UnixMilli()))
	if err := os.WriteFile(candidate, configText, 0o600); err != nil {
		return err
	}
	defer os.Remove(candidate)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, executable, "-t", "-d", root, "-f", candidate).CombinedOutput()
	if err != nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) > 5 {
			lines = lines[len(lines)-5:]
		}
		detail := strings.Join(lines, " ")
		if len(detail) > 400 {
			detail = detail[:400]
		}
		if detail != "" {
			return fmt.Errorf("core rejected privileged configuration: %s", detail)
		}
		return errors.New("core rejected privileged configuration")
	}
	return nil
}

func (p *linuxPlatform) PrepareConfig(_ context.Context, configText []byte, _ string) ([]byte, error) {
	return configText, nil
}
