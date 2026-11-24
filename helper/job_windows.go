//go:build windows && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func assignCoreToKillJob(pid int) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateJobObject failed: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			windows.CloseHandle(job)
		}
	}()
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
	); err != nil {
		return 0, fmt.Errorf("SetInformationJobObject failed: %w", err)
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return 0, fmt.Errorf("OpenProcess(%d) failed: %v", pid, err)
	}
	defer windows.CloseHandle(proc)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		return 0, fmt.Errorf("AssignProcessToJobObject(%d) failed: %w", pid, err)
	}
	ok = true
	return job, nil
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
	access := uint32(windows.PROCESS_TERMINATE | windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE)
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

func (s *stableProcess) createdAt() (int64, error) {
	var created, exited, kern, user windows.Filetime
	if err := windows.GetProcessTimes(s.handle, &created, &exited, &kern, &user); err != nil {
		return 0, fmt.Errorf("GetProcessTimes failed: %w", err)
	}
	return created.Nanoseconds() / int64(time.Millisecond), nil
}

func (s *stableProcess) waitExit(timeout time.Duration) bool {
	ms := uint32(timeout / time.Millisecond)
	event, err := windows.WaitForSingleObject(s.handle, ms)
	return err == nil && event == windows.WAIT_OBJECT_0
}

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

func (p *windowsPlatform) ConfigureCore(_ *exec.Cmd) {}
