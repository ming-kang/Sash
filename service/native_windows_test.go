// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// These fixtures execute only this test binary. No SCM operation, upstream
// executable, production SASH_HOME, network listener with TUN, or installation
// path is touched by the tests.
func TestNativeFixture(t *testing.T) {
	index := -1
	for i, a := range os.Args {
		if a == "--sash-test-fixture" {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	args := os.Args[index+1:]
	if len(args) == 0 {
		os.Exit(90)
	}
	switch args[0] {
	case "sleep":
		time.Sleep(time.Minute)
	case "env":
		b, _ := json.Marshal(os.Environ())
		if err := os.WriteFile(args[1], b, 0600); err != nil {
			os.Exit(91)
		}
	case "privileges":
		if err := run([]string{"privileges", "--root", args[1]}); err != nil {
			os.Exit(97)
		}
	case "version":
		if err := run([]string{"version"}); err != nil {
			os.Exit(92)
		}
	case "guard":
		exe, _ := os.Executable()
		dir := args[1]
		child, err := spawnOwned(exe, dir, filepath.Join(dir, "guard-child.log"), []string{"-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "sleep"})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(93)
		}
		if err = os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.FormatUint(uint64(child.pid), 10)), 0600); err != nil {
			os.Exit(94)
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if _, err = os.Stat(filepath.Join(dir, "release")); err == nil {
				os.Exit(0)
			}
			time.Sleep(20 * time.Millisecond)
		}
		os.Exit(95)
	default:
		os.Exit(96)
	}
	os.Exit(0)
}
func TestNativeVersionStandalone(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "version")
	system, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env = []string{"SystemRoot=" + system, "WINDIR=" + system, "SASH_HOME=" + t.TempDir()}
	b, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Protocol int    `json:"protocol"`
		Version  string `json:"version"`
	}
	if err = decodeJSON(b, &v); err != nil || v.Protocol != 1 || v.Version != version {
		t.Fatalf("invalid standalone version: %s, %v", b, err)
	}
}
func TestOwnedJobSuspendedCreationAndTermination(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child, err := spawnOwned(exe, dir, filepath.Join(dir, "child.log"), []string{"-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "sleep"})
	if err != nil {
		t.Fatal(err)
	}
	defer child.stop()
	running, err := child.running()
	if err != nil || !running {
		t.Fatalf("fixture did not run: %v", err)
	}
	var accounting jobAccounting
	if err = windows.QueryInformationJobObject(child.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
		t.Fatal(err)
	}
	if accounting.ActiveProcesses != 1 {
		t.Fatalf("child was not atomically assigned to job: %+v", accounting)
	}
	if err = child.stop(); err != nil {
		t.Fatal(err)
	}
	if running, err = child.running(); err != nil || running {
		t.Fatalf("owned child not stopped: %v", err)
	}
	if err = child.stop(); err != nil {
		t.Fatal("stop not idempotent", err)
	}
}
func TestOwnedChildEnvironmentIsScrubbed(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "must-not-leak")
	t.Setenv("NPM_TOKEN", "must-not-leak")
	t.Setenv("npm_config_userconfig", "must-not-leak")
	t.Setenv("HTTPS_PROXY", "must-not-leak")
	dir := t.TempDir()
	exe, _ := os.Executable()
	out := filepath.Join(dir, "env.json")
	child, err := spawnOwned(exe, dir, filepath.Join(dir, "env.log"), []string{"-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "env", out})
	if err != nil {
		t.Fatal(err)
	}
	defer child.stop()
	code, err := child.wait(10 * time.Second)
	if err != nil || code != 0 {
		t.Fatalf("fixture failed: %d %v", code, err)
	}
	if err = child.stop(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "must-not-leak") || strings.Contains(strings.ToUpper(string(b)), "TOKEN") {
		t.Fatalf("credentials inherited: %s", b)
	}
	if !strings.Contains(string(b), "SystemRoot=") {
		t.Fatal("known-folder system environment missing")
	}
}
func TestParentDeathKillsOwnedJob(t *testing.T) {
	dir := t.TempDir()
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "guard", dir)
	system, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env = []string{"SystemRoot=" + system, "WINDIR=" + system, "SASH_HOME=" + dir}
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Wait()
	var pid uint64
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		b, e := os.ReadFile(filepath.Join(dir, "pid"))
		if e == nil {
			pid, err = strconv.ParseUint(string(b), 10, 32)
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("guard fixture did not announce child")
	}
	// Retain a process handle only for observation. No PID-based termination.
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if err = os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	wait, err := windows.WaitForSingleObject(h, 10000)
	if err != nil || wait != windows.WAIT_OBJECT_0 {
		t.Fatalf("job did not close on parent death: %d %v", wait, err)
	}
}
func TestPipeSpecificAccessAndKernelIdentity(t *testing.T) {
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	token, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	name := `\\.\pipe\SashService-test-` + token
	// The nonadmin test server necessarily runs as this test user. Production
	// uses SYSTEM as owner and grants this SID only pipeClientAccess.
	listener, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: "O:" + sid + "D:P(A;;GA;;;" + sid + ")"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		c, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer c.Close()
		var b [1]byte
		if _, err = io.ReadFull(c, b[:]); err != nil {
			done <- err
			return
		}
		actual, err := authenticatedSID(c)
		if err != nil {
			done <- err
			return
		}
		if actual != sid {
			done <- fmt.Errorf("kernel SID mismatch: %s", actual)
			return
		}
		_, err = c.Write(b[:])
		done <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := winio.DialPipeAccessImpLevel(ctx, name, pipeClientAccess, winio.PipeImpLevelIdentification)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	h, err := pipeHandle(c)
	if err != nil {
		t.Fatal(err)
	}
	var serverPID uint32
	if err = windows.GetNamedPipeServerProcessId(h, &serverPID); err != nil {
		t.Fatal(err)
	}
	if serverPID != uint32(os.Getpid()) {
		t.Fatal("unexpected kernel server PID")
	}
	if _, err = c.Write([]byte{42}); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	if _, err = io.ReadFull(c, b[:]); err != nil {
		t.Fatal(err)
	}
	if b[0] != 42 {
		t.Fatal("pipe echo mismatch")
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
func TestRestrictedPipeDACLExcludesInstanceCreation(t *testing.T) {
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	sddl, err := pipeSD(sid)
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner.String() != "S-1-5-18" {
		t.Fatal("production pipe owner is not SYSTEM")
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err = windows.GetAce(acl, 2, &ace); err != nil {
		t.Fatal(err)
	}
	if uint32(ace.Mask) != pipeClientAccess || uint32(ace.Mask)&0x4 /* FILE_CREATE_PIPE_INSTANCE */ != 0 || uint32(ace.Mask)&windows.GENERIC_WRITE != 0 {
		t.Fatalf("unsafe client mask: %x", ace.Mask)
	}
}
func TestControllerSocketOwnershipAgainstKernel(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, e := listener.Accept()
		if e == nil {
			accepted <- c
		}
	}()
	c, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	server := <-accepted
	defer server.Close()
	if err = controllerConnectionOwner(c, uint32(os.Getpid())); err != nil {
		t.Fatal(err)
	}
	if err = controllerConnectionOwner(c, uint32(os.Getpid()+1)); err == nil {
		t.Fatal("foreign controller PID accepted")
	}
}
func TestRootCanonicalizationRejectsAliases(t *testing.T) {
	dir := t.TempDir()
	root, err := canonicalRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(root, dir) {
		t.Fatalf("canonical root changed: %s", root)
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		owner, err := enrollmentSID(dir)
		if err != nil {
			t.Fatal(err)
		}
		caller, err := currentSID()
		if err != nil || owner != caller {
			t.Fatalf("wrong enrolled user: %s %v", owner, err)
		}
	}
	for _, p := range []string{"relative", `\\server\share`, dir + `\..\CON`, dir + `:stream`, dir + `.`, dir + `\name `} {
		if _, err = canonicalRoot(p); err == nil {
			t.Fatalf("unsafe root accepted: %s", p)
		}
	}
}

func TestOwnedCreationFailureDoesNotReturnChild(t *testing.T) {
	dir := t.TempDir()
	child, err := spawnOwned(filepath.Join(dir, "missing-fixture.exe"), dir, filepath.Join(dir, "child.log"), nil)
	if err == nil || child != nil {
		t.Fatalf("missing executable did not fail safely: %+v %v", child, err)
	}
}

func TestPrivilegesWithoutElevation(t *testing.T) {
	if windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("requires ordinary token to verify nonadmin privileges query")
	}
	root, err := canonicalRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := privileges(root)
	if err != nil || p.Elevated || !p.OwnerMatches {
		t.Fatalf("ordinary owner query: %+v %v", p, err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "privileges", root)
	raw, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != `{"elevated":false,"ownerMatches":true}` {
		t.Fatalf("unexpected privileges wire response: %s", raw)
	}

	if err = requireRootOwner(root); err != nil {
		t.Fatal(err)
	}
	if _, err = stageMaintenance(root); err == nil {
		t.Fatal("ordinary token staged maintenance")
	}
	if err = cleanupMaintenance(root, root); err == nil {
		t.Fatal("ordinary token cleaned maintenance")
	}
}

func TestUnavailableStatusUsesOnlyVerifiedMetadata(t *testing.T) {
	called := false
	load := func() (enrollment, error) {
		called = true
		return enrollment{Protocol: protocol, Root: `C:\actual-enrolled-root`, Core: approval{Version: "v-approved"}}, nil
	}
	ordinary, err := unavailableStatus(false, load)
	if err != nil || called || ordinary.Root != "" || !ordinary.Installed || ordinary.Running {
		t.Fatalf("ordinary fallback: %+v %v", ordinary, err)
	}
	admin, err := unavailableStatus(true, load)
	if err != nil || !called || admin.Root != `C:\actual-enrolled-root` || admin.CoreVersion != "v-approved" {
		t.Fatalf("admin fallback: %+v %v", admin, err)
	}
	for _, state := range []status{ordinary, admin} {
		b, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err = json.Unmarshal(b, &wire); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"core", "generation", "serviceInstance"} {
			if _, exists := wire[key]; exists {
				t.Fatalf("fabricated observation %s: %s", key, b)
			}
		}
	}
	_, err = unavailableStatus(true, func() (enrollment, error) {
		return enrollment{}, failure("UNSAFE_STORAGE", "invalid protected enrollment")
	})
	if err == nil {
		t.Fatal("unsafe enrollment accepted")
	}
}

func TestMaintenanceStageProtectedCopy(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("protected Program Files staging requires an elevated token; no SCM operations performed")
	}
	root := t.TempDir()
	caller, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := windows.StringToSid(caller)
	if err != nil {
		t.Fatal(err)
	}
	// Elevated-created temporary roots can be Administrators-owned. This isolated
	// fixture explicitly enrolls only the current kernel user, never a real root.
	if err = windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, sid, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	stage, err := stageMaintenance(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cleanupMaintenance(root, stage.Directory); err != nil {
			t.Error(err)
		}
	}()
	fixed, err := protectedRoot()
	if err != nil {
		t.Fatal(err)
	}
	if stage.Protocol != protocol || !strings.EqualFold(filepath.Dir(stage.Directory), filepath.Dir(fixed)) || !strings.HasPrefix(filepath.Base(stage.Directory), maintenancePrefix) || stage.HelperPath != filepath.Join(stage.Directory, "sash-service.exe") {
		t.Fatalf("wrong staging path: %+v", stage)
	}
	self, _ := os.Executable()
	expected, err := hashFile(self)
	if err != nil {
		t.Fatal(err)
	}
	h, err := approvedFile(stage.HelperPath, expected, "", false)
	if err != nil {
		t.Fatal(err)
	}
	windows.CloseHandle(h)
	// Unknown contents must remain untouched; cleanup never uses RemoveAll.
	unknown := filepath.Join(stage.Directory, "unknown")
	if err = os.WriteFile(unknown, []byte("retain"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = cleanupMaintenance(root, stage.Directory); err == nil {
		t.Fatal("unknown stage contents removed")
	}
	if err = os.Remove(unknown); err != nil {
		t.Fatal(err)
	}
	if err = cleanupMaintenance(root, fixed); err == nil {
		t.Fatal("fixed installation accepted as cleanup path")
	}
}

func TestOrphanRepairRejectsRuntimeAndForeignEvidenceWithoutMutation(t *testing.T) {
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, evidence := range []string{"active.json", "runtime-journal.json", "foreign", "corrupt", "invalid-target"} {
		t.Run(evidence, func(t *testing.T) {
			root := t.TempDir()
			private := filepath.Join(root, "private")
			if err := os.Mkdir(private, 0700); err != nil {
				t.Fatal(err)
			}
			userRoot := t.TempDir()
			target := filepath.Join(private, "policy.json")
			raw := []byte(`{"broken":`)
			switch evidence {
			case "active.json", "runtime-journal.json":
				target = filepath.Join(private, evidence)
			case "foreign":
				raw = []byte(`{"owner":"S-1-5-18","root":"different"}`)
			case "invalid-target":
				target = filepath.Join(private, "install-journal.json")
				raw, _ = json.Marshal(journal{Files: []fileSnapshot{{Path: filepath.Join(root, "unrelated"), Existed: false}}})
			}
			if err := os.WriteFile(target, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := recoverOrphanEnrollment(root, userRoot, sid); err == nil {
				t.Fatal("uncertain evidence accepted")
			}
			after, err := os.ReadFile(target)
			if err != nil || string(after) != string(raw) {
				t.Fatal("evidence changed")
			}
		})
	}
}

func TestOrphanFirstInstallJournalRepairFixture(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("rollback atomic protected writes require elevation; isolated fixture only, no SCM")
	}
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, restore := range []bool{false, true} {
		root := t.TempDir()
		userRoot := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, "private"), 0700); err != nil {
			t.Fatal(err)
		}
		policy := enrollment{Protocol: protocol, Owner: sid, Root: userRoot, HelperSHA256: strings.Repeat("a", 64), Core: approval{SHA256: strings.Repeat("b", 64), Version: "v-approved"}}
		prior, _ := json.Marshal(policy)
		j := journal{}
		for _, file := range []string{filepath.Join(root, "sash-service.exe"), filepath.Join(root, "private", "core.exe"), policyPath(root)} {
			snapshot := fileSnapshot{Path: file, Existed: restore}
			if restore {
				snapshot.Data = []byte("prior fixture")
				if file == policyPath(root) {
					snapshot.Data = prior
				}
			}
			j.Files = append(j.Files, snapshot)
			if err := os.WriteFile(file, []byte("partial"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		raw, _ := json.Marshal(j)
		jp := filepath.Join(root, "private", "install-journal.json")
		if err := os.WriteFile(jp, raw, 0600); err != nil {
			t.Fatal(err)
		}
		recovered, err := recoverOrphanEnrollment(root, userRoot, sid)
		if err != nil {
			t.Fatal(err)
		}
		if restore && recovered.Core.Version != "v-approved" {
			t.Fatal("approved version lost")
		}
		if _, err := os.Stat(jp); !os.IsNotExist(err) {
			t.Fatal("journal not resolved")
		}
		if !restore {
			if _, err := os.Stat(policyPath(root)); !os.IsNotExist(err) {
				t.Fatal("partial policy retained")
			}
		}
	}
}

func TestRepairStatusRequiresElevationBeforeSCM(t *testing.T) {
	if windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("ordinary-token preflight fixture")
	}
	if _, err := repairStatus(t.TempDir()); err == nil {
		t.Fatal("ordinary repair accepted")
	}
}

type idleSCMFixture struct {
	state      svc.State
	starts     int
	queryError error
	startError error
}

func (f *idleSCMFixture) Query() (svc.Status, error) { return svc.Status{State: f.state}, f.queryError }
func (f *idleSCMFixture) Start(args ...string) error {
	f.starts++
	if len(args) != 0 {
		return fmt.Errorf("unexpected launch arguments")
	}
	f.state = svc.Running
	return f.startError
}
func TestIdleHostRecoveryUsesOnlyExistingSCMStartAndPositiveObservation(t *testing.T) {
	for _, mode := range []string{"idle", "active", "unobserved", "query", "start", "running", "pending"} {
		t.Run(mode, func(t *testing.T) {
			service := &idleSCMFixture{state: svc.Stopped}
			switch mode {
			case "query":
				service.queryError = fmt.Errorf("query failed")
			case "start":
				service.startError = fmt.Errorf("start failed")
			case "running":
				service.state = svc.Running
			case "pending":
				service.state = svc.StartPending
			}
			observations := 0
			out, err := startIdleHost(context.Background(), service, func() (status, error) {
				observations++
				if mode == "unobserved" {
					return status{}, failure("RECOVERY_REQUIRED", "named job recovery uncertain")
				}
				return status{Version: "0.0.2", Core: coreStatus{Running: mode == "active"}}, nil
			})
			if mode == "idle" {
				if err != nil || out.Version != "0.0.2" || service.starts != 1 || observations != 1 {
					t.Fatalf("idle recovery: %+v %v", out, err)
				}
			} else if err == nil {
				t.Fatal("unsafe recovery accepted")
			}
			if mode == "query" || mode == "running" || mode == "pending" {
				if service.starts != 0 || observations != 0 {
					t.Fatal("unconfirmed stopped SCM was started")
				}
			}
		})
	}
}
func TestStartExistingServiceRequiresAdminBeforeSCM(t *testing.T) {
	if windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("ordinary-token administrative role fixture; no actual SCM operations")
	}
	if _, err := startExistingService(t.TempDir()); err == nil {
		t.Fatal("ordinary service start accepted")
	}
}
