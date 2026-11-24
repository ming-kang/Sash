//go:build windows && !helpercontract

// Windows platform: a single binary handling `install`, `uninstall`,
// `serve --installer-sid <sid>` (run by the SCM as LocalSystem) and
// `pipe-client` (the unprivileged stdio shim the daemon spawns). Subcommands
// other than `serve` run fully inside newPlatform and exit the process —
// shared main() never sees them. `serve` under the SCM runs the shared
// serve() inside svc.Run, so this file also exits the process once the
// service stops; a non-SCM `serve` returns the platform so main() serves
// directly (LocalSystem is verified either way).
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const (
	helperServiceName = "SashTunHelper"
	helperPipeName    = "sash-helper"
	helperExeName     = "sash-helper.exe"
	wintunDllName     = "wintun.dll"
	networkJournal    = "network-journal.json"
	// The DACL's client mask: FILE_READ_DATA|FILE_WRITE_DATA|SYNCHRONIZE
	// (0x12019b) — no FILE_CREATE_PIPE_INSTANCE, WRITE_DAC, WRITE_OWNER or
	// DELETE.
	helperPipeClientRights = 0x0012019b
	sidLocalSystem         = "S-1-5-18"
	sidAdministrators      = "S-1-5-32-544"
	sidTrustedInstallerPre = "S-1-5-80-"
)

func helperProtectedDir() string {
	return filepath.Join(os.Getenv("ProgramData"), "Sash", "core")
}

type windowsPlatform struct {
	protectedDir string
	binDir       string
	workDir      string
	installerSid string
	pipePath     string
}

func (p *windowsPlatform) BinDir() string  { return p.binDir }
func (p *windowsPlatform) WorkDir() string { return p.workDir }

// listenWindows takes effect BEFORE RecoverNetwork (earlyListener):
// go-winio queues pipe connections in the SCM-visible listener while the
// accept loop is held — a queued client waits instead of timing out, and a
// failed recovery exits before any connection is dispatched.
func (p *windowsPlatform) ListenBeforeRecovery() bool { return true }

func (p *windowsPlatform) Listen(ctx context.Context) (net.Listener, error) {
	// Stale controller temp dirs from a crashed run are wiped before serving.
	if entries, err := os.ReadDir(p.workDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), ".api-") {
				_ = os.RemoveAll(filepath.Join(p.workDir, entry.Name()))
			}
		}
	}
	return listenAclPipe(ctx, p.pipePath, p.installerSid)
}

// AuthorizePeer authenticates each accepted connection on the pipe:
// impersonate the client, compare its token SID to the installer's, then
// RevertToSelf on every path.
func (p *windowsPlatform) AuthorizePeer(conn net.Conn) bool {
	return clientIsInstaller(conn, p.installerSid)
}

// processIsLocalSystem proves the helper is running as LocalSystem — the
// `serve` contract requires it (the DACL binds pipe writes to the installer
// user and the Core runs privileged).
func processIsLocalSystem() (bool, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(), windows.TOKEN_QUERY, &token,
	); err != nil {
		return false, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return false, err
	}
	return user.User.Sid.String() == sidLocalSystem, nil
}

func newPlatform(args []string) (Platform, error) {
	protected := helperProtectedDir()
	p := &windowsPlatform{
		protectedDir: protected,
		binDir:       filepath.Join(protected, "bin"),
		workDir:      filepath.Join(protected, "work"),
		pipePath:     `\\.\pipe\` + helperPipeName,
	}
	if len(args) == 0 {
		return nil, errors.New("expected install|uninstall|serve|pipe-client")
	}
	switch args[0] {
	case "install":
		os.Exit(runInstall(p, args[1:]))
	case "uninstall":
		os.Exit(runUninstall(p, args[1:]))
	case "pipe-client":
		os.Exit(runPipeClient(p, args[1:]))
	case "serve":
		sid, err := parseFlag(args[1:], "--installer-sid")
		if err != nil {
			return nil, err
		}
		if !sidPattern.MatchString(sid) {
			return nil, fmt.Errorf("invalid --installer-sid %q", sid)
		}
		p.installerSid = sid
		system, err := processIsLocalSystem()
		if err != nil {
			return nil, fmt.Errorf("could not determine service account: %w", err)
		}
		if !system {
			return nil, errors.New("serve must run as LocalSystem")
		}
		if inService, err := isWindowsService(); err != nil {
			return nil, err
		} else if inService {
			// Serve under the SCM: svc.Run owns the process lifetime; the
			// shared serve loop runs inside and Stop unwinds it.
			os.Exit(runAsService(p))
		}
		return p, nil
	default:
		return nil, fmt.Errorf("unknown command %q", args[0])
	}
	return nil, errors.New("unreachable")
}
