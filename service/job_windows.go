// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows SDK WinBase.h: ProcThreadAttributeJobList=13,
// ProcThreadAttributeValue(13,FALSE,TRUE,FALSE). x/sys does not expose this
// constant. Passing the job at creation closes the crash window between
// CreateProcess(CREATE_SUSPENDED) and a later AssignProcessToJobObject call.
const procThreadAttributeJobList = 0x0002000d

type ownedProcess struct {
	process windows.Handle
	job     windows.Handle
	pid     uint32
	started time.Time
	mu      sync.Mutex
	closed  bool
}

func minimalEnvironment(dir string) ([]uint16, error) {
	system, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return nil, err
	}
	values := []string{"SystemRoot=" + system, "WINDIR=" + system, "PATH=" + filepath.Join(system, "System32"), "TEMP=" + dir, "TMP=" + dir, "USERPROFILE=" + dir, "APPDATA=" + dir, "LOCALAPPDATA=" + dir}
	sort.Slice(values, func(i, j int) bool { return strings.ToUpper(values[i]) < strings.ToUpper(values[j]) })
	return append(utf16.Encode([]rune(strings.Join(values, "\x00")+"\x00")), 0), nil
}
func spawnOwned(exe, dir, logPath string, args []string) (*ownedProcess, error) {
	return spawnInJob(exe, dir, logPath, args, "")
}
func spawnInJob(exe, dir, logPath string, args []string, jobName string) (_ *ownedProcess, err error) {
	// No caller-supplied environment or executable/arguments reach this primitive
	// from IPC. Its callers construct the exact -d/-f/-t/-v commands themselves.
	var job windows.Handle
	if jobName == "" {
		job, err = windows.CreateJobObject(nil, nil)
	} else {
		job, err = createRecoveryJob(jobName)
	}
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil && job != 0 {
			_ = windows.CloseHandle(job)
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	// Duplicate only the selected handles as inheritable; the service's IPC,
	// private controller, process and job handles never enter the child.
	var out windows.Handle
	self := windows.CurrentProcess()
	if err = windows.DuplicateHandle(self, windows.Handle(log.Fd()), self, &out, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(out)
	nul, err := windows.UTF16PtrFromString("NUL")
	if err != nil {
		return nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	input, err := windows.CreateFile(nul, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, &sa, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(input)
	attrs, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	handles := []windows.Handle{input, out}
	if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
		return nil, err
	}
	if err = attrs.Update(procThreadAttributeJobList, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{StartupInfo: windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES, StdInput: input, StdOutput: out, StdErr: out}, ProcThreadAttributeList: attrs.List()}
	application, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, err
	}
	directory, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil, err
	}
	argv := []string{windows.EscapeArg(exe)}
	for _, a := range args {
		argv = append(argv, windows.EscapeArg(a))
	}
	line, err := windows.UTF16PtrFromString(strings.Join(argv, " "))
	if err != nil {
		return nil, err
	}
	env, err := minimalEnvironment(dir)
	if err != nil {
		return nil, err
	}
	var pi windows.ProcessInformation
	err = windows.CreateProcess(application, line, nil, nil, true, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT, &env[0], directory, &si.StartupInfo, &pi)
	runtime.KeepAlive(handles)
	runtime.KeepAlive(job)
	runtime.KeepAlive(env)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(pi.Thread)
	child := &ownedProcess{process: pi.Process, job: job, pid: pi.ProcessId, started: time.Now().UTC()}
	if _, err = windows.ResumeThread(pi.Thread); err != nil {
		stopErr := child.stop()
		job = child.job
		if stopErr != nil && child.process != 0 {
			_ = windows.CloseHandle(child.process)
		}
		return nil, errors.Join(err, stopErr)
	}
	return child, nil
}
func (p *ownedProcess) running() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false, nil
	}
	result, err := windows.WaitForSingleObject(p.process, 0)
	if err != nil {
		return false, err
	}
	switch result {
	case uint32(windows.WAIT_TIMEOUT):
		return true, nil
	case windows.WAIT_OBJECT_0:
		return false, nil
	default:
		return false, fmt.Errorf("uncertain owned process wait: %d", result)
	}
}
func (p *ownedProcess) stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	if err := windows.TerminateJobObject(p.job, 1); err != nil {
		return err
	}
	result, err := windows.WaitForSingleObject(p.process, 10000)
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return failure("OWNERSHIP_UNCERTAIN", "Owned process termination could not be confirmed")
	}
	if err := waitJobEmpty(p.job); err != nil {
		return err
	}
	if err := windows.CloseHandle(p.job); err != nil {
		return err
	}
	p.job = 0
	if err := windows.CloseHandle(p.process); err != nil {
		return err
	}
	p.process = 0
	p.closed = true
	return nil
}
func (p *ownedProcess) wait(timeout time.Duration) (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, errors.New("process handle is closed")
	}
	result, err := windows.WaitForSingleObject(p.process, uint32(timeout/time.Millisecond))
	if err != nil {
		return 0, err
	}
	if result != windows.WAIT_OBJECT_0 {
		return 0, errors.New("owned process timed out")
	}
	var code uint32
	err = windows.GetExitCodeProcess(p.process, &code)
	return code, err
}

// Windows SDK winnt.h JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// x/sys CreateJobObject discards ERROR_ALREADY_EXISTS on a successful handle;
// use the SDK API directly so a collision can never be adopted or modified.
var createJobObject = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreateJobObjectW")
var openJobObject = windows.NewLazySystemDLL("kernel32.dll").NewProc("OpenJobObjectW")

const jobNamePrefix = `Global\SashCore-`

var errJobCollision = errors.New("named Core job already exists")

func createRecoveryJob(name string) (windows.Handle, error) {
	if !strings.HasPrefix(name, jobNamePrefix) || !sessionPattern.MatchString(strings.TrimPrefix(name, jobNamePrefix)) {
		return 0, errors.New("invalid Core job name")
	}
	sd, err := windows.SecurityDescriptorFromString("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)")
	if err != nil {
		return 0, err
	}
	ptr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	r, _, e := createJobObject.Call(uintptr(unsafe.Pointer(&sa)), uintptr(unsafe.Pointer(ptr)))
	runtime.KeepAlive(sd)
	runtime.KeepAlive(ptr)
	h := windows.Handle(r)
	if h == 0 {
		return 0, e
	}
	if errors.Is(e, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(h)
		return 0, errJobCollision
	}
	return h, nil
}
func waitJobEmpty(job windows.Handle) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		var accounting jobAccounting
		if err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
			return err
		}
		if accounting.ActiveProcesses == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return failure("OWNERSHIP_UNCERTAIN", "Owned descendants have not exited")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type launchMarker struct {
	SchemaVersion   int    `json:"schemaVersion"`
	JobName         string `json:"jobName"`
	ServiceInstance string `json:"serviceInstance"`
	Session         string `json:"session"`
	Generation      uint64 `json:"generation"`
}

// Call only under verified private storage, on service boot or after SCM stop.
// No PID from disk is opened or signalled. The marker precedes object creation.
func recoverActiveJob(root string) (*launchMarker, error) {
	path := filepath.Join(root, "private", "active.json")
	h, err := openNoReparse(path)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = verifyPrivateACL(h, "", false); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	f.Close()
	windows.CloseHandle(h)
	if err != nil {
		return nil, err
	}
	var marker launchMarker
	if len(b) > 4096 || decodeJSON(b, &marker) != nil || marker.SchemaVersion != 1 || !strings.HasPrefix(marker.JobName, jobNamePrefix) || !sessionPattern.MatchString(strings.TrimPrefix(marker.JobName, jobNamePrefix)) || !sessionPattern.MatchString(marker.ServiceInstance) || !sessionPattern.MatchString(marker.Session) || marker.Generation == 0 || marker.Generation == ^uint64(0) {
		return nil, failure("RECOVERY_REQUIRED", "Invalid protected launch marker")
	}
	ptr, err := windows.UTF16PtrFromString(marker.JobName)
	if err != nil {
		return nil, err
	}
	// SDK JOB_OBJECT_QUERY=4, JOB_OBJECT_TERMINATE=8; handle never inherited.
	r, _, e := openJobObject.Call(uintptr(windows.READ_CONTROL|0x4|0x8), 0, uintptr(unsafe.Pointer(ptr)))
	runtime.KeepAlive(ptr)
	job := windows.Handle(r)
	if job == 0 {
		if !errors.Is(e, windows.ERROR_FILE_NOT_FOUND) {
			return nil, e
		}
		// No object means no surviving members: assignment was atomic at creation,
		// breakaway was never enabled, and the last handle kills the entire tree.
	} else {
		defer func() {
			if job != 0 {
				_ = windows.CloseHandle(job)
			}
		}()
		if err = verifyACLType(job, "", false, windows.SE_KERNEL_OBJECT); err != nil {
			return nil, err
		}
		var accounting jobAccounting
		if err = windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
			return nil, err
		}
		if err = windows.TerminateJobObject(job, 1); err != nil {
			return nil, err
		}
		if err = waitJobEmpty(job); err != nil {
			return nil, err
		}
		if err = windows.CloseHandle(job); err != nil {
			return nil, err
		}
		job = 0
	}
	if err = os.Remove(path); err != nil {
		return nil, err
	}
	return &marker, nil
}
