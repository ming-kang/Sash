//go:build darwin && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

var recordedCalls []string
var commandResponder func(tool string, argv []string) (string, error)

// stubCommands swaps the command lane for the fixture responder, mirroring
// the TS test's vi.mock of runSanitizedCommandAsync.
func stubCommands(t *testing.T, responder func(tool string, argv []string) (string, error)) {
	t.Helper()
	saved := runCommand
	runCommand = func(_ time.Duration, tool string, argv ...string) (string, error) {
		recordedCalls = append(recordedCalls, strings.Join(append([]string{tool}, argv...), " "))
		if responder == nil {
			return "", nil
		}
		return responder(tool, argv)
	}
	t.Cleanup(func() { runCommand = saved })
}

func seedJournal(t *testing.T, workDir string, body string) {
	t.Helper()
	if err := os.WriteFile(journalPath(workDir), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func journalExists(workDir string) bool {
	_, err := os.Stat(journalPath(workDir))
	return err == nil
}

func sleepChild(t *testing.T) *exec.Cmd {
	t.Helper()
	child := exec.Command("/bin/sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	// Like node, which reaps children on exit, reap the process in the
	// background so kill(pid, 0) reports ESRCH once it dies instead of
	// seeing a live zombie.
	go func() { _ = child.Wait() }()
	t.Cleanup(func() { _ = child.Process.Kill() })
	return child
}

func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestJournalV3ParseAndReject(t *testing.T) {
	workDir := t.TempDir()
	seedJournal(t, workDir, `{"version":3,"pid":42,"procStart":"Mon Nov 23 10:00:00 2026","iface":"utun4","createdAt":"2026-11-23T10:00:00Z"}`)
	journal, err := readSessionJournal(workDir)
	if err != nil {
		t.Fatal(err)
	}
	if journal.PID != 42 || journal.Iface != "utun4" {
		t.Fatalf("bad journal: %+v", journal)
	}

	cases := []struct {
		name, body, want string
	}{
		{"not json", `not json`, "corrupt"},
		{"non object", `42`, "corrupt"},
		{"version 2", `{"version":2,"pid":1}`, "fields"},
		{"wrong pid type", `{"version":3,"pid":"42","procStart":"x","iface":null,"createdAt":"x"}`, "fields"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			seedJournal(t, workDir, tc.body)
			_, err := readSessionJournal(workDir)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q error, got %v", tc.want, err)
			}
		})
	}
}

func TestUtunIfaceFromLsof(t *testing.T) {
	output := "COMMAND   PID USER   FD   TYPE     DEVICE SIZE/OFF NODE NAME\n" +
		"mihomo 16193 root    8u  systm 0x... [ctl com.apple.net.utun_control id 5 unit 5]"
	if got := utunIfaceFromLsof(output); got != "utun4" {
		t.Fatalf("expected utun4, got %q", got)
	}
	if got := utunIfaceFromLsof("mihomo 1 root 3u IPv4 0x0 UDP"); got != "" {
		t.Fatalf("expected no attribution, got %q", got)
	}
}

func TestRecoverNoJournalIsNoop(t *testing.T) {
	workDir := t.TempDir()
	recordedCalls = nil
	stubCommands(t, nil)
	if err := recoverTunSession(workDir); err != nil {
		t.Fatal(err)
	}
	if len(recordedCalls) != 0 {
		t.Fatalf("expected no commands, got %v", recordedCalls)
	}
}

func TestRecoverRefusesCorruptJournal(t *testing.T) {
	workDir := t.TempDir()
	seedJournal(t, workDir, `{broken json`)
	err := recoverTunSession(workDir)
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected corrupt error, got %v", err)
	}
	if !journalExists(workDir) {
		t.Fatal("corrupt journal must be kept")
	}
}

func TestRecoverDropsIntentJournal(t *testing.T) {
	workDir := t.TempDir()
	seedJournal(t, workDir, `{"version":3,"pid":0,"procStart":"","iface":null,"createdAt":"2026-11-23T10:00:00Z"}`)
	recordedCalls = nil
	stubCommands(t, nil)
	if err := recoverTunSession(workDir); err != nil {
		t.Fatal(err)
	}
	if len(recordedCalls) != 0 {
		t.Fatalf("expected no commands, got %v", recordedCalls)
	}
	if journalExists(workDir) {
		t.Fatal("intent journal must be removed")
	}
}

func TestRecoverReapsLiveCore(t *testing.T) {
	workDir := t.TempDir()
	child := sleepChild(t)
	procStart := "Mon Nov 23 10:00:00 2026"
	seedJournal(t, workDir, fmt.Sprintf(`{"version":3,"pid":%d,"procStart":%q,"iface":"utun4","createdAt":"2026-11-23T10:00:00Z"}`, child.Process.Pid, procStart))
	stubCommands(t, func(tool string, argv []string) (string, error) {
		if strings.Join(argv, " ") == fmt.Sprintf("-p %d -o lstart=", child.Process.Pid) {
			return procStart, nil
		}
		return "", nil
	})
	if err := recoverTunSession(workDir); err != nil {
		t.Fatal(err)
	}
	if journalExists(workDir) {
		t.Fatal("journal must be removed after reap")
	}
	if pidAlive(child.Process.Pid) {
		t.Fatal("recorded Core must be reaped")
	}
}

func TestRecoverDoesNotKillReusedPid(t *testing.T) {
	workDir := t.TempDir()
	child := sleepChild(t)
	seedJournal(t, workDir, fmt.Sprintf(`{"version":3,"pid":%d,"procStart":"some other start time","iface":null,"createdAt":"2026-11-23T10:00:00Z"}`, child.Process.Pid))
	stubCommands(t, func(tool string, argv []string) (string, error) {
		if strings.Join(argv, " ") == fmt.Sprintf("-p %d -o lstart=", child.Process.Pid) {
			return "the actual start", nil
		}
		return "", nil
	})
	if err := recoverTunSession(workDir); err != nil {
		t.Fatal(err)
	}
	if journalExists(workDir) {
		t.Fatal("reused-pid journal must be removed")
	}
	if !pidAlive(child.Process.Pid) {
		t.Fatal("reused pid must not be signalled")
	}
}

func TestRecoverKeepsJournalOnUnknownState(t *testing.T) {
	workDir := t.TempDir()
	child := sleepChild(t)
	seedJournal(t, workDir, fmt.Sprintf(`{"version":3,"pid":%d,"procStart":"Mon Nov 23 10:00:00 2026","iface":null,"createdAt":"2026-11-23T10:00:00Z"}`, child.Process.Pid))
	stubCommands(t, func(tool string, argv []string) (string, error) {
		return "", errors.New("ps: exit status 1")
	})
	err := recoverTunSession(workDir)
	if err == nil || !strings.Contains(err.Error(), "Cannot determine") {
		t.Fatalf("expected Cannot determine error, got %v", err)
	}
	if !journalExists(workDir) {
		t.Fatal("journal must be kept on unknown state")
	}
	if !pidAlive(child.Process.Pid) {
		t.Fatal("undetermined process must not be signalled")
	}
}

func TestRecoverDropsJournalWhenCoreGone(t *testing.T) {
	workDir := t.TempDir()
	seedJournal(t, workDir, `{"version":3,"pid":2000000000,"procStart":"Mon Nov 23 10:00:00 2026","iface":"utun4","createdAt":"2026-11-23T10:00:00Z"}`)
	recordedCalls = nil
	stubCommands(t, nil)
	if err := recoverTunSession(workDir); err != nil {
		t.Fatal(err)
	}
	if len(recordedCalls) != 0 {
		t.Fatalf("expected no commands, got %v", recordedCalls)
	}
	if journalExists(workDir) {
		t.Fatal("journal must be removed for gone Core")
	}
}

func TestPrepareConfigInjectsNativeDnsMode(t *testing.T) {
	cases := []struct {
		name, in, wantMode string
		wantErr            bool
	}{
		{"default", "tun:\n  enable: true\n", "native", false},
		{"native", "tun:\n  enable: true\n  dns-mode: native\n", "native", false},
		{"hijack", "tun:\n  enable: true\n  dns-mode: hijack\n", "hijack", false},
		{"disabled", "tun:\n  enable: true\n  dns-mode: disabled\n", "disabled", false},
		{"fake-ip rejected", "tun:\n  enable: true\n  dns-mode: fake-ip\n", "", true},
		{"empty rejected", "tun:\n  enable: true\n  dns-mode: \"\"\n", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := prepareMacosConfig([]byte(tc.in))
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected rejection")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(out), "dns-mode: "+tc.wantMode) {
				t.Fatalf("expected dns-mode %s, got:\n%s", tc.wantMode, out)
			}
		})
	}
	// TUN disabled: passthrough, no transform.
	in := "tun:\n  enable: false\n"
	out, err := prepareMacosConfig([]byte(in))
	if err != nil || string(out) != in {
		t.Fatalf("expected passthrough, got %q %v", out, err)
	}
}

// The regression: ACLs must be normalized BEFORE anything touches the
// socket path — a stale writable ACL left over from a previous install can
// never widen the bind window.
func TestListenStripsAclBeforeSocket(t *testing.T) {
	// macOS sun_path is 104 bytes — keep the fixture path short.
	runDir, err := os.MkdirTemp("/tmp", "st-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(runDir) })
	socket := filepath.Join(runDir, "helper.sock")
	recordedCalls = nil
	stubCommands(t, func(tool string, argv []string) (string, error) {
		if tool == "/usr/bin/id" {
			return "devin", nil
		}
		return "", nil
	})
	saved := verifyProtectedPath
	verifyProtectedPath = func(string) error { return nil }
	t.Cleanup(func() { verifyProtectedPath = saved })

	p := &darwinPlatform{socket: socket, ownerUID: 501}
	listener, err := p.Listen(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	stripIdx, grantIdx, socketGrantIdx := -1, -1, -1
	for i, call := range recordedCalls {
		if call == fmt.Sprintf("/bin/chmod -N %s", runDir) {
			stripIdx = i
		}
		if call == fmt.Sprintf("/bin/chmod +a user:devin allow search %s", runDir) {
			grantIdx = i
		}
		if call == fmt.Sprintf("/bin/chmod +a user:devin allow write %s", socket) {
			socketGrantIdx = i
		}
	}
	if stripIdx < 0 || grantIdx < 0 || socketGrantIdx < 0 {
		t.Fatalf("expected ACL calls, got %v", recordedCalls)
	}
	if !(stripIdx < grantIdx && grantIdx < socketGrantIdx) {
		t.Fatalf("ACL ordering wrong: %v", recordedCalls)
	}
	// The id -un probe precedes every ACL mutation.
	if recordedCalls[0] != "/usr/bin/id -un 501" {
		t.Fatalf("expected owner lookup first, got %v", recordedCalls)
	}
}
