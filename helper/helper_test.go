//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// The test binary doubles as a fake Core: the host starts it as
// `<core> -d <home> -f <config>`, which no test flag ever looks like.
func TestMain(m *testing.M) {
	if len(os.Args) == 5 && os.Args[1] == "-d" && os.Args[3] == "-f" {
		fmt.Println(strings.Join(os.Args[1:], " "))
		select {}
	}
	os.Exit(m.Run())
}

func testConfig(t *testing.T) config {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	user, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	return config{
		user:       user,
		core:       exe,
		home:       dir,
		configFile: filepath.Join(dir, "config.yaml"),
		stdout:     filepath.Join(dir, "core.log"),
		stderr:     filepath.Join(dir, "core.err.log"),
		pipe:       fmt.Sprintf(`\\.\pipe\sash-tun-test-%d-%d`, os.Getpid(), time.Now().UnixNano()),
	}
}

func currentUserSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func TestParseConfig(t *testing.T) {
	valid := []string{
		"--user", "S-1-5-21-1-2-3-1001",
		"--core", `C:\Users\a\AppData\Local\Sash\bin\mihomo.exe`,
		"--home", `C:\Users\a\AppData\Local\Sash`,
		"--config", `C:\Users\a\AppData\Local\Sash\runtime\config.yaml`,
		"--stdout", `C:\Users\a\AppData\Local\Sash\logs\mihomo.log`,
		"--stderr", `C:\Users\a\AppData\Local\Sash\logs\mihomo.err.log`,
	}
	cfg, err := parseConfig(valid)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.pipe != defaultPipe || cfg.home != `C:\Users\a\AppData\Local\Sash` {
		t.Fatalf("unexpected config %+v", cfg)
	}
	for name, args := range map[string][]string{
		"bad sid":       replace(valid, "S-1-5-21-1-2-3-1001", "Everyone"),
		"relative path": replace(valid, `C:\Users\a\AppData\Local\Sash\bin\mihomo.exe`, `bin\mihomo.exe`),
		"remote pipe":   append(append([]string{}, valid...), "--pipe", `\\server\pipe\sash-tun`),
		"extra arg":     append(append([]string{}, valid...), "extra"),
		"missing core":  valid[2:],
	} {
		if _, err := parseConfig(args); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func replace(args []string, old, new string) []string {
	out := append([]string{}, args...)
	for i, value := range out {
		if value == old {
			out[i] = new
		}
	}
	return out
}

func TestCoreEnvironmentKeepsOnlySystemVariables(t *testing.T) {
	got := coreEnvironment([]string{
		"=C:=C:\\work", "Path=C:\\Windows", "SystemRoot=C:\\Windows",
		"HTTP_PROXY=http://127.0.0.1:1", "CLASH_OVERRIDE_SECRET=x", "USERPROFILE=C:\\Windows\\system32",
	})
	want := []string{"Path=C:\\Windows", "SystemRoot=C:\\Windows"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q, want %q", got, want)
	}
}

type fakeController struct {
	running   bool
	fail      error
	started   []startOptions
	unguarded int
	sequence  []string
}

func (f *fakeController) apply(op operation) operationResult {
	f.sequence = append(f.sequence, "apply")
	switch op.kind {
	case opStart:
		f.started = append(f.started, op.start)
		if f.fail != nil {
			return operationResult{err: f.fail}
		}
		f.running = true
	case opStop:
		f.running = false
	case opUnguard:
		f.unguarded++
	}
	return operationResult{}
}

func (f *fakeController) snapshot() statusSnapshot {
	f.sequence = append(f.sequence, "snapshot")
	running, pid := false, 0
	if f.running {
		running, pid = true, 42
	}
	return statusSnapshot{
		running: running,
		pid:     pid,
		guard:   guardState{Active: true, Device: "Meta", InterfaceIndex: 7},
	}
}

func TestDispatch(t *testing.T) {
	core := &fakeController{}
	if res := dispatch(core, []byte(`{"op":"start"}`)); !res.OK || !res.Running || res.PID != 42 {
		t.Fatalf("start: %+v", res)
	}
	if res := dispatch(core, []byte(`{"op":"start","guard":true,"device":"Meta"}`)); !res.OK {
		t.Fatalf("guarded start: %+v", res)
	}
	if len(core.started) != 2 || core.started[0].guard || !core.started[1].guard || core.started[1].device != "Meta" {
		t.Fatalf("start options passed through: %+v", core.started)
	}
	if res := dispatch(core, []byte(`{"op":"start","guard":true,"device":"bad device!"}`)); res.OK || res.Error == "" {
		t.Fatalf("invalid device must be rejected: %+v", res)
	}
	if res := dispatch(core, []byte(`{"op":"status"}`)); !res.OK || !res.Running {
		t.Fatalf("status: %+v", res)
	}
	if res := dispatch(core, []byte(`{"op":"stop"}`)); !res.OK || res.Running || res.PID != 0 {
		t.Fatalf("stop: %+v", res)
	}
	if core.unguarded != 0 {
		t.Fatal("stop must not converge the guard")
	}
	if res := dispatch(core, []byte(`{"op":"unguard"}`)); !res.OK || core.unguarded != 1 {
		t.Fatalf("unguard: %+v after %d calls", res, core.unguarded)
	}
	if res := dispatch(core, []byte(`{"op":"status"}`)); !res.Guard.Active || res.Guard.Device != "Meta" || res.Guard.InterfaceIndex != 7 {
		t.Fatalf("guard state in response: %+v", res)
	}
	core.fail = errors.New("boom")
	if res := dispatch(core, []byte(`{"op":"start"}`)); res.OK || res.Error != "boom" {
		t.Fatalf("failed start: %+v", res)
	}
	for _, line := range []string{`{"op":"exec"}`, `not json`} {
		if res := dispatch(core, []byte(line)); res.OK || res.Error == "" {
			t.Fatalf("%s: %+v", line, res)
		}
	}
}

func TestDispatchReadsStateAfterOperation(t *testing.T) {
	core := &fakeController{}
	dispatch(core, []byte(`{"op":"start"}`))
	dispatch(core, []byte(`{"op":"stop"}`))
	want := []string{"apply", "snapshot", "apply", "snapshot"}
	if strings.Join(core.sequence, ",") != strings.Join(want, ",") {
		t.Fatalf("operation/state order %v, want %v", core.sequence, want)
	}
	for _, line := range []string{`{"op":"start","device":"bad device!"}`, `{"op":"exec"}`, `not json`} {
		core.sequence = nil
		dispatch(core, []byte(line))
		if len(core.sequence) != 0 {
			t.Fatalf("%s read state without a valid operation: %v", line, core.sequence)
		}
	}
}

func TestCoreHostLifecycle(t *testing.T) {
	cfg := testConfig(t)
	host, err := newCoreHost(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer host.close()
	if err := host.start(); err != nil {
		t.Fatal(err)
	}
	running, pid := host.status()
	if !running || pid == 0 {
		t.Fatalf("status after start: %v %d", running, pid)
	}
	if err := host.start(); err == nil {
		t.Fatal("second start should fail while the Core runs")
	}
	want := fmt.Sprintf("-d %s -f %s", cfg.home, cfg.configFile)
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, _ := os.ReadFile(cfg.stdout)
		if strings.Contains(string(data), want) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Core stdout %q never contained %q", data, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := host.stop(); err != nil {
		t.Fatal(err)
	}
	if running, _ := host.status(); running {
		t.Fatal("Core still reported running after stop")
	}
	if err := host.stop(); err != nil {
		t.Fatalf("stopping a stopped Core: %v", err)
	}
}

func TestCoreHostRejectsMissingCoreAndLinkedLogs(t *testing.T) {
	cfg := testConfig(t)
	cfg.core = filepath.Join(cfg.home, "missing.exe")
	host, err := newCoreHost(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer host.close()
	if err := host.start(); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing Core: %v", err)
	}
	if err := os.Mkdir(filepath.Join(cfg.home, "dir.log"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := openLog(filepath.Join(cfg.home, "dir.log")); err == nil {
		t.Fatal("a directory must not be accepted as a log file")
	}
}

func TestHelperStartupConvergesStaleGuard(t *testing.T) {
	cfg := testConfig(t)
	engine := newFakeEngine()
	if err := installGuardPlan(engine, buildGuardPlan([]byte("stale"), 1)); err != nil {
		t.Fatal(err)
	}
	helper, err := openHelperWithEngine(cfg, engine, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.close()
	state := helper.core.snapshot()
	if state.running || state.guard.Active {
		t.Fatalf("startup state %+v", state)
	}
	if _, count := engine.snapshot(); count != 0 {
		t.Fatalf("%d stale filters remain after helper startup", count)
	}
}

func TestPipeRoundTrip(t *testing.T) {
	cfg := testConfig(t)
	helper, err := openHelperWithEngine(cfg, newFakeEngine(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.close()
	go helper.serve()

	callLine := func(line string) response {
		t.Helper()
		timeout := 5 * time.Second
		conn, err := winio.DialPipe(cfg.pipe, &timeout)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if _, err := fmt.Fprintln(conn, line); err != nil {
			t.Fatal(err)
		}
		var res response
		answer, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(answer, &res); err != nil {
			t.Fatal(err)
		}
		return res
	}
	call := func(op string) response {
		t.Helper()
		return callLine(fmt.Sprintf("{\"op\":%q}", op))
	}

	if res := call("status"); !res.OK || res.Running || res.Protocol != protocolVersion || res.Home != cfg.home {
		t.Fatalf("status: %+v", res)
	}
	if res := callLine(`{"op":"start","guard":true,"device":"Meta"}`); !res.OK || !res.Running || res.PID == 0 || !res.Guard.Active {
		t.Fatalf("guarded start: %+v", res)
	}
	if res := call("stop"); !res.OK || res.Running || !res.Guard.Active {
		t.Fatalf("stop must keep the guard: %+v", res)
	}
	if res := call("unguard"); !res.OK || res.Guard.Active {
		t.Fatalf("unguard: %+v", res)
	}
}
