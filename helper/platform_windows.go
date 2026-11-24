//go:build windows && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

const (
	helperServiceName = "SashTunHelper"
	helperPipeName    = "sash-helper"
	helperExeName     = "sash-helper.exe"
	wintunDllName     = "wintun.dll"
	networkJournal    = "network-journal.json"
	// FILE_APPEND_DATA is FILE_CREATE_PIPE_INSTANCE on named pipes.
	helperPipeClientRights = (windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE) &^ windows.FILE_APPEND_DATA
	sidLocalSystem         = "S-1-5-18"
	sidAdministrators      = "S-1-5-32-544"
	sidTrustedInstallerPre = "S-1-5-80-"
)

func helperProtectedDir() (string, error) {
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return "", fmt.Errorf("could not resolve ProgramData folder: %w", err)
	}
	return filepath.Join(programData, "Sash", "core"), nil
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
	sweepControllerTempDirs(p.workDir)
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
	protected, err := helperProtectedDir()
	if err != nil {
		return nil, err
	}
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
		if inService, err := svc.IsWindowsService(); err != nil {
			return nil, err
		} else if inService {
			os.Exit(runAsService(p))
		}
		return p, nil
	default:
		return nil, fmt.Errorf("unknown command %q", args[0])
	}
	return nil, errors.New("unreachable")
}
