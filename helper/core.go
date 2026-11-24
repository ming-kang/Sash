//go:build windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const stopTimeout = 10 * time.Second

// coreHost runs at most one Core. Every Core joins a kill-on-close job, so
// the Core can never outlive the service, even if the service crashes.
type coreHost struct {
	cfg config
	job windows.Handle

	op    sync.Mutex // serializes start and stop
	state sync.Mutex // guards cmd and done
	cmd   *exec.Cmd
	done  chan struct{}
}

func newCoreHost(cfg config) (*coreHost, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	return &coreHost{cfg: cfg, job: job}, nil
}

func (h *coreHost) status() (bool, int) {
	h.state.Lock()
	defer h.state.Unlock()
	if h.cmd == nil {
		return false, 0
	}
	return true, h.cmd.Process.Pid
}

func (h *coreHost) start() error {
	h.op.Lock()
	defer h.op.Unlock()
	if running, pid := h.status(); running {
		return fmt.Errorf("Core is already running (PID %d)", pid)
	}
	if info, err := os.Lstat(h.cfg.core); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("Core executable not found at %s", h.cfg.core)
	}
	stdout, err := openLog(h.cfg.stdout)
	if err != nil {
		return err
	}
	defer stdout.Close()
	stderr, err := openLog(h.cfg.stderr)
	if err != nil {
		return err
	}
	defer stderr.Close()

	cmd := exec.Command(h.cfg.core, "-d", h.cfg.home, "-f", h.cfg.configFile)
	cmd.Dir = h.cfg.home
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = coreEnvironment(os.Environ())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Core: %w", err)
	}
	if err := h.adopt(cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	done := make(chan struct{})
	h.state.Lock()
	h.cmd, h.done = cmd, done
	h.state.Unlock()
	go func() {
		_ = cmd.Wait()
		h.state.Lock()
		if h.cmd == cmd {
			h.cmd, h.done = nil, nil
		}
		h.state.Unlock()
		close(done)
	}()
	return nil
}

func (h *coreHost) adopt(pid int) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("open Core process: %w", err)
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(h.job, process); err != nil {
		return fmt.Errorf("assign Core to job: %w", err)
	}
	return nil
}

// stop terminates the Core. Windows has no signal the Core could handle;
// its TUN adapter and routes disappear with the process.
func (h *coreHost) stop() error {
	h.op.Lock()
	defer h.op.Unlock()
	h.state.Lock()
	cmd, done := h.cmd, h.done
	h.state.Unlock()
	if cmd == nil {
		return nil
	}
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("terminate Core: %w", err)
	}
	select {
	case <-done:
		return nil
	case <-time.After(stopTimeout):
		return errors.New("Core did not exit after termination")
	}
}

func (h *coreHost) close() {
	_ = windows.CloseHandle(h.job)
}

func openLog(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
}

// coreEnvironment keeps only what a Windows process needs to run; nothing
// from the service account (proxies, CLASH_* overrides) reaches the Core.
func coreEnvironment(environ []string) []string {
	keep := map[string]bool{
		"ALLUSERSPROFILE": true, "COMSPEC": true, "NUMBER_OF_PROCESSORS": true, "OS": true,
		"PATH": true, "PATHEXT": true, "PROCESSOR_ARCHITECTURE": true, "PROGRAMDATA": true,
		"PROGRAMFILES": true, "SYSTEMDRIVE": true, "SYSTEMROOT": true, "TEMP": true,
		"TMP": true, "WINDIR": true,
	}
	var kept []string
	for _, entry := range environ {
		name, _, found := strings.Cut(entry, "=")
		if found && name != "" && keep[strings.ToUpper(name)] {
			kept = append(kept, entry)
		}
	}
	return kept
}
