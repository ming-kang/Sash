//go:build !helpercontract

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
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.yaml.in/yaml/v3"
	"golang.org/x/sys/unix"
)

const (
	linuxHelperBinDir   = "/usr/local/lib/sash"
	linuxHelperWorkDir  = "/var/lib/sash-helper"
	linuxHelperRuntime  = "/run/sash-helper"
	linuxHelperSocket   = linuxHelperRuntime + "/helper.sock"
	linuxJournalName    = "network-journal.json"
	linuxHelperUnitFile = "/etc/systemd/system/sash-helper.service"
)

type runFunc func(ctx context.Context, cmd string, args ...string) (string, error)

var errNoPeerCred = errors.New("peer credentials unavailable")

type linuxPlatform struct {
	binDir, workDir, socket string
	ownerUid                int
	hasOwner                bool
	run                     runFunc
	peerUid                 func(net.Conn) (uint32, error)
	procRoot                string
}

func newPlatform(args []string) (Platform, error) {
	p := &linuxPlatform{
		binDir:   linuxHelperBinDir,
		workDir:  linuxHelperWorkDir,
		socket:   linuxHelperSocket,
		run:      linuxRun,
		peerUid:  linuxPeerUid,
		procRoot: "/proc",
	}
	var cleanup, consent bool
	var consentSrc, consentSha, consentCore string
	for i := 0; i < len(args); i++ {
		key, value := args[i], func() string {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		switch key {
		case "--socket":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--socket requires an absolute path")
			}
			p.socket, i = value(), i+1
		case "--bin-dir":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--bin-dir requires an absolute path")
			}
			p.binDir, i = value(), i+1
		case "--work-dir":
			if !filepath.IsAbs(value()) {
				return nil, errors.New("--work-dir requires an absolute path")
			}
			p.workDir, i = value(), i+1
		case "--uid":
			uid, err := strconv.Atoi(value())
			if err != nil || uid < 0 || uid > 0xffffffff {
				return nil, errors.New("--uid requires a numeric user id")
			}
			p.ownerUid, p.hasOwner, i = uid, true, i+1
		case "--cleanup":
			cleanup = true
		case "--install-consent":
			if i+3 >= len(args) || !filepath.IsAbs(args[i+1]) ||
				!digestPattern.MatchString(args[i+2]) || !filepath.IsAbs(args[i+3]) {
				return nil, errors.New("--install-consent requires <helper-src> <helper-sha256> <core-src>")
			}
			consentSrc, consentSha, consentCore, consent, i = args[i+1], args[i+2], args[i+3], true, i+3
		default:
			return nil, fmt.Errorf("Unknown argument: %s", key)
		}
	}
	if os.Getuid() != 0 {
		return nil, errors.New("The TUN helper must run as root (systemd sash-helper.service)")
	}
	if cleanup {
		// ExecStopPost and `helper uninstall` run this in a fresh process;
		// the journal records exactly what the last launch created.
		if err := recoverLinuxTunSession(context.Background(), p.run,
			filepath.Join(p.workDir, linuxJournalName), filepath.Join(p.workDir, ".cleanup.lock")); err != nil {
			return nil, err
		}
		return nil, errDone
	}
	if consent {
		digest, err := p.installConsent(consentSrc, consentSha, consentCore)
		if err != nil {
			return nil, err
		}
		fmt.Printf("[sash-helper] installed consented pair %s\n", digest)
		return nil, errDone
	}
	_ = os.Remove(p.socket)
	return p, nil
}

func (p *linuxPlatform) BinDir() string  { return p.binDir }
func (p *linuxPlatform) WorkDir() string { return p.workDir }

func (p *linuxPlatform) Listen(context.Context) (net.Listener, error) {
	// The socket must be 0600 before any peer can see it, so set the
	// umask around bind rather than chmod afterwards. The installing
	// user is granted access through a file ACL which only root can set.
	old := unix.Umask(0o077)
	l, err := net.Listen("unix", p.socket)
	unix.Umask(old)
	if err != nil {
		return nil, err
	}
	if p.hasOwner {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "setfacl", "-m",
			fmt.Sprintf("u:%d:rw", p.ownerUid), p.socket).CombinedOutput()
		if err != nil {
			// Without the ACL no user can reach the socket — shut down
			// cleanly instead of leaving a listener nobody may connect to.
			_ = l.Close()
			_ = os.Remove(p.socket)
			return nil, fmt.Errorf("could not grant the control socket to uid %d: %s",
				p.ownerUid, strings.TrimSpace(string(out)))
		}
	}
	fmt.Printf("[sash-helper] listening on %s (bin %s, work %s)\n", p.socket, p.binDir, p.workDir)
	return l, nil
}

func (p *linuxPlatform) AuthorizePeer(conn net.Conn) bool {
	// Kernel peer-UID (SO_PEERCRED) against the installer uid, fail-
	// closed: missing credentials or an unknown owner rejects. Root is
	// always allowed; the socket file ACL is the second gate.
	uid, err := p.peerUid(conn)
	if err != nil || !p.hasOwner {
		return false
	}
	return uid == uint32(p.ownerUid) || uid == 0
}

func linuxPeerUid(conn net.Conn) (uint32, error) {
	u, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, errNoPeerCred
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *unix.Ucred
	var inner error
	if err = raw.Control(func(fd uintptr) {
		cred, inner = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if inner != nil || cred == nil {
		return 0, errNoPeerCred
	}
	return cred.Uid, nil
}

func (p *linuxPlatform) VerifyProtectedPath(_ context.Context, file string) error {
	return linuxVerifyProtectedPath(file)
}

// Everything the helper runs or reads must live on a root-owned path:
// the file itself and its direct parent directory must be owned by uid
// 0, writable only by root, and free of symbolic links.
func linuxVerifyProtectedPath(file string) error {
	if !filepath.IsAbs(file) {
		return fmt.Errorf("expected an absolute protected path: %s", file)
	}
	normalized := filepath.Clean(file)
	real, err := filepath.EvalSymlinks(normalized)
	if err != nil || real != normalized {
		return fmt.Errorf("protected path must not contain symbolic links: %s", file)
	}
	var leaf unix.Stat_t
	if err := unix.Lstat(normalized, &leaf); err != nil {
		return err
	}
	if leaf.Mode&unix.S_IFMT == unix.S_IFLNK {
		return fmt.Errorf("protected path must not contain symbolic links: %s", file)
	}
	if leaf.Mode&0o022 != 0 {
		return fmt.Errorf("protected path must not be writable by others: %s", file)
	}
	if leaf.Mode&unix.S_IFMT != unix.S_IFDIR && leaf.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("protected path must be a regular file or directory: %s", file)
	}
	for _, current := range []string{normalized, filepath.Dir(normalized)} {
		var st unix.Stat_t
		if err := unix.Lstat(current, &st); err != nil {
			return err
		}
		if st.Uid != 0 {
			return fmt.Errorf("protected path must be owned by root: %s", current)
		}
		if st.Mode&0o022 != 0 {
			return fmt.Errorf("protected path must not be writable by others: %s", current)
		}
	}
	return nil
}

// The device/table/rule coordinates mihomo will claim, from the config.
var linuxDeviceName = regexp.MustCompile(`^[\w.-]{1,15}$`)

func tunCoordinates(configText string) (device string, table, rule int) {
	device, table, rule = "Meta", 2022, 9000
	var cfg map[string]any
	if yaml.Unmarshal([]byte(configText), &cfg) != nil {
		return
	}
	tun, ok := cfg["tun"].(map[string]any)
	if !ok {
		return
	}
	if name, ok := tun["device"].(string); ok && linuxDeviceName.MatchString(name) {
		device = name
	}
	for _, pair := range []struct {
		key    string
		target *int
	}{{"iproute2-table-index", &table}, {"iproute2-rule-index", &rule}} {
		if n, ok := tun[pair.key].(int); ok && n > 0 {
			*pair.target = n
		}
		if f, ok := tun[pair.key].(float64); ok && f > 0 && f < 0xffffffff && f == float64(int(f)) {
			*pair.target = int(f)
		}
	}
	return
}

func linuxRun(ctx context.Context, cmd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, args...)
	c.Env = coreEnvironment(os.Environ())
	out, err := c.Output()
	if err != nil {
		stderr := ""
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		return "", fmt.Errorf("%s %s: %w %s %s", cmd, strings.Join(args, " "), err, out, stderr)
	}
	return string(out), nil
}

func parseIpJSON[T ~map[string]any | ~[]map[string]any](out, label string) (T, error) {
	trimmed := strings.TrimSpace(out)
	var zero T
	if trimmed == "" {
		return zero, nil
	}
	var v T
	if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
		return zero, fmt.Errorf("invalid ip(8) %s output", label)
	}
	return v, nil
}

func ipList(out, label string) ([]map[string]any, error) {
	return parseIpJSON[[]map[string]any](out, label)
}

func listObjects(v any) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func strField(m map[string]any, key string) (string, bool) {
	v, ok := m[key].(string)
	return v, ok
}

func numField(m map[string]any, key string) (int, bool) {
	switch v := m[key].(type) {
	case float64:
		return int(v), v == float64(int(v))
	case int:
		return v, true
	case json.Number:
		n, err := strconv.Atoi(string(v))
		return n, err == nil
	}
	return 0, false
}

// The exact objects this Core launch created, separately per family.
type linuxNetworkJournal struct {
	Version  int              `json:"version"`
	PID      int              `json:"pid"`
	PIDStart string           `json:"pidStart"`
	Device   *string          `json:"device"`
	Ifindex  *int             `json:"ifindex"`
	Table    string           `json:"table"`
	Rules    []map[string]any `json:"rules"`
	Rules6   []map[string]any `json:"rules6"`
	Routes   []map[string]any `json:"routes"`
	Routes6  []map[string]any `json:"routes6"`
}

func isInterfaceRule(rule map[string]any, device string) bool {
	iif, _ := strField(rule, "iif")
	oif, _ := strField(rule, "oif")
	return iif == device || oif == device
}

func isInterfaceRoute(route map[string]any, device string) bool {
	dev, _ := strField(route, "dev")
	return dev == device
}

// Kernel-proven attribution: the interface a Core process actually
// holds a TUN fd for, via /proc/<pid>/fdinfo `iff:` rows.
func coreTunDevice(ctx context.Context, run runFunc, pid int, procRoot string) (name string, ifindex int, ok bool) {
	fdinfoDir := filepath.Join(procRoot, strconv.Itoa(pid), "fdinfo")
	entries, err := os.ReadDir(fdinfoDir)
	if err != nil {
		return "", 0, false
	}
	iff := regexp.MustCompile(`(?m)^iff:\t(.+)$`)
	var names []string
	for _, entry := range entries {
		text, err := os.ReadFile(filepath.Join(fdinfoDir, entry.Name()))
		if err != nil {
			continue
		}
		if m := iff.FindSubmatch(text); m != nil {
			names = append(names, strings.TrimSpace(string(m[1])))
		}
	}
	for _, n := range names {
		out, err := run(ctx, "ip", "-j", "link", "show", "dev", n)
		if err != nil {
			continue
		}
		links, err := ipList(out, "link")
		if err != nil || len(links) == 0 {
			continue
		}
		if idx, ok := numField(links[0], "ifindex"); ok && idx != 0 {
			return n, idx, true
		}
	}
	return "", 0, false
}

// Full-object identity: every field must agree, no extra live fields.
func objectIdentical(live, recorded map[string]any) bool {
	keys := map[string]bool{}
	for k := range live {
		keys[k] = true
	}
	for k := range recorded {
		keys[k] = true
	}
	for k := range keys {
		lv, lok := live[k]
		rv, rok := recorded[k]
		if lok != rok {
			return false
		}
		lj, _ := json.Marshal(lv)
		rj, _ := json.Marshal(rv)
		if lok && string(lj) != string(rj) {
			return false
		}
	}
	return true
}

var detachedKeys = map[string]bool{"iif_detached": true, "oif_detached": true}

// `*_detached` is runtime state, not identity.
func stripDetached(rule map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range rule {
		if !detachedKeys[k] {
			out[k] = v
		}
	}
	return out
}

func ruleMatches(rule, recorded map[string]any) bool {
	return objectIdentical(stripDetached(rule), stripDetached(recorded))
}

// The complete deletable selector of a live `ip -j rule` object.
func ruleSelectorPairs(rule map[string]any) [][2]string {
	pairs := [][2]string{}
	rangeOf := func(lo, hi any) string {
		if lo == nil {
			return ""
		}
		if hi != nil && hi != lo {
			return fmt.Sprintf("%v-%v", lo, hi)
		}
		return fmt.Sprintf("%v", lo)
	}
	if _, ok := rule["not"]; ok {
		pairs = append(pairs, [2]string{"not", "not"})
	}
	if from, ok := firstPresent(rule, "from", "src"); ok {
		v := fmt.Sprintf("%v", from)
		if l, ok := rule["srclen"]; ok {
			v = fmt.Sprintf("%v/%v", v, l)
		}
		pairs = append(pairs, [2]string{"from", v})
	}
	if to, ok := firstPresent(rule, "to", "dst"); ok {
		v := fmt.Sprintf("%v", to)
		if l, ok := rule["dstlen"]; ok {
			v = fmt.Sprintf("%v/%v", v, l)
		}
		pairs = append(pairs, [2]string{"to", v})
	}
	if v, ok := rule["tos"]; ok && v != nil {
		pairs = append(pairs, [2]string{"tos", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["fwmark"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		if m, ok := rule["fwmask"]; ok && m != nil {
			s += fmt.Sprintf("/%v", m)
		}
		pairs = append(pairs, [2]string{"fwmark", s})
	}
	// The interface name is emitted even when `*_detached` is set: the
	// kernel keeps iifname after the device dies and rule_find compares.
	if v, ok := rule["iif"]; ok && v != nil {
		pairs = append(pairs, [2]string{"iif", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["oif"]; ok && v != nil {
		pairs = append(pairs, [2]string{"oif", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["l3mdev"]; ok && v != nil && v != false {
		pairs = append(pairs, [2]string{"l3mdev", "l3mdev"})
	}
	if v, ok := rule["ipproto"]; ok && v != nil {
		pairs = append(pairs, [2]string{"ipproto", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["sport_start"], rule["sport_end"]); v != "" {
		pairs = append(pairs, [2]string{"sport", v})
	} else if v, ok := rule["sport"]; ok && v != nil {
		pairs = append(pairs, [2]string{"sport", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["dport_start"], rule["dport_end"]); v != "" {
		pairs = append(pairs, [2]string{"dport", v})
	} else if v, ok := rule["dport"]; ok && v != nil {
		pairs = append(pairs, [2]string{"dport", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["uid_start"], rule["uid_end"]); v != "" {
		pairs = append(pairs, [2]string{"uidrange", v})
	} else if v, ok := rule["uidrange"]; ok && v != nil {
		pairs = append(pairs, [2]string{"uidrange", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["suppress_prefixlength"]; ok && v != nil {
		pairs = append(pairs, [2]string{"suppress_prefixlength", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["suppress_ifgroup"]; ok && v != nil {
		pairs = append(pairs, [2]string{"suppress_ifgroup", fmt.Sprintf("%v", v)})
	}
	if _, ok := rule["nop"]; ok {
		pairs = append(pairs, [2]string{"nop", "nop"})
	}
	if v, ok := numField(rule, "priority"); ok {
		pairs = append(pairs, [2]string{"pref", strconv.Itoa(v)})
	}
	if v, ok := firstPresent(rule, "table", "lookup"); ok {
		pairs = append(pairs, [2]string{"lookup", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["goto"]; ok && v != nil {
		pairs = append(pairs, [2]string{"goto", fmt.Sprintf("%v", v)})
	}
	return pairs
}

func firstPresent(m map[string]any, keys ...string) (any, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

// Rebuild a full `ip rule del` selector from a live `ip -j` rule object.
func ruleDeleteArgs(rule map[string]any) []string {
	var args []string
	for _, pair := range ruleSelectorPairs(rule) {
		if pair[0] == pair[1] {
			args = append(args, pair[0])
		} else {
			args = append(args, pair[0], pair[1])
		}
	}
	return args
}

// Whether `name` is a non-persistent TUN whose detail response answers
// for the SAME ifindex the journal verified.
func isDisposableTun(ctx context.Context, run runFunc, name string, ifindex int) (bool, error) {
	out, err := run(ctx, "ip", "-j", "-d", "link", "show", "dev", name)
	if err != nil {
		return false, err
	}
	parsed, err := ipList(out, "link")
	if err != nil {
		return false, err
	}
	if len(parsed) == 0 {
		return false, nil
	}
	entry := parsed[0]
	idx, _ := numField(entry, "ifindex")
	info, _ := entry["linkinfo"].(map[string]any)
	data, _ := info["info_data"].(map[string]any)
	return idx == ifindex &&
		info["info_kind"] == "tun" &&
		data["type"] == "tun" &&
		data["persist"] == false, nil
}

// The recorded selector re-bound to the interface's verified live name.
func rebindInterfaceFields(recorded map[string]any, boundName string) map[string]any {
	if boundName == "" {
		return recorded
	}
	merged := map[string]any{}
	for k, v := range recorded {
		merged[k] = v
	}
	for _, k := range []string{"iif", "oif", "dev"} {
		if _, ok := merged[k].(string); ok {
			merged[k] = boundName
		}
	}
	return merged
}

// Read the network journal: absent file → nil; a corrupt or
// unparseable journal is an error — never mistaken for "no record".
func readLinuxJournal(file string) (*linuxNetworkJournal, error) {
	j, err := readJournal[linuxNetworkJournal](file)
	if err != nil {
		return nil, err
	}
	if j == nil {
		return nil, nil
	}
	// Strict schema: every recorded field must be present with the right
	// type — readJournal already decodes a strict object; verify shape.
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return nil, fmt.Errorf("unparseable network journal at %s; keeping it", file)
	}
	for _, required := range []string{"version", "pid", "pidStart", "device", "ifindex",
		"table", "rules", "rules6", "routes", "routes6"} {
		if _, ok := keys[required]; !ok {
			return nil, fmt.Errorf("unparseable network journal at %s; keeping it", file)
		}
	}
	if j.Version != 2 || j.Table == "" || j.Rules == nil || j.Rules6 == nil ||
		j.Routes == nil || j.Routes6 == nil {
		return nil, fmt.Errorf("unparseable network journal at %s; keeping it", file)
	}
	return j, nil
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// The process identity token: /proc/<pid>/stat starttime (field 22).
func procStarttime(pid int, procRoot string) (string, error) {
	stat, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	s := string(stat)
	rest := strings.Fields(s[strings.LastIndexByte(s, ')')+2:])
	if len(rest) > 19 {
		return rest[19], nil
	}
	return "", nil
}

type coreInstanceState int

const (
	coreRunning coreInstanceState = iota
	coreGone
	coreUnknown
)

func (s coreInstanceState) String() string {
	return []string{"running", "gone", "unknown"}[s]
}

func coreInstanceStateOf(j *linuxNetworkJournal, procRoot string) coreInstanceState {
	if j.PID <= 0 {
		return coreGone
	}
	if j.PIDStart == "" {
		if pidAlive(j.PID) {
			return coreUnknown
		}
		return coreGone
	}
	start, err := procStarttime(j.PID, procRoot)
	if err != nil {
		return coreUnknown
	}
	if start == "" {
		return coreGone
	}
	if start == j.PIDStart {
		return coreRunning
	}
	return coreGone
}

// Cross-process cleanup mutex via atomic mkdir; a lock left by a dead
// holder is reclaimed once.
func acquireCleanupLock(dir string, stale bool) error {
	for attempt := 0; attempt < 100; attempt++ {
		if err := os.Mkdir(dir, 0o755); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.Itoa(os.Getpid())), 0o600)
			return nil
		} else if !errors.Is(err, os.ErrExist) {
			return err
		}
		holder := 0
		if b, err := os.ReadFile(filepath.Join(dir, "pid")); err == nil {
			holder, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		}
		if holder > 0 && pidAlive(holder) {
			if attempt >= 60 {
				return fmt.Errorf("cleanup is already running (pid %d)", holder)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if stale {
			return fmt.Errorf("cleanup lock held by pid %d", holder)
		}
		_ = os.RemoveAll(dir)
		stale = true
	}
	return errors.New("cleanup lock did not become available")
}

func releaseCleanupLock(dir string) {
	_ = os.RemoveAll(dir)
}

// iproute2 errors that mean the object is already gone.
var alreadyGoneRe = regexp.MustCompile(`(?i)No such process|No such file|does not exist|Cannot find device|ifindex.*does not exist`)

func isAlreadyGone(err error) bool {
	return err != nil && alreadyGoneRe.MatchString(err.Error())
}

func listAllLinks(ctx context.Context, run runFunc) ([]map[string]any, error) {
	out, err := run(ctx, "ip", "-j", "link", "show")
	if err != nil {
		return nil, err
	}
	return ipList(out, "link")
}

type netObjects struct {
	rules  []map[string]any
	routes []map[string]any
}

// Exact IPv4 (`ip`) or IPv6 (`ip -6`) rule/route tables; a kernel
// without IPv6 support yields an empty family table.
var v6UnsupportedRe = regexp.MustCompile(`(?i)address family|not supported|ipv6.*(disabled|unsupported)|EINVAL`)
var fibTableMissingRe = regexp.MustCompile(`(?i)table does not exist|FIB table`)

func listNetObjects(ctx context.Context, run runFunc, family string, table string) (netObjects, error) {
	flag := "-4"
	if family == "6" {
		// No if_inet6 means the kernel lacks IPv6 entirely; `ip -6` then
		// exits nonzero with error text that varies by iproute2 version.
		if _, err := os.Stat("/proc/net/if_inet6"); err != nil {
			return netObjects{[]map[string]any{}, []map[string]any{}}, nil
		}
		flag = "-6"
	}
	var out netObjects
	ruleText, err := run(ctx, "ip", flag, "-j", "rule", "show")
	if err != nil {
		if family == "6" && v6UnsupportedRe.MatchString(err.Error()) {
			return netObjects{[]map[string]any{}, []map[string]any{}}, nil
		}
		return out, err
	}
	if out.rules, err = ipList(ruleText, "rule"); err != nil {
		return out, err
	}
	routeText, err := run(ctx, "ip", flag, "-j", "route", "show", "table", table)
	if err != nil {
		if fibTableMissingRe.MatchString(err.Error()) {
			out.routes = []map[string]any{}
			return out, nil
		}
		return out, err
	}
	if out.routes, err = ipList(routeText, "route"); err != nil {
		return out, err
	}
	return out, nil
}

// Remove only the network objects journaled for a launch: proven-Core-
// exited first, then per-family rule deletes by exact live match and the
// device via the non-persistent-TUN gate; routes are reclaimed by the link.
func cleanupLinuxTunNetwork(ctx context.Context, run runFunc, journalFile, lockDir string) error {
	if lockDir == "" {
		lockDir = filepath.Join(filepath.Dir(journalFile), ".cleanup.lock")
	}
	if err := acquireCleanupLock(lockDir, false); err != nil {
		return err
	}
	defer releaseCleanupLock(lockDir)

	journal, err := readLinuxJournal(journalFile)
	if err != nil {
		return err
	}
	if journal == nil {
		return nil
	}
	if journal.Version != 2 {
		return fmt.Errorf("unsupported journal version %d; refusing cleanup and keeping the journal",
			journal.Version)
	}

	waitGone := func(ms time.Duration) {
		deadline := time.Now().Add(ms)
		for coreInstanceStateOf(journal, "/proc") == coreRunning && time.Now().Before(deadline) {
			time.Sleep(160 * time.Millisecond)
		}
	}
	waitGone(8000 * time.Millisecond)
	if coreInstanceStateOf(journal, "/proc") == coreRunning && journal.PIDStart != "" {
		if start, _ := procStarttime(journal.PID, "/proc"); start == journal.PIDStart {
			if err := syscall.Kill(journal.PID, syscall.SIGKILL); err != nil &&
				!errors.Is(err, syscall.ESRCH) {
				return err
			}
		}
		waitGone(3000 * time.Millisecond)
	}
	if state := coreInstanceStateOf(journal, "/proc"); state != coreGone {
		return fmt.Errorf("core pid %d state is %s; refusing cleanup and keeping the journal",
			journal.PID, state)
	}

	var failures []string
	journalDevice, journalIfindex := "", 0
	if journal.Device != nil {
		journalDevice = *journal.Device
	}
	if journal.Ifindex != nil {
		journalIfindex = *journal.Ifindex
	}

	// Verify the recorded interface identity BEFORE touching anything:
	// a same-name interface with a different ifindex is a foreign
	// replacement — the whole journal is kept instead.
	links, err := listAllLinks(ctx, run)
	if err != nil {
		return fmt.Errorf("could not enumerate interfaces (%s); keeping the journal", err)
	}
	var liveByIndex, sameName map[string]any
	ifindexByName := map[string]int{}
	for _, link := range links {
		name, _ := strField(link, "ifname")
		idx, _ := numField(link, "ifindex")
		if name != "" {
			ifindexByName[name] = idx
		}
		if idx == journalIfindex && journalIfindex != 0 {
			liveByIndex = link
		}
		if name == journalDevice && journalDevice != "" {
			sameName = link
		}
	}
	if journalDevice != "" && journalIfindex != 0 && liveByIndex == nil && sameName != nil {
		idx, _ := numField(sameName, "ifindex")
		return fmt.Errorf("%s now has ifindex %d, expected %d; "+
			"refusing deletes by a reused name and keeping the journal",
			journalDevice, idx, journalIfindex)
	}
	boundName := ""
	if liveByIndex != nil {
		boundName, _ = strField(liveByIndex, "ifname")
	}
	attributable := false
	if journalIfindex != 0 {
		attributable = liveByIndex != nil || (journalDevice != "" && sameName == nil)
	}
	if len(journal.Rules)+len(journal.Rules6)+len(journal.Routes)+len(journal.Routes6) > 0 &&
		!attributable {
		return errors.New("recorded network objects cannot be attributed to a verified interface; keeping the journal")
	}

	// Delete by exact live match only: a recorded object is deleted only
	// when exactly one live object is identical to it.
	for _, family := range []struct {
		flag  string
		rules []map[string]any
	}{
		{"4", journal.Rules}, {"6", journal.Rules6},
	} {
		if len(family.rules) == 0 {
			continue
		}
		live, err := listNetObjects(ctx, run, family.flag, journal.Table)
		if err != nil {
			return fmt.Errorf("could not enumerate IPv%s objects (%s); keeping the journal",
				family.flag, err)
		}
		for _, recorded := range family.rules {
			expected := rebindInterfaceFields(recorded, boundName)
			var candidates []map[string]any
			for _, rule := range live.rules {
				if objectIdentical(stripDetached(rule), stripDetached(expected)) {
					candidates = append(candidates, rule)
				}
			}
			if len(candidates) > 1 {
				failures = append(failures, fmt.Sprintf(
					"rule %v: cannot be uniquely identified in the live table", recorded))
				continue
			}
			if len(candidates) == 0 {
				continue
			}
			flag := "-4"
			if family.flag == "6" {
				flag = "-6"
			}
			delCmd := append([]string{flag, "rule", "del"}, ruleDeleteArgs(candidates[0])...)
			_, err := run(ctx, "ip", delCmd...)
			if err != nil && !isAlreadyGone(err) {
				failures = append(failures, fmt.Sprintf("rule %v: %s", recorded, err))
			}
		}
	}

	// Routes are never deleted one by one: the kernel reclaims them when
	// the verified link (or its already-dead ifindex) is deleted.
	if journalDevice != "" && journalIfindex != 0 {
		fresh, err := listAllLinks(ctx, run)
		if err != nil {
			return fmt.Errorf("could not re-enumerate interfaces (%s); keeping the journal", err)
		}
		var current map[string]any
		for _, link := range fresh {
			idx, _ := numField(link, "ifindex")
			if _, ok := strField(link, "ifname"); idx == journalIfindex && ok {
				current = link
				break
			}
		}
		if name, ok := strField(current, "ifname"); ok {
			// The fdinfo record proves the Core held a TUN fd; deleting
			// additionally requires a non-persistent TUN — a persistent or
			// unprovable device may be shared or foreign.
			disposable, err := isDisposableTun(ctx, run, name, journalIfindex)
			if err != nil {
				failures = append(failures, fmt.Sprintf(
					"device %s: could not verify tun type (%s)", name, err))
			} else if !disposable {
				failures = append(failures, fmt.Sprintf(
					"device %s: not a provably non-persistent TUN; leaving it", name))
			} else if _, err := run(ctx, "ip", "link", "del", "dev", name); err != nil &&
				!isAlreadyGone(err) {
				failures = append(failures, fmt.Sprintf("device %s: %s", name, err))
			}
		}
	}

	// Re-verify: every journaled object must actually be gone before the
	// journal may be dropped.
	if len(failures) == 0 {
		for _, flag := range []string{"4", "6"} {
			wanted, wantedRoutes := journal.Rules, journal.Routes
			if flag == "6" {
				wanted, wantedRoutes = journal.Rules6, journal.Routes6
			}
			if len(wanted) == 0 && len(wantedRoutes) == 0 {
				continue
			}
			live, err := listNetObjects(ctx, run, flag, journal.Table)
			if err != nil {
				return fmt.Errorf("could not re-enumerate IPv%s objects (%s); keeping the journal",
					flag, err)
			}
			var lingering []map[string]any
			for _, recorded := range wanted {
				expected := rebindInterfaceFields(recorded, boundName)
				for _, rule := range live.rules {
					if ruleMatches(rule, expected) {
						lingering = append(lingering, recorded)
						break
					}
				}
			}
			if len(lingering) > 0 {
				failures = append(failures, fmt.Sprintf("IPv%s rules still present: %v", flag, lingering))
			}
			// A live route still carrying a recorded dst keeps the journal.
			var left []map[string]any
			for _, recorded := range wantedRoutes {
				dst, _ := strField(recorded, "dst")
				for _, route := range live.routes {
					if rd, _ := strField(route, "dst"); rd == dst {
						left = append(left, recorded)
						break
					}
				}
			}
			if len(left) > 0 {
				failures = append(failures, fmt.Sprintf("IPv%s routes still present: %v", flag, left))
			}
		}
		if journalIfindex != 0 && liveByIndex != nil {
			after, err := listAllLinks(ctx, run)
			if err != nil {
				return errors.New("could not re-enumerate interfaces; keeping the journal")
			}
			for _, link := range after {
				if idx, _ := numField(link, "ifindex"); idx == journalIfindex {
					failures = append(failures, fmt.Sprintf("device ifindex %d still present", journalIfindex))
				}
			}
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("partial TUN cleanup, journal kept: %s", strings.Join(failures, "; "))
	}
	return os.Remove(journalFile)
}

// Elevated install only, from the paired helper build.
func (p *linuxPlatform) installConsent(src, sha, coreSrc string) (string, error) {
	if !digestPattern.MatchString(coreSHA256) {
		return "", errors.New("no paired Core digest embedded")
	}
	digest := coreSHA256
	if !filepath.IsAbs(p.binDir) {
		return "", errors.New("core bin directory must be a canonical absolute path")
	}
	real, err := filepath.EvalSymlinks(p.binDir)
	if err != nil || real != p.binDir {
		return "", errors.New("core bin directory must be a canonical absolute path")
	}
	if err := linuxVerifyProtectedPath(p.binDir); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(p.binDir, ".core-publish-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	stagedHelper := filepath.Join(dir, "helper")
	stagedCore := filepath.Join(dir, "core")
	if err := copyConsentedFile(src, sha, stagedHelper); err != nil {
		return "", err
	}
	if err := copyConsentedFile(coreSrc, digest, stagedCore); err != nil {
		return "", err
	}
	if err := os.Chmod(stagedCore, 0o755); err != nil {
		return "", err
	}
	if err := os.Chmod(stagedHelper, 0o755); err != nil {
		return "", err
	}
	if err := publishJournal(stagedCore, corePath(p.binDir)); err != nil {
		return "", err
	}
	if err := publishJournal(stagedHelper, filepath.Join(p.binDir, "sash-helper")); err != nil {
		return "", err
	}
	return digest, nil
}

func copyConsentedFile(src, sha, staged string) error {
	if !digestPattern.MatchString(sha) {
		return errors.New("consented file digest required")
	}
	before, err := os.Lstat(src)
	if err != nil || !before.Mode().IsRegular() {
		return errors.New("expected a regular input file")
	}
	f, err := openRegular(src)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !os.SameFile(info, before) || !info.Mode().IsRegular() {
		return errors.New("input changed before opening")
	}
	if info.Size() < 1 || info.Size() > maxCoreSize {
		return errors.New("invalid input file size")
	}
	h := sha256.New()
	out, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, f); err == nil {
		err = out.Sync()
	}
	if e := out.Close(); err == nil {
		err = e
	}
	if err != nil {
		os.Remove(staged)
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		os.Remove(staged)
		return err
	}
	if _, err := io.Copy(h, f); err != nil {
		os.Remove(staged)
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != sha {
		os.Remove(staged)
		return errors.New("consented file digest mismatch")
	}
	return nil
}

func (p *linuxPlatform) RecoverNetwork(ctx context.Context) error {
	return recoverLinuxTunSession(ctx, p.run,
		filepath.Join(p.workDir, linuxJournalName), filepath.Join(p.workDir, ".cleanup.lock"))
}

// recoverLinuxTunSession reclaims a leftover TUN session — from service
// startup (RecoverNetwork) or the one-shot --cleanup systemd runs via
// ExecStopPost after a kill — and logs the reclaimed session like the
// darwin helper's --recover path.
func recoverLinuxTunSession(ctx context.Context, run runFunc, journalFile, lockDir string) error {
	journal, err := readLinuxJournal(journalFile)
	if err != nil {
		return err
	}
	if err := cleanupLinuxTunNetwork(ctx, run, journalFile, lockDir); err != nil {
		return err
	}
	if journal != nil {
		iface := ""
		if journal.Device != nil {
			iface = *journal.Device
		}
		fmt.Fprintf(os.Stderr, "[sash-helper] recovered tun session pid=%d iface=%s\n",
			journal.PID, iface)
	}
	return nil
}

func (p *linuxPlatform) ValidateConfig(ctx context.Context, executable string, configText []byte, root string) error {
	var cfg map[string]any
	if err := yaml.Unmarshal(configText, &cfg); err != nil {
		return errors.New("invalid Core configuration")
	}
	tun, ok := cfg["tun"].(map[string]any)
	if !ok {
		return errors.New("invalid Core configuration")
	}
	if v, ok := tun["device"]; ok {
		if name, ok := v.(string); !ok || !linuxDeviceName.MatchString(name) {
			return errors.New("invalid TUN device name")
		}
	}
	if _, ok := tun["file-descriptor"]; ok {
		return errors.New("TUN file-descriptor passthrough is not supported by the helper")
	}
	// A real parse with the protected binary catches malformed fields the
	// whitelist cannot see; -t exits before touching the network.
	candidate := filepath.Join(root,
		fmt.Sprintf(".validate-%d-%d.yaml", os.Getpid(), time.Now().UnixMilli()))
	if err := os.WriteFile(candidate, configText, 0o600); err != nil {
		return err
	}
	defer os.Remove(candidate)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, executable, "-t", "-d", root, "-f", candidate).CombinedOutput()
	if err != nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) > 5 {
			lines = lines[len(lines)-5:]
		}
		detail := strings.Join(lines, " ")
		if len(detail) > 400 {
			detail = detail[:400]
		}
		if detail != "" {
			return fmt.Errorf("core rejected privileged configuration: %s", detail)
		}
		return errors.New("core rejected privileged configuration")
	}
	return nil
}

func (p *linuxPlatform) PrepareConfig(_ context.Context, configText []byte, _ string) ([]byte, error) {
	return configText, nil
}

func (p *linuxPlatform) PrepareNetwork(_ context.Context, configText []byte, workRoot string) (NetworkSession, error) {
	device, table, _ := tunCoordinates(string(configText))
	journalPath := filepath.Join(workRoot, linuxJournalName)
	lockDir := filepath.Join(workRoot, ".cleanup.lock")
	deviceCopy := device
	journal := &linuxNetworkJournal{
		Version: 2, PID: 0, PIDStart: "", Device: &deviceCopy, Ifindex: nil,
		Table: strconv.Itoa(table),
		Rules: []map[string]any{}, Rules6: []map[string]any{},
		Routes: []map[string]any{}, Routes6: []map[string]any{},
	}
	// Persist the claim immediately so a helper crash between spawn and
	// recordCoreStart still leaves a recoverable record.
	if err := writeJournal(journalPath, journal); err != nil {
		return nil, err
	}
	s := &linuxNetworkSession{
		p: p, journal: journal, journalPath: journalPath, lockDir: lockDir,
		table: strconv.Itoa(table), workRoot: workRoot,
	}
	return s, nil
}

type linuxNetworkSession struct {
	p           *linuxPlatform
	journal     *linuxNetworkJournal
	journalPath string
	lockDir     string
	table       string
	workRoot    string
	provenName  string
	provenIndex int
	proven      bool
}

func (s *linuxNetworkSession) snapshot(ctx context.Context) error {
	j := s.journal
	if !s.proven && j.PID > 0 {
		if name, ifindex, ok := coreTunDevice(ctx, s.p.run, j.PID, s.p.procRoot); ok {
			s.proven = true
			s.provenName, s.provenIndex = name, ifindex
			device := name
			j.Device = &device
			j.Ifindex = &ifindex
		}
	}
	collect := func(flag string, rules, routes *[]map[string]any) error {
		if !s.proven {
			return nil
		}
		now, err := listNetObjects(ctx, s.p.run, flag, s.table)
		if err != nil {
			return err
		}
		for _, rule := range now.rules {
			dup := false
			for _, r := range *rules {
				if ruleMatches(rule, r) {
					dup = true
					break
				}
			}
			if !dup && isInterfaceRule(rule, s.provenName) {
				*rules = append(*rules, rule)
			}
		}
		for _, route := range now.routes {
			dup := false
			for _, r := range *routes {
				if r["dst"] == route["dst"] && r["gateway"] == route["gateway"] &&
					r["dev"] == route["dev"] {
					dup = true
					break
				}
			}
			if !dup && isInterfaceRoute(route, s.provenName) {
				*routes = append(*routes, route)
			}
		}
		return nil
	}
	err := collect("4", &j.Rules, &j.Routes)
	if err == nil {
		err = collect("6", &j.Rules6, &j.Routes6)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[sash-helper] network journal snapshot failed: %s\n", err)
	}
	return writeJournal(s.journalPath, j)
}

func (s *linuxNetworkSession) RecordCoreStart(ctx context.Context, pid int) error {
	j := s.journal
	j.PID = pid
	// Pin the pid to this process instance via /proc starttime so
	// cleanup never signals or waits on a reused pid — persisted
	// immediately, before the first network enumeration.
	start, _ := procStarttime(pid, s.p.procRoot)
	j.PIDStart = start
	if err := writeJournal(s.journalPath, j); err != nil {
		return err
	}
	for attempt := 0; attempt < 10; attempt++ {
		if err := s.snapshot(ctx); err != nil {
			return err
		}
		recorded := len(j.Rules) + len(j.Rules6)
		if recorded > 0 && j.Ifindex != nil && attempt >= 3 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return nil
}

func (s *linuxNetworkSession) Cleanup(ctx context.Context) error {
	return cleanupLinuxTunNetwork(ctx, s.p.run, s.journalPath, s.lockDir)
}
