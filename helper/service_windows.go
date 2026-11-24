//go:build windows && !helpercontract

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func parseFlag(args []string, name string) (string, error) {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1], nil
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"="), nil
		}
	}
	return "", fmt.Errorf("missing required flag %s", name)
}

func runAsService(p *windowsPlatform) int {
	// SCM does not capture a service's stderr; mirror it to a file under the
	// protected work dir so crash-recovery logging survives reboots.
	if logFile, err := os.OpenFile(
		filepath.Join(p.workDir, "sash-helper.err.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600,
	); err == nil {
		defer logFile.Close()
		os.Stderr = logFile
	}
	err := svc.Run(helperServiceName, &serviceHandler{platform: p})
	if err != nil {
		fmt.Fprintf(os.Stderr, "service failed: %v\n", err)
		return 1
	}
	return 0
}

type serviceHandler struct {
	platform *windowsPlatform
}

func (h *serviceHandler) Execute(
	_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status,
) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, h.platform, coreSHA256)
	}()
	status <- svc.Status{State: svc.StartPending}
	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}
	for {
		select {
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				if err := <-done; err != nil {
					return false, 1
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				return false, 1
			}
			return false, 0
		}
	}
}

func isElevated() (bool, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(), windows.TOKEN_QUERY, &token,
	); err != nil {
		return false, err
	}
	defer token.Close()
	return token.IsElevated(), nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func installVerifiedBinary(src, dst, expectedSHA string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	actual, err := sha256File(dst)
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, expectedSHA) {
		return fmt.Errorf("installed %s digest mismatch: %s != %s", dst, actual, expectedSHA)
	}
	return nil
}

// Elevation alone does not make Administrators the owner of newly created files.
func aclProtectedDir(dir, installerSid string) error {
	if out, err := exec.Command("icacls.exe", dir,
		"/setowner", "*S-1-5-32-544",
	).CombinedOutput(); err != nil {
		return fmt.Errorf("icacls /setowner %s failed: %w: %s", dir, err, out)
	}
	out, err := exec.Command("icacls.exe", dir,
		"/inheritance:r", "/grant:r",
		"*S-1-5-18:(OI)(CI)(F)", "*S-1-5-32-544:(OI)(CI)(F)",
		fmt.Sprintf("*%s:(OI)(CI)(RX)", installerSid),
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s failed: %w: %s", dir, err, out)
	}
	return nil
}

// helperManifest is the install-time pairing record the daemon's inspect
// reads: needsReconsent is derived from these digests.
type helperManifest struct {
	Version       int    `json:"version"`
	InstallerSid  string `json:"installerSid"`
	CoreSha256    string `json:"coreSha256"`
	HelperSha256  string `json:"helperSha256"`
	HelperVersion string `json:"helperVersion"`
	WintunSha256  string `json:"wintunSha256"`
	CoreVersion   string `json:"coreVersion"`
	InstalledAt   string `json:"installedAt"`
}

func runInstall(p *windowsPlatform, args []string) int {
	if err := doInstall(p, args); err != nil {
		writeResult(args, err)
		fmt.Fprintf(os.Stderr, "install failed: %v\n", err)
		return 1
	}
	writeResult(args, nil)
	return 0
}

func writeResult(args []string, installErr error) {
	resultPath, err := parseFlag(args, "--result")
	if err != nil {
		return
	}
	result := map[string]any{"ok": installErr == nil}
	if installErr != nil {
		result["error"] = installErr.Error()
	}
	data, _ := json.Marshal(result)
	_ = os.WriteFile(resultPath, data, 0o644)
}

func doInstall(p *windowsPlatform, args []string) error {
	elevated, err := isElevated()
	if err != nil {
		return err
	}
	if !elevated {
		return errors.New("install requires elevation")
	}
	installerSid, err := parseFlag(args, "--installer-sid")
	if err != nil {
		return err
	}
	if !sidPattern.MatchString(installerSid) {
		return fmt.Errorf("invalid --installer-sid %q", installerSid)
	}
	coreSrc, err := parseFlag(args, "--core")
	if err != nil {
		return err
	}
	coreVersion, _ := parseFlag(args, "--core-version")
	helperSrc, err := parseFlag(args, "--helper-exe")
	if err != nil {
		return err
	}
	helperSHA, err := parseFlag(args, "--helper-sha256")
	if err != nil {
		return err
	}
	wintunSrc, err := parseFlag(args, "--wintun")
	if err != nil {
		return err
	}
	wintunSHA, err := sha256File(wintunSrc)
	if err != nil {
		return fmt.Errorf("could not hash wintun payload: %w", err)
	}
	coreSHA, err := sha256File(coreSrc)
	if err != nil {
		return fmt.Errorf("could not hash core payload: %w", err)
	}
	if !digestPattern.MatchString(coreSHA256) {
		return errors.New("no paired Core digest embedded in this helper build")
	}
	if !strings.EqualFold(coreSHA, coreSHA256) {
		return fmt.Errorf(
			"packaged Core digest mismatch: %s is not the paired Core %s",
			coreSHA, coreSHA256,
		)
	}

	// Pre-create gate: any existing component on the protected path must
	// not be a link/reparse point.
	for _, dir := range []string{
		filepath.Dir(p.protectedDir), p.protectedDir, p.binDir, p.workDir,
	} {
		if err := verifyPreCreatePath(dir); err != nil {
			return err
		}
	}

	if err := removeService(); err != nil {
		return err
	}

	for _, dir := range []string{p.protectedDir, p.binDir, p.workDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	// ACL the parent Sash dir and the protected tree (bin/work keep their
	// inherited DACL but need the Administrators owner too).
	if filepath.Base(filepath.Dir(p.protectedDir)) == "Sash" {
		if err := aclProtectedDir(filepath.Dir(p.protectedDir), installerSid); err != nil {
			return err
		}
	}
	for _, dir := range []string{p.protectedDir, p.binDir, p.workDir} {
		if err := aclProtectedDir(dir, installerSid); err != nil {
			return err
		}
	}
	// Re-audit after creation/ACL: a silently failed icacls must never let
	// a binary land somewhere weak.
	for _, dir := range []string{p.protectedDir, p.binDir, p.workDir} {
		if err := p.VerifyProtectedPath(context.Background(), dir); err != nil {
			return fmt.Errorf("post-ACL audit of %s failed: %w", dir, err)
		}
	}

	if err := p.RecoverNetwork(context.Background()); err != nil {
		return fmt.Errorf("cannot reinstall with an unrecovered network journal: %w", err)
	}

	// SCM may report stopped before the old process releases its image.
	publish := func(src, dst, expectedSHA string) error {
		var lastErr error
		for attempt := 0; attempt < 5; attempt++ {
			if err := installVerifiedBinary(src, dst, expectedSHA); err == nil {
				return nil
			} else {
				lastErr = err
			}
			time.Sleep(1 * time.Second)
		}
		return lastErr
	}
	if err := publish(coreSrc, filepath.Join(p.binDir, "mihomo.exe"), coreSHA); err != nil {
		return err
	}
	if err := publish(helperSrc, filepath.Join(p.binDir, helperExeName), helperSHA); err != nil {
		return err
	}
	if err := publish(wintunSrc, filepath.Join(p.binDir, wintunDllName), wintunSHA); err != nil {
		return err
	}
	// The binaries' owner is the installer user; make it Administrators so
	// the serve-time audit accepts them.
	for _, name := range []string{"mihomo.exe", helperExeName, wintunDllName} {
		if out, err := exec.Command("icacls.exe",
			filepath.Join(p.binDir, name), "/setowner", "*S-1-5-32-544",
		).CombinedOutput(); err != nil {
			return fmt.Errorf("icacls /setowner %s failed: %w: %s", name, err, out)
		}
	}

	manifest := helperManifest{
		Version:       1,
		InstallerSid:  installerSid,
		CoreSha256:    coreSHA,
		HelperSha256:  helperSHA,
		HelperVersion: buildVersion,
		WintunSha256:  wintunSHA,
		CoreVersion:   coreVersion,
		InstalledAt:   time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := os.WriteFile(
		filepath.Join(p.protectedDir, "helper-manifest.json"), data, 0o644,
	); err != nil {
		return err
	}

	return installService(p, installerSid)
}

func installService(p *windowsPlatform, installerSid string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("SCM connect failed: %w", err)
	}
	defer m.Disconnect()
	exePath := filepath.Join(p.binDir, helperExeName)
	s, err := m.CreateService(
		helperServiceName, exePath,
		mgr.Config{
			DisplayName:      "Sash TUN Helper",
			StartType:        mgr.StartAutomatic,
			DelayedAutoStart: true,
			ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		},
		"serve", "--installer-sid", installerSid,
	)
	if err != nil {
		return fmt.Errorf("CreateService failed: %w", err)
	}
	defer s.Close()
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
	}, 0); err != nil {
		return fmt.Errorf("SetRecoveryActions failed: %w", err)
	}
	return s.Start()
}

func removeService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(helperServiceName)
	switch {
	case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
		return nil
	case errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE):
	case err != nil:
		return err
	default:
		err := stopService(s)
		if err == nil {
			err = s.Delete()
		}
		// Deletion is deferred until the last SCM handle is closed.
		s.Close()
		if err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return err
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		s, err := m.OpenService(helperServiceName)
		switch {
		case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
			return nil
		case errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE):
		case err != nil:
			return err
		default:
			s.Close()
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("%s registration was not removed", helperServiceName)
}

func stopService(s *mgr.Service) error {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err != nil {
			return err
		}
		switch status.State {
		case svc.Stopped:
			return nil
		case svc.StartPending, svc.StopPending:
		default:
			if _, err := s.Control(svc.Stop); err != nil &&
				!errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) &&
				!errors.Is(err, windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
				return fmt.Errorf("could not stop %s: %w", helperServiceName, err)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("%s did not stop within 20s", helperServiceName)
}

func runUninstall(p *windowsPlatform, args []string) int {
	if err := doUninstall(p); err != nil {
		writeResult(args, err)
		fmt.Fprintf(os.Stderr, "uninstall failed: %v\n", err)
		return 1
	}
	writeResult(args, nil)
	return 0
}

func doUninstall(p *windowsPlatform) error {
	elevated, err := isElevated()
	if err != nil {
		return err
	}
	if !elevated {
		return errors.New("uninstall requires elevation")
	}
	if err := removeService(); err != nil {
		return err
	}
	if err := p.RecoverNetwork(context.Background()); err != nil {
		return fmt.Errorf("cannot uninstall with an unrecovered network journal: %w", err)
	}
	// A running image cannot delete itself: when the protected copy is doing
	// the uninstall, hand the removal to a detached helper that runs after
	// this process exits. Renaming out of bin first keeps the dir empty.
	self, _ := os.Executable()
	if selfAbs, err1 := filepath.Abs(self); err1 == nil {
		if targetAbs, err2 := filepath.Abs(
			filepath.Join(p.binDir, helperExeName),
		); err2 == nil && strings.EqualFold(selfAbs, targetAbs) {
			parked := p.protectedDir + "-removing"
			_ = os.RemoveAll(parked)
			if err := os.Rename(p.protectedDir, parked); err != nil {
				return fmt.Errorf("could not remove protected dir: %w", err)
			}
			defer removeDirIfEmpty(filepath.Dir(p.protectedDir))
			return scheduleDirRemoval(parked)
		}
	}
	var lastErr error
	for attempt := 0; attempt < 6; attempt++ {
		if err := os.RemoveAll(p.protectedDir); err == nil {
			removeDirIfEmpty(filepath.Dir(p.protectedDir))
			return nil
		} else {
			lastErr = err
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("could not remove protected dir: %w", lastErr)
}

// removeDirIfEmpty reaps the now-empty parent of the protected tree
// (ProgramData\Sash); a foreign file left behind keeps it, which is fine.
func removeDirIfEmpty(dir string) {
	_ = os.Remove(dir)
}

// scheduleDirRemoval spawns a detached cmd that waits for this process to
// exit, then removes the directory tree. Exit code reporting is best-effort:
// the daemon sees uninstall succeed once the tree is handed off.
func scheduleDirRemoval(dir string) error {
	pid := os.Getpid()
	script := fmt.Sprintf(
		`:w tasklist /FI "PID eq %d" | find "%d" >nul && (ping -n 2 127.0.0.1 >nul & goto w) || rmdir /s /q "%s"`,
		pid, pid, dir,
	)
	cmd := exec.Command("cmd.exe", "/C", script)
	cmd.SysProcAttr = &windows.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not schedule protected dir removal: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

// runPipeClient is the unprivileged stdio shim the daemon spawns: it opens
// the ACL'd front pipe as the calling user and bridges stdio.
func runPipeClient(p *windowsPlatform, args []string) int {
	pipePath, err := parseFlag(args, "--pipe")
	if err != nil {
		pipePath = p.pipePath
	}
	conn, err := connectAclPipe(
		context.Background(), pipePath, filepath.Join(p.binDir, helperExeName),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pipe-client: %v\n", err)
		return 1
	}
	bridgePipe(conn, os.Stdin, os.Stdout)
	return 0
}

func bridgePipe(conn net.Conn, input io.Reader, output io.Writer) {
	defer conn.Close()
	go io.Copy(conn, input)
	_, _ = io.Copy(output, conn)
}
