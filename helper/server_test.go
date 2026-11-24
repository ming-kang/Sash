package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

type mockPlatform struct {
	bin, work string
	early     bool
	ready     chan string
	recovered func(context.Context) error
	restore   atomic.Int32
	pid       atomic.Int32
}

func (p *mockPlatform) BinDir() string                                             { return p.bin }
func (p *mockPlatform) WorkDir() string                                            { return p.work }
func (*mockPlatform) AuthorizePeer(net.Conn) bool                                  { return true }
func (*mockPlatform) VerifyProtectedPath(context.Context, string) error            { return nil }
func (*mockPlatform) ValidateConfig(context.Context, string, []byte, string) error { return nil }
func (*mockPlatform) PrepareConfig(_ context.Context, b []byte, _ string) ([]byte, error) {
	return b, nil
}
func (p *mockPlatform) ListenBeforeRecovery() bool { return p.early }
func (p *mockPlatform) RecoverNetwork(ctx context.Context) error {
	if p.recovered != nil {
		return p.recovered(ctx)
	}
	return nil
}
func (p *mockPlatform) Listen(context.Context) (net.Listener, error) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e == nil {
		p.ready <- l.Addr().String()
	}
	return l, e
}
func (p *mockPlatform) PrepareNetwork(context.Context, []byte, string) (NetworkSession, error) {
	return p, nil
}
func (p *mockPlatform) RecordCoreStart(_ context.Context, pid int) error {
	p.pid.Store(int32(pid))
	return nil
}
func (p *mockPlatform) Cleanup(context.Context) error                           { p.restore.Add(1); return nil }
func (*mockPlatform) VerifyControllerPeer(context.Context, net.Conn, int) error { return nil }
func dirs(t *testing.T) *mockPlatform {
	t.Helper()
	root, err := os.MkdirTemp("", "sash-go-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	bin, work := filepath.Join(root, "b"), filepath.Join(root, "w")
	for _, d := range []string{bin, work} {
		if err = os.Mkdir(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return &mockPlatform{bin: bin, work: work, ready: make(chan string, 1)}
}
func recv(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("listener did not start")
		return ""
	}
}
func ask(t *testing.T, c net.Conn, method string, cfg ...string) response {
	t.Helper()
	m := map[string]string{"method": method}
	if len(cfg) > 0 {
		m["configText"] = cfg[0]
	}
	if err := json.NewEncoder(c).Encode(m); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	b, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var r response
	if err = json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}
func connect(t *testing.T, address string) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}
func TestRecoveryGatesConnections(t *testing.T) {
	for _, name := range []string{"before-bind", "after-bind", "fatal-after-bind"} {
		t.Run(name, func(t *testing.T) {
			p := dirs(t)
			p.early = name != "before-bind"
			entered := make(chan struct{})
			release := make(chan struct{})
			p.recovered = func(ctx context.Context) error {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
				if name == "fatal-after-bind" {
					return errors.New("cannot recover")
				}
				return nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- serve(ctx, p, "") }()
			<-entered
			if !p.early {
				select {
				case <-p.ready:
					t.Fatal("bound before recovery")
				default:
				}
				close(release)
				c := connect(t, recv(t, p.ready))
				if !ask(t, c, "status").OK {
					t.Fatal("status failed")
				}
			} else {
				c := connect(t, recv(t, p.ready))
				if _, err := io.WriteString(c, "{\"method\":\"status\"}\n"); err != nil {
					t.Fatal(err)
				}
				c.SetReadDeadline(time.Now().Add(40 * time.Millisecond))
				var b [1]byte
				if _, err := c.Read(b[:]); err == nil {
					t.Fatal("served before recovery")
				}
				close(release)
				c.SetReadDeadline(time.Now().Add(5 * time.Second))
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if name == "fatal-after-bind" {
					if err == nil {
						t.Fatal("served after fatal recovery")
					}
					if e := <-done; e == nil || e.Error() != "cannot recover" {
						t.Fatalf("serve: %v", e)
					}
					return
				}
				if err != nil || !strings.Contains(string(line), "\"pid\":null") {
					t.Fatalf("%s %v", line, err)
				}
			}
			cancel()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "-d" {
		var c map[string]any
		if err := yaml.NewDecoder(os.Stdin).Decode(&c); err != nil {
			os.Exit(2)
		}
		network, address := "unix", c["external-controller-unix"]
		if runtime.GOOS == "windows" {
			network, address = "tcp4", c["external-controller"]
		}
		l, err := net.Listen(network, address.(string))
		if err != nil {
			os.Exit(3)
		}
		gateway := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if runtime.GOOS == "windows" && r.Header.Get("Authorization") != "Bearer "+c["secret"].(string) {
				w.WriteHeader(401)
				return
			}
			if r.Method == "PUT" && r.URL.Path == "/configs" {
				var b map[string]string
				var next map[string]any
				if json.NewDecoder(r.Body).Decode(&b) != nil || yaml.Unmarshal([]byte(b["payload"]), &next) != nil || next["mode"] != "direct" {
					w.WriteHeader(400)
					return
				}
				w.WriteHeader(204)
				return
			}
			if r.URL.Path == "/version" && r.Header.Get("Authorization") != "attacker" {
				fmt.Fprint(w, "core")
				return
			}
			w.WriteHeader(418)
		})
		fmt.Println("core ready")
		_ = http.Serve(l, gateway)
		os.Exit(4)
	}
	os.Exit(m.Run())
}
func TestProcessLifecycle(t *testing.T) {
	p := dirs(t)
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(corePath(p.bin), b, 0700); err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf("%x", sha256.Sum256(b))
	if err = verifyCore(context.Background(), p, p.bin, strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted incorrect digest")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, p, expected) }()
	addr := recv(t, p.ready)
	owner, foreign := connect(t, addr), connect(t, addr)
	if r := ask(t, owner, "start", sampleConfig); !r.OK {
		t.Fatal(r.Error)
	}
	if p.pid.Load() <= 0 {
		t.Fatal("not journaled")
	}
	if r := ask(t, foreign, "status"); !r.OK || r.Value.(map[string]any)["pid"] != nil {
		t.Fatal("foreign pid visible")
	}
	if r := ask(t, foreign, "stop"); r.OK {
		t.Fatal("foreign stop allowed")
	}
	if r := ask(t, owner, "reload", strings.Replace(sampleConfig, "enable: true", "enable: true, mtu: 1400", 1)); r.OK {
		t.Fatal("changed TUN in reload")
	}
	until := time.Now().Add(4 * time.Second)
	for {
		r := ask(t, owner, "logs")
		if strings.Contains(r.Value.(string), "core ready") {
			break
		}
		if time.Now().After(until) {
			t.Fatal("fake Core did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if r := ask(t, owner, "reload", sampleConfig+"mode: direct\n"); !r.OK {
		t.Fatal(r.Error)
	}
	for method, want := range map[string]int{"GET": 200, "PUT": 403} {
		c := connect(t, addr)
		target := "/version"
		if method == "PUT" {
			target = "/configs"
		}
		fmt.Fprintf(c, "\x00%s %s HTTP/1.1\r\nHost: helper\r\nAuthorization: attacker\r\nConnection: close\r\n\r\n", method, target)
		c.SetReadDeadline(time.Now().Add(4 * time.Second))
		res, e := http.ReadResponse(bufio.NewReader(c), nil)
		if e != nil {
			t.Fatal(e)
		}
		got, e := io.ReadAll(res.Body)
		res.Body.Close()
		if e != nil || res.StatusCode != want || want == 200 && !reflect.DeepEqual(got, []byte("core")) {
			t.Fatalf("%v %q %v", res.StatusCode, got, e)
		}
		c.Close()
	}
	owner.Close()
	until = time.Now().Add(4 * time.Second)
	for p.restore.Load() == 0 && time.Now().Before(until) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.restore.Load() != 1 {
		t.Fatal("owner disconnect did not clean the network")
	}
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
