//go:build windows && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x2000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
	processQueryInformation           = 0x0400
	processQueryLimitedInformation    = 0x1000
	processSynchronize                = 0x00100000
	filetimeEpochOffset100ns          = 116444736000000000
)

var (
	kernel32                   = windows.NewLazySystemDLL("kernel32.dll")
	procCreateJobObjectW       = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob     = kernel32.NewProc("AssignProcessToJobObject")
	procGetProcessTimes        = kernel32.NewProc("GetProcessTimes")
)

// assignCoreToKillJob binds pid to a kill-on-close Job: a dead helper never
// leaves a privileged, network-manipulating Core behind. The caller owns the
// returned handle for the Core's whole lifetime.
func assignCoreToKillJob(pid int) (windows.Handle, error) {
	job, _, err := procCreateJobObjectW.Call(0, 0)
	if job == 0 {
		return 0, fmt.Errorf("CreateJobObjectW failed: %v", err)
	}
	ok := false
	defer func() {
		if !ok {
			windows.CloseHandle(windows.Handle(job))
		}
	}()
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64): BasicLimitInformation
	// (64B, LimitFlags at offset 16) + IO_COUNTERS (48B) + 4 SIZE_T (32B) = 144B.
	info := make([]byte, 144)
	*(*uint32)(unsafe.Pointer(&info[16])) = jobObjectLimitKillOnJobClose
	r1, _, err := procSetInformationJobObject.Call(
		job, jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)),
	)
	if r1 == 0 {
		return 0, fmt.Errorf("SetInformationJobObject failed: %v", err)
	}
	access := uint32(processSetQuota | processTerminate | processQueryInformation)
	proc, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return 0, fmt.Errorf("OpenProcess(%d) failed: %v", pid, err)
	}
	r1, _, err = procAssignProcessToJob.Call(job, uintptr(proc))
	windows.CloseHandle(proc)
	if r1 == 0 {
		return 0, fmt.Errorf("AssignProcessToJobObject(%d) failed: %v", pid, err)
	}
	ok = true
	return windows.Handle(job), nil
}

// stableProcess is a process bound to a live kernel handle: identity queries
// and termination act on the same process instance even if the PID is later
// recycled.
type stableProcess struct {
	handle windows.Handle
}

// openProcessHandle returns nil when the kernel proves the process is gone
// (ERROR_INVALID_PARAMETER); any other failure is an error — a failed query
// is never read as "not running".
func openProcessHandle(pid int) (*stableProcess, error) {
	access := uint32(processTerminate | processQueryLimitedInformation | processSynchronize)
	h, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil, nil
		}
		return nil, fmt.Errorf("OpenProcess(%d) failed: %v", pid, err)
	}
	return &stableProcess{handle: h}, nil
}

func (s *stableProcess) close() { _ = windows.CloseHandle(s.handle) }

// imagePath reads the executable path off the handle (stable across PID reuse).
func (s *stableProcess) imagePath() (string, error) {
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(s.handle, 0, &buf[0], &n); err != nil {
		return "", err
	}
	if n == 0 {
		return "", errors.New("empty image path")
	}
	return windows.UTF16ToString(buf[:n]), nil
}

// createdAt is the process creation FILETIME in epoch milliseconds.
func (s *stableProcess) createdAt() (int64, error) {
	var created, exited, kern, user windows.Filetime
	r1, _, err := procGetProcessTimes.Call(
		uintptr(s.handle),
		uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)),
		uintptr(unsafe.Pointer(&kern)), uintptr(unsafe.Pointer(&user)),
	)
	if r1 == 0 {
		return 0, fmt.Errorf("GetProcessTimes failed: %v", err)
	}
	raw := (uint64(created.HighDateTime) << 32) | uint64(created.LowDateTime)
	return int64((raw - filetimeEpochOffset100ns) / 10000), nil
}

// waitExit blocks until the process exits or timeout expires.
func (s *stableProcess) waitExit(timeout time.Duration) bool {
	ms := uint32(timeout / time.Millisecond)
	event, err := windows.WaitForSingleObject(s.handle, ms)
	return err == nil && event == windows.WAIT_OBJECT_0
}

// terminate kills via the already-verified handle, then waits for the exit.
func (s *stableProcess) terminate(timeout time.Duration) bool {
	if err := windows.TerminateProcess(s.handle, 1); err != nil {
		return s.waitExit(0)
	}
	return s.waitExit(timeout)
}

// processIdentity is the live identity (image + creation FILETIME) read off
// one stable handle; nil means the process is provably gone.
func processIdentity(pid int) (image string, createdAt int64, alive bool, err error) {
	proc, err := openProcessHandle(pid)
	if err != nil {
		return "", 0, false, err
	}
	if proc == nil {
		return "", 0, false, nil
	}
	defer proc.close()
	if image, err = proc.imagePath(); err != nil {
		return "", 0, false, fmt.Errorf("could not read identity of process %d", pid)
	}
	if createdAt, err = proc.createdAt(); err != nil {
		return "", 0, false, fmt.Errorf("could not read identity of process %d", pid)
	}
	return image, createdAt, true, nil
}

// killOwnedProcesses terminates every live process whose image lives under
// dir (used by uninstall: the protected tree is removed afterwards).
// Best-effort like the TS version — a process that cannot be opened or
// identified is skipped, not fatal.
func killOwnedProcesses(dir string) {
	prefix := strings.ToLower(strings.ReplaceAll(dir, `\`, "/")) + "/"
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err := windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		pid := entry.ProcessID
		if pid == 0 || int(pid) == os.Getpid() {
			continue
		}
		h, err := windows.OpenProcess(
			processTerminate|processQueryLimitedInformation, false, pid,
		)
		if err != nil {
			continue
		}
		func() {
			defer windows.CloseHandle(h)
			buf := make([]uint16, 32768)
			n := uint32(len(buf))
			if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil || n == 0 {
				return
			}
			image := strings.ToLower(strings.ReplaceAll(windows.UTF16ToString(buf[:n]), `\`, "/"))
			if strings.HasPrefix(image, prefix) {
				_ = windows.TerminateProcess(h, 1)
			}
		}()
	}
}

// processTracker implements io.Closer for TrackCore: owns a SYNCHRONIZE
// handle on the Core; Close waits for exit (bounded) then frees the handle.
type processTracker struct {
	proc *stableProcess
	done chan struct{}
}

func (t *processTracker) Close() error {
	select {
	case <-t.done:
	case <-time.After(10 * time.Second):
	}
	t.proc.close()
	return nil
}

// TrackCore keeps a kernel handle on the spawned Core so a recycled PID can
// never impersonate it; the goroutine releases the waiter on exit.
func (p *windowsPlatform) TrackCore(_ context.Context, pid int) (io.Closer, error) {
	proc, err := openProcessHandle(pid)
	if err != nil {
		return nil, err
	}
	if proc == nil {
		return nil, fmt.Errorf("core process %d is not running", pid)
	}
	t := &processTracker{proc: proc, done: make(chan struct{})}
	go func() {
		proc.waitExit(24 * time.Hour)
		close(t.done)
	}()
	return t, nil
}

// ConfigureCore: nothing platform-specific — the Core is assigned to the
// kill-on-close Job in RecordCoreStart once its PID is known.
func (p *windowsPlatform) ConfigureCore(_ *exec.Cmd) {}
