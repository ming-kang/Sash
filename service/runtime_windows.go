// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

type serviceRuntime struct {
	mu         sync.Mutex
	root       string
	policy     enrollment
	identity   ownership
	process    *ownedProcess
	executable windows.Handle
	secret     string
	controller string
	providers  map[string]bool
	tun        bool
	fault      error
	transport  *http.Transport
}

func (s *serviceRuntime) runtimeDir() string { return filepath.Join(s.root, "private", "runtime") }
func (s *serviceRuntime) journalPath() string {
	return filepath.Join(s.root, "private", "runtime-journal.json")
}
func (s *serviceRuntime) activePath() string { return filepath.Join(s.root, "private", "active.json") }
func (s *serviceRuntime) observe() error {
	if s.fault != nil {
		return s.fault
	}
	if s.process == nil {
		return nil
	}
	running, err := s.process.running()
	if err != nil {
		s.fault = failure("OWNERSHIP_UNCERTAIN", "Cannot observe retained Core process")
		return s.fault
	}
	if !running {
		if err = s.stopOwned(); err != nil {
			return err
		}
	}
	return nil
}
func (s *serviceRuntime) snapshot() (status, error) {
	if err := s.observe(); err != nil {
		return status{}, err
	}
	out := status{Protocol: protocol, Supported: true, Installed: true, Running: true, Compatible: true, Version: version, Root: s.policy.Root, ServiceInstance: s.identity.Instance, CoreVersion: s.policy.Core.Version, Generation: s.identity.Generation, Core: coreStatus{Running: false}}
	if s.process != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		b, code, err := s.privateRequest(ctx, "GET", "/version", nil)
		cancel()
		var health map[string]any
		if err != nil || code != 200 || decodeJSON(b, &health) != nil || !coreVersionMatches(health["version"], s.policy.Core.Version) {
			return status{}, failure("CORE_UNAVAILABLE", "Owned Core health could not be observed")
		}
		ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
		b, code, err = s.privateRequest(ctx, "GET", "/configs", nil)
		cancel()
		var config map[string]any
		var tun *bool
		if err == nil && code == 200 && decodeJSON(b, &config) == nil {
			t, _ := config["tun"].(map[string]any)
			if enabled, ok := t["enable"].(bool); ok {
				tun = &enabled
			}
		}
		out.Core = coreStatus{Running: true, PID: s.process.pid, StartedAt: s.process.started.Format(time.RFC3339Nano), Healthy: true, Version: s.policy.Core.Version, TunActive: tun}
	}
	return out, nil
}
func (s *serviceRuntime) stopOwned() error {
	if s.process == nil {
		return nil
	}
	if err := s.process.stop(); err != nil {
		s.fault = failure("OWNERSHIP_UNCERTAIN", "Cannot confirm owned Core tree termination")
		return errors.Join(s.fault, err)
	}
	s.process = nil
	s.identity.Running = false
	s.identity.Generation++
	if s.executable != 0 {
		windows.CloseHandle(s.executable)
		s.executable = 0
	}
	s.transport.CloseIdleConnections()
	if err := os.Remove(s.activePath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.fault = failure("RECOVERY_REQUIRED", "Stopped Core marker could not be cleared")
		return err
	}
	return nil
}
func (s *serviceRuntime) privateRequest(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://"+s.controller+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.secret)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.transport.RoundTrip(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxConfig+1))
	if len(b) > maxConfig {
		return nil, res.StatusCode, errors.New("oversized private controller response")
	}
	return b, res.StatusCode, err
}
func (s *serviceRuntime) ready(tun bool) error {
	deadline := time.Now().Add(20 * time.Second)
	consecutive := 0
	for time.Now().Before(deadline) {
		running, err := s.process.running()
		if err != nil {
			return err
		}
		if !running {
			return failure("CORE_EXITED", "Owned Core exited before readiness")
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		b, code, err := s.privateRequest(ctx, "GET", "/version", nil)
		good := err == nil && code == 200
		if good {
			var v struct {
				Version string `json:"version"`
				Meta    bool   `json:"meta"`
				Premium bool   `json:"premium"`
			}
			if err = decodeJSON(b, &v); err != nil || !coreVersionMatches(v.Version, s.policy.Core.Version) {
				good = false
			}
		}
		if good {
			b, code, err = s.privateRequest(ctx, "GET", "/configs", nil)
			var config map[string]any
			if err != nil || code != 200 || decodeJSON(b, &config) != nil {
				good = false
			} else {
				t, _ := config["tun"].(map[string]any)
				enabled, ok := t["enable"].(bool)
				if !ok || enabled != tun {
					good = false
				}
			}
		}
		cancel()
		if good {
			consecutive++
			if consecutive == 2 {
				return nil
			}
		} else {
			consecutive = 0
		}
		time.Sleep(250 * time.Millisecond)
	}
	return failure("CORE_UNHEALTHY", "Core did not pass two version/controller/TUN readiness observations")
}
func (s *serviceRuntime) candidate(b *bundle) (*preparedBundle, string, error) {
	p, err := prepareBundle(b, s.controller, s.secret)
	if err != nil {
		return nil, "", err
	}
	token, err := randomToken()
	if err != nil {
		return nil, "", err
	}
	dir := filepath.Join(s.root, "private", "candidate-"+token)
	if err = createPrivateDir(dir, s.policy.Owner, false); err != nil {
		return nil, "", err
	}
	if err = writePrepared(dir, p, s.policy.Owner); err != nil {
		return nil, dir, err
	}
	return p, dir, nil
}
func writePrepared(dir string, p *preparedBundle, owner string) error {
	for name, data := range p.Assets {
		dest := filepath.Join(dir, filepath.FromSlash(name))
		if err := ensureAssetDirs(dir, filepath.Dir(dest), owner); err != nil {
			return err
		}
		if err := atomicWrite(dest, data); err != nil {
			return err
		}
	}
	config, err := json.Marshal(p.Config)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, "config.json"), config)
}
func ensureAssetDirs(root, dir, owner string) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil || !filepath.IsLocal(rel) {
		return failure("UNSAFE_STORAGE", "Invalid generated asset directory")
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "." {
			continue
		}
		current = filepath.Join(current, part)
		if err = createPrivateDir(current, owner, false); err != nil {
			return err
		}
	}
	return nil
}
func (s *serviceRuntime) validateDir(dir string) error {
	exe := filepath.Join(s.root, "private", "core.exe")
	h, err := approvedFile(exe, s.policy.Core.SHA256, s.policy.Owner, false)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	if err := atomicWrite(filepath.Join(dir, "validation.log"), nil); err != nil {
		return err
	}
	child, err := spawnOwned(exe, dir, filepath.Join(dir, "validation.log"), []string{"-t", "-d", dir, "-f", filepath.Join(dir, "config.json")})
	if err != nil {
		return err
	}
	code, waitErr := child.wait(20 * time.Second)
	stopErr := child.stop()
	if waitErr != nil || stopErr != nil {
		if stopErr != nil {
			s.fault = failure("OWNERSHIP_UNCERTAIN", "Validation child termination is uncertain")
		}
		return errors.Join(waitErr, stopErr)
	}
	if code != 0 {
		return failure("INVALID_REQUEST", "Core rejected protected candidate; details retained in private validation log")
	}
	return nil
}
func (s *serviceRuntime) publish(p *preparedBundle) (*journal, error) {
	dir := s.runtimeDir()
	updates := map[string][]byte{}
	for name, data := range p.Assets {
		dest := filepath.Join(dir, filepath.FromSlash(name))
		if err := ensureAssetDirs(dir, filepath.Dir(dest), s.policy.Owner); err != nil {
			return nil, err
		}
		updates[dest] = data
	}
	b, err := json.Marshal(p.Config)
	if err != nil {
		return nil, err
	}
	updates[filepath.Join(dir, "config.json")] = b
	return beginTransaction(transactionOps(), s.journalPath(), updates)
}
func (s *serviceRuntime) launch(p *preparedBundle) (err error) {
	exe := filepath.Join(s.root, "private", "core.exe")
	h, err := approvedFile(exe, s.policy.Core.SHA256, s.policy.Owner, false)
	if err != nil {
		return err
	}
	s.executable = h
	token, err := randomToken()
	if err != nil {
		windows.CloseHandle(h)
		s.executable = 0
		return err
	}
	jobName := jobNamePrefix + token
	marker, err := json.Marshal(launchMarker{SchemaVersion: 1, JobName: jobName, ServiceInstance: s.identity.Instance, Generation: s.identity.Generation + 1, Session: s.identity.Session})
	if err != nil {
		windows.CloseHandle(h)
		s.executable = 0
		return err
	}
	if err = atomicWrite(s.activePath(), marker); err != nil {
		windows.CloseHandle(h)
		s.executable = 0
		return err
	}
	defer func() {
		if err != nil && s.process == nil {
			if s.executable != 0 {
				windows.CloseHandle(s.executable)
				s.executable = 0
			}
			if errors.Is(err, errJobCollision) {
				s.fault = failure("OWNERSHIP_UNCERTAIN", "Core job name collision; launch evidence retained")
			} else if _, recoveryErr := recoverActiveJob(s.root); recoveryErr != nil {
				s.fault = failure("OWNERSHIP_UNCERTAIN", "Failed Core launch cleanup is uncertain")
				err = errors.Join(err, recoveryErr)
			}
		}
	}()
	logPath := filepath.Join(s.root, "private", "core.log")
	if _, err = os.Stat(logPath); errors.Is(err, os.ErrNotExist) {
		if err = atomicWrite(logPath, nil); err != nil {
			windows.CloseHandle(h)
			s.executable = 0
			return err
		}
	} else if err != nil {
		windows.CloseHandle(h)
		s.executable = 0
		return err
	}
	child, err := spawnInJob(exe, s.runtimeDir(), logPath, []string{"-d", s.runtimeDir(), "-f", filepath.Join(s.runtimeDir(), "config.json")}, jobName)
	if err != nil {
		windows.CloseHandle(h)
		s.executable = 0
		return err
	}
	s.process = child
	s.transport.CloseIdleConnections()
	s.transport = ownedControllerTransport(child, s.controller)
	s.identity.Generation++
	s.identity.Running = true
	if err = s.ready(p.Tun); err != nil {
		return errors.Join(err, s.stopOwned())
	}
	s.tun = p.Tun
	s.providers = p.Providers
	return nil
}
func (s *serviceRuntime) acceptUpgrade() error {
	if s.policy.PreviousCore == nil {
		return nil
	}
	// Approval is committed before old bytes are deleted. A crash can leave an
	// unnecessary backup, but cannot leave policy referring to deleted bytes.
	prior := s.policy
	s.policy.PreviousCore = nil
	if err := saveEnrollment(s.root, s.policy); err != nil {
		s.policy = prior
		return err
	}
	_ = os.Remove(filepath.Join(s.root, "private", "core.exe.bak"))
	return nil
}
func (s *serviceRuntime) rollbackUpgrade() error {
	if s.policy.PreviousCore == nil {
		return nil
	}
	backup := filepath.Join(s.root, "private", "core.exe.bak")
	h, err := approvedFile(backup, s.policy.PreviousCore.SHA256, s.policy.Owner, false)
	if err != nil {
		return err
	}
	windows.CloseHandle(h)
	// Retain failed bytes as evidence. The protected approval transaction is
	// journalled separately and must finish before any subsequent launch.
	current := filepath.Join(s.root, "private", "core.exe")
	b, err := os.ReadFile(backup)
	if err != nil {
		return err
	}
	old, err := os.ReadFile(current)
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(s.root, "private", "core.failed.exe"), old); err != nil {
		return err
	}
	next := s.policy
	next.Core = *next.PreviousCore
	next.PreviousCore = nil
	policy, err := json.Marshal(next)
	if err != nil {
		return err
	}
	jp := filepath.Join(s.root, "private", "approval-journal.json")
	j, err := beginTransaction(transactionOps(), jp, map[string][]byte{current: b, policyPath(s.root): policy})
	if err != nil {
		return err
	}
	if err = j.commit(transactionOps(), jp); err != nil {
		return err
	}
	s.policy = next
	return nil
}
func (s *serviceRuntime) start(c command) (_ status, err error) {
	if !sessionPattern.MatchString(c.Session) {
		return status{}, failure("INVALID_REQUEST", "Invalid session")
	}
	if s.process != nil {
		if c.Session != s.identity.Session {
			return status{}, failure("CONFLICT", "Core belongs to a different session")
		}
		return s.snapshot()
	}
	var startJournal *journal
	// Every failed administrative approval start, including validation and final
	// observation failures, stops the retained child before restoring any bytes.
	defer func() {
		if err == nil {
			return
		}
		if stopErr := s.stopOwned(); stopErr != nil {
			err = errors.Join(err, stopErr)
			return
		}
		if s.fault != nil {
			return
		}
		var rollbackErr error
		if startJournal != nil {
			rollbackErr = startJournal.restore(transactionOps())
			if rollbackErr == nil {
				rollbackErr = os.Remove(s.journalPath())
				if errors.Is(rollbackErr, os.ErrNotExist) {
					rollbackErr = nil
				}
			}
		} else {
			rollbackErr = recoverTransaction(transactionOps(), s.journalPath(), filepath.Join(s.root, "private"))
		}
		upgradeErr := s.rollbackUpgrade()
		if rollbackErr != nil || upgradeErr != nil {
			s.fault = failure("RECOVERY_REQUIRED", "Failed start rollback is incomplete")
		}
		err = errors.Join(err, rollbackErr, upgradeErr)
	}()
	p, dir, err := s.candidate(c.Bundle)
	if err != nil {
		return status{}, err
	}
	if err = s.validateDir(dir); err != nil {
		return status{}, err
	}
	j, err := s.publish(p)
	startJournal = j
	if err != nil {
		return status{}, err
	}
	s.identity.Session = c.Session
	if err = s.launch(p); err != nil {
		return status{}, err
	}
	// Observe before committing approval; failed readiness/status must preserve
	// both the previous executable and the runtime rollback journal.
	out, err := s.snapshot()
	if err != nil {
		return status{}, err
	}
	if err = j.commit(transactionOps(), s.journalPath()); err != nil {
		return status{}, err
	}
	if err = s.acceptUpgrade(); err != nil {
		return status{}, err
	}
	_ = os.RemoveAll(dir)
	return out, nil
}
func (s *serviceRuntime) reload(c command) (status, error) {
	if err := s.identity.check(c); err != nil {
		return status{}, err
	}
	if s.process == nil {
		return status{}, failure("CONFLICT", "Core is not running")
	}
	p, dir, err := s.candidate(c.Bundle)
	if err != nil {
		return status{}, err
	}
	if err = s.validateDir(dir); err != nil {
		return status{}, err
	}
	j, err := s.publish(p)
	if err != nil {
		return status{}, err
	}
	reload := func() error {
		b, _ := json.Marshal(map[string]string{"path": filepath.Join(s.runtimeDir(), "config.json")})
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, code, err := s.privateRequest(ctx, "PUT", "/configs?force=true", b)
		if err != nil {
			return err
		}
		if code != 204 && code != 200 {
			return failure("RELOAD_FAILED", "Private controller rejected protected reload")
		}
		return nil
	}
	err = reload()
	if err == nil {
		err = s.ready(p.Tun)
	}
	if err != nil {
		rb := j.restore(transactionOps())
		if rb == nil {
			rb = reload()
		}
		if rb == nil {
			rb = s.ready(s.tun)
		}
		if rb != nil {
			stopErr := s.stopOwned()
			s.fault = failure("RECOVERY_REQUIRED", "Reload compensation could not restore a verified runtime")
			return status{}, errors.Join(err, rb, stopErr)
		}
		if commitErr := j.commit(transactionOps(), s.journalPath()); commitErr != nil {
			s.fault = failure("RECOVERY_REQUIRED", "Compensated reload journal could not be cleared")
			return status{}, errors.Join(err, commitErr)
		}
		return status{}, err
	}
	if err = j.commit(transactionOps(), s.journalPath()); err != nil {
		stopErr := s.stopOwned()
		s.fault = failure("RECOVERY_REQUIRED", "Reload commit is incomplete")
		return status{}, errors.Join(err, stopErr)
	}
	s.tun = p.Tun
	s.providers = p.Providers
	_ = os.RemoveAll(dir)
	return s.snapshot()
}
func (s *serviceRuntime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	locked := true
	defer func() {
		if locked {
			s.mu.Unlock()
		}
	}()
	if r.Header.Get("Content-Encoding") != "" {
		writeError(w, failure("INVALID_REQUEST", "Content encoding is not supported"))
		return
	}
	if len(r.Header.Values(rootHeader)) != 1 || !strings.EqualFold(r.Header.Get(rootHeader), s.policy.Root) {
		writeError(w, failure("ROOT_MISMATCH", "Service is enrolled to a different root"))
		return
	}
	if err := s.observe(); err != nil {
		writeError(w, err)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/sash-service/") {
		if r.URL.RawQuery != "" || r.URL.RawPath != "" {
			writeError(w, failure("INVALID_REQUEST", "Control queries/encoded paths are forbidden"))
			return
		}
		if r.Method == "GET" && r.URL.Path == "/sash-service/status" {
			out, err := s.snapshot()
			if err != nil {
				writeError(w, err)
			} else {
				writeJSON(w, out)
			}
			return
		}
		if r.Method != "POST" {
			writeError(w, failure("FORBIDDEN", "Unknown service control method"))
			return
		}
		c, err := readCommand(r)
		if err != nil {
			writeError(w, err)
			return
		}
		var out status
		switch r.URL.Path {
		case "/sash-service/validate":
			if c.Session != "" || c.ServiceInstance != "" || c.Generation != 0 {
				err = failure("INVALID_REQUEST", "Unexpected validation identity")
				break
			}
			_, dir, e := s.candidate(c.Bundle)
			err = e
			if err == nil {
				err = s.validateDir(dir)
			}
			if err == nil {
				_ = os.RemoveAll(dir)
				w.WriteHeader(204)
				return
			}
		case "/sash-service/start":
			if c.ServiceInstance != "" || c.Generation != 0 {
				err = failure("INVALID_REQUEST", "Unexpected start identity")
			} else {
				out, err = s.start(c)
			}
		case "/sash-service/stop":
			if c.Bundle != nil {
				err = failure("INVALID_REQUEST", "Stop cannot publish a bundle")
			} else if s.process == nil && sessionPattern.MatchString(c.Session) && c.Session == s.identity.Session && c.ServiceInstance == s.identity.Instance && s.identity.Generation > 0 && c.Generation == s.identity.Generation-1 {
				out, err = s.snapshot()
			} else if err = s.identity.check(c); err == nil {
				err = s.stopOwned()
				if err == nil {
					out, err = s.snapshot()
				}
			}
		case "/sash-service/reload":
			out, err = s.reload(c)
		default:
			err = failure("FORBIDDEN", "Unknown service operation")
		}
		if err != nil {
			// Do not log controller errors or request data containing private credentials.
			writeError(w, err)
		} else {
			writeJSON(w, out)
		}
		return
	}
	if s.process == nil {
		writeError(w, failure("CORE_UNAVAILABLE", "Owned Core is not running"))
		return
	}
	if err := gatewayRequest(r, s.providers); err != nil {
		writeError(w, err)
		return
	}
	target := &url.URL{Scheme: "http", Host: s.controller}
	proxy := &httputil.ReverseProxy{ErrorLog: log.New(io.Discard, "", 0), Transport: s.transport, FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Host = target.Host
		pr.Out.Header.Del(rootHeader)
		pr.Out.Header.Set("Authorization", "Bearer "+s.secret)
		pr.Out.Header.Set("Accept-Encoding", "identity")
		pr.Out.Header.Del("Origin")
		pr.Out.Header.Del("Forwarded")
		pr.Out.Header.Del("X-Forwarded-For")
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		writeError(w, failure("CORE_UNAVAILABLE", "Private controller is unavailable"))
	}, ModifyResponse: func(res *http.Response) error {
		res.Header.Del("Authorization")
		res.Header.Del("Set-Cookie")
		res.Header.Del("Location")
		if res.StatusCode >= 300 {
			res.Body.Close()
			b, _ := json.Marshal(map[string]any{"error": &wireError{"CORE_REQUEST_REJECTED", "Private controller rejected the approved request"}})
			if res.StatusCode < 400 {
				res.StatusCode = http.StatusBadGateway
				res.Status = "502 Bad Gateway"
			}
			res.Body = io.NopCloser(bytes.NewReader(b))
			res.ContentLength = int64(len(b))
			res.Header.Del("Content-Length")
			res.Header.Del("Content-Encoding")
			res.Header.Set("Content-Type", "application/json")
			return nil
		}
		if r.URL.Path == "/configs" && r.Method == "GET" {
			b, err := io.ReadAll(io.LimitReader(res.Body, maxConfig+1))
			res.Body.Close()
			if err != nil || len(b) > maxConfig {
				return errors.New("invalid private config response")
			}
			if res.StatusCode != 200 {
				return errors.New("private configs unavailable")
			}
			b, err = publicConfigs(b)
			if err != nil {
				return errors.New("invalid private config response")
			}
			res.Body = io.NopCloser(bytes.NewReader(b))
			res.ContentLength = int64(len(b))
			res.Header.Del("Content-Length")
		}
		return nil
	}}
	// Streaming telemetry must not monopolize the mutation lock. Capture the
	// immutable controller identity, then let stop/reload proceed concurrently.
	locked = false
	s.mu.Unlock()
	proxy.ServeHTTP(w, r)
}

type scmHandler struct{}

func (scmHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending, WaitHint: 15000}
	root, err := protectedRoot()
	if err != nil {
		return true, 1
	}
	p, err := loadEnrollment(root)
	if err != nil {
		return true, 2
	}
	locks, err := verifyTree(root, p.Owner)
	if err != nil {
		return true, 3
	}
	defer closeHandles(locks)
	serviceLogPath := filepath.Join(root, "private", "service.log")
	if _, e := os.Stat(serviceLogPath); errors.Is(e, os.ErrNotExist) {
		if e = atomicWrite(serviceLogPath, nil); e != nil {
			return true, 13
		}
	} else if e != nil {
		return true, 13
	}
	serviceLog, e := os.OpenFile(serviceLogPath, os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return true, 13
	}
	previousStderr := os.Stderr
	os.Stderr = serviceLog
	defer func() { os.Stderr = previousStderr; serviceLog.Close() }()
	helper, err := approvedFile(filepath.Join(root, "sash-service.exe"), p.HelperSHA256, p.Owner, true)
	if err != nil {
		return true, 4
	}
	defer windows.CloseHandle(helper)
	// SCM registration must still identify this very service, not an alternate
	// executable/account. Querying StartPending is expected during Execute.
	registered, _, err := checkedService()
	if err != nil {
		return true, 5
	}
	registered.Close()
	self, err := os.Executable()
	if err != nil || !strings.EqualFold(self, filepath.Join(root, "sash-service.exe")) {
		return true, 6
	}
	id, err := randomToken()
	if err != nil {
		return true, 7
	}
	secret, err := randomToken()
	if err != nil {
		return true, 8
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return true, 9
	}
	controller := listener.Addr().String()
	listener.Close()
	runtime := &serviceRuntime{root: root, policy: p, identity: ownership{Instance: id}, secret: secret, controller: controller, providers: map[string]bool{}, transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 30 * time.Second}}
	if marker, recoveryErr := recoverActiveJob(root); recoveryErr != nil {
		runtime.fault = failure("RECOVERY_REQUIRED", "Prior Core job recovery could not be verified")
	} else if marker != nil {
		runtime.identity.Session = marker.Session
		runtime.identity.Generation = marker.Generation + 1
	}
	if runtime.fault == nil {
		if err = recoverTransaction(transactionOps(), runtime.journalPath(), filepath.Join(root, "private")); err != nil {
			runtime.fault = err
		}
	}
	for _, name := range []string{"approval-journal.json", "install-journal.json"} {
		if _, err = os.Stat(filepath.Join(root, "private", name)); err == nil {
			runtime.fault = failure("RECOVERY_REQUIRED", "Administrative approval transaction is incomplete")
		} else if !errors.Is(err, os.ErrNotExist) {
			runtime.fault = err
		}
	}
	server, pipe, err := pipeServer(p.Owner, runtime)
	if err != nil {
		return true, 10
	}
	defer pipe.Close()
	done := make(chan error, 1)
	go func() { done <- server.Serve(pipe) }()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				runtime.mu.Lock()
				_ = runtime.stopOwned()
				runtime.mu.Unlock()
				return true, 11
			}
			return false, 0
		case <-ticker.C:
			runtime.mu.Lock()
			_ = runtime.observe()
			runtime.mu.Unlock()
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				_ = server.Close()
				runtime.mu.Lock()
				err = runtime.stopOwned()
				runtime.mu.Unlock()
				if err != nil {
					return true, 12
				}
				return false, 0
			}
		}
	}
}
