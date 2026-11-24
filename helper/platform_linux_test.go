//go:build !helpercontract

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type cannedRun struct {
	ran      *[]string
	rules    string
	v6rules  string
	routes   string
	v6routes string
	links    func() string
	detail   string
	deleted  bool
	extra    func(cmd string, args []string) (string, bool)
}

func orEmpty(out string) string {
	if out == "" {
		return "[]"
	}
	return out
}

func (c *cannedRun) run(_ context.Context, cmd string, args ...string) (string, error) {
	*c.ran = append(*c.ran, cmd+" "+strings.Join(args, " "))
	joined := strings.Join(args, " ")
	if c.extra != nil {
		if out, ok := c.extra(cmd, args); ok {
			return out, nil
		}
	}
	switch {
	case strings.Contains(joined, "link del"):
		c.deleted = true
		return "[]", nil
	case strings.Contains(joined, "-d") && strings.Contains(joined, "link show"):
		return orEmpty(c.detail), nil
	case strings.Contains(joined, "link show"):
		if c.deleted {
			return "[]", nil
		}
		return orEmpty(c.links()), nil
	case strings.Contains(joined, "route show"):
		if args[0] == "-6" {
			return orEmpty(c.v6routes), nil
		}
		return orEmpty(c.routes), nil
	case strings.Contains(joined, "rule show"):
		if args[0] == "-6" {
			return orEmpty(c.v6rules), nil
		}
		return orEmpty(c.rules), nil
	case strings.Contains(joined, "rule del"):
		if args[0] == "-6" {
			c.v6rules = "[]"
		} else {
			c.rules = "[]"
		}
		return "[]", nil
	}
	return "[]", nil
}

func tunLink(name string, ifindex int) string {
	return fmt.Sprintf(`[{"ifname":%q,"ifindex":%d,
		"linkinfo":{"info_kind":"tun","info_data":{"type":"tun","persist":false}}}]`,
		name, ifindex)
}

func journalFixture(t *testing.T, dir string, j *linuxNetworkJournal) string {
	t.Helper()
	j.Version = 2
	if j.Rules == nil {
		j.Rules = []map[string]any{}
	}
	if j.Rules6 == nil {
		j.Rules6 = []map[string]any{}
	}
	if j.Routes == nil {
		j.Routes = []map[string]any{}
	}
	if j.Routes6 == nil {
		j.Routes6 = []map[string]any{}
	}
	file := filepath.Join(dir, "network-journal.json")
	b, err := json.Marshal(j)
	if err != nil {
		t.Fatal(err)
	}
	// The strict reader requires every field key to be present.
	for _, k := range []string{"version", "pid", "pidStart", "device", "ifindex",
		"table", "rules", "rules6", "routes", "routes6"} {
		if !strings.Contains(string(b), `"`+k+`"`) {
			t.Fatalf("fixture missing %s", k)
		}
	}
	if err := os.WriteFile(file, append(b, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func devicePtr(s string) *string { return &s }
func indexPtr(i int) *int        { return &i }

func TestCleanupDeletesRecordedObjects(t *testing.T) {
	dir := t.TempDir()
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: 0, PIDStart: "", Device: devicePtr("Meta"), Ifindex: indexPtr(7), Table: "2022",
		Rules: []map[string]any{{"priority": 9000.0, "iif": "Meta", "table": "2022", "goto": 9001.0}},
		Routes: []map[string]any{
			{"dst": "198.18.0.0/30", "dev": "Meta", "protocol": "static", "table": "2022"},
		},
	})
	ran := []string{}
	c := &cannedRun{
		ran:    &ran,
		rules:  `[{"priority":9000,"iif":"Meta","table":"2022","goto":9001}]`,
		routes: `[]`,
		detail: tunLink("Meta", 7),
	}
	c.links = func() string {
		if c.deleted {
			return "[]"
		}
		return tunLink("Meta", 7)
	}
	err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(ran, "\n")
	if !strings.Contains(joined, "rule del") || !strings.Contains(joined, "link del") {
		t.Fatalf("expected rule and link deletes:\n%s", joined)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("journal should be consumed")
	}
}

func TestCleanupKeepsJournalWhenNoDeviceProof(t *testing.T) {
	dir := t.TempDir()
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: 0, Device: devicePtr("Meta"), Ifindex: indexPtr(7), Table: "2022",
	})
	c := &cannedRun{ran: &[]string{}, links: func() string { return "[]" }}
	err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("journal should be consumed when no objects recorded")
	}
}

// A recorded route whose live same-dst row no longer matches (re-bound
// nexthop object: same nhid, new dev AND gateway) keeps the journal.
func TestCleanupSameDstRebind(t *testing.T) {
	dir := t.TempDir()
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: 0, Device: devicePtr("Meta"), Ifindex: indexPtr(7), Table: "2022",
		Routes6: []map[string]any{{
			"dst": "fd00:1::/64", "dev": "Meta", "gateway": "fe80::1", "nhid": 3.0,
			"metric": 1024.0, "protocol": "static", "table": "2022",
		}},
	})
	ran := []string{}
	c := &cannedRun{
		ran: &ran,
		v6routes: `[{"dst":"fd00:1::/64","dev":"vpn0","gateway":"fe80::2","nhid":3,
			"metric":1024,"protocol":"static","table":"2022"}]`,
		links:  func() string { return tunLink("Meta", 7) },
		detail: tunLink("Meta", 7),
	}
	err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
	if err == nil || !strings.Contains(err.Error(), "journal kept") {
		t.Fatalf("expected journal kept, got %v", err)
	}
	if strings.Contains(strings.Join(ran, "\n"), "route del") {
		t.Fatal("no route del may be issued")
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("journal must be kept")
	}
}

// A re-bind arriving between the pre-check and the final dump: the same
// recorded dst still present afterwards keeps the journal.
func TestCleanupFinalDumpRebind(t *testing.T) {
	dir := t.TempDir()
	recorded := map[string]any{
		"dst": "fd00:1::/64", "dev": "Meta", "gateway": "fe80::1", "nhid": 3.0,
		"metric": 1024.0, "protocol": "static", "table": "2022",
	}
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: 0, Device: devicePtr("Meta"), Ifindex: indexPtr(7), Table: "2022",
		Routes6: []map[string]any{recorded},
	})
	rebound := false
	ran := []string{}
	c := &cannedRun{
		ran: &ran,
		links: func() string {
			if rebound {
				return "[]"
			}
			return tunLink("Meta", 7)
		},
		detail: tunLink("Meta", 7),
	}
	c.extra = func(_ string, args []string) (string, bool) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "link del"):
			rebound = true
			return "[]", true
		case strings.Contains(joined, "route show"):
			if rebound {
				return `[{"dst":"fd00:1::/64","dev":"vpn0","gateway":"fe80::2","nhid":3,
					"metric":1024,"protocol":"static","table":"2022"}]`, true
			}
			return `[{"dst":"fd00:1::/64","dev":"Meta","gateway":"fe80::1","nhid":3,
				"metric":1024,"protocol":"static","table":"2022"}]`, true
		}
		return "", false
	}
	err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
	if err == nil || !strings.Contains(err.Error(), "journal kept") {
		t.Fatalf("expected journal kept, got %v", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("journal must be kept")
	}
}

// The link delete gate: verified ifindex + info_kind/info_data.type tun
// + explicit persist:false.
func TestDisposableTunGate(t *testing.T) {
	cases := []struct {
		name   string
		detail string
		delete bool
	}{
		{"non-persistent tun", tunLink("Meta", 7), true},
		{"persistent tun", `[{"ifname":"Meta","ifindex":7,
			"linkinfo":{"info_kind":"tun","info_data":{"type":"tun","persist":true}}}]`, false},
		{"missing persist", `[{"ifname":"Meta","ifindex":7,
			"linkinfo":{"info_kind":"tun","info_data":{"type":"tun"}}}]`, false},
		{"same-name new ifindex", tunLink("Meta", 99), false},
		{"not a tun", `[{"ifname":"Meta","ifindex":7,
			"linkinfo":{"info_kind":"bridge"}}}]`, false},
		{"tap type", `[{"ifname":"Meta","ifindex":7,
			"linkinfo":{"info_kind":"tun","info_data":{"type":"tap","persist":false}}}]`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			file := journalFixture(t, dir, &linuxNetworkJournal{
				PID: 0, Device: devicePtr("Meta"), Ifindex: indexPtr(7), Table: "2022",
			})
			ran := []string{}
			c := &cannedRun{
				ran: &ran, detail: tc.detail,
				links: func() string { return tunLink("Meta", 7) },
			}
			err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
			if tc.delete {
				// No recorded objects: the disposable device is deleted and
				// the journal consumed.
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(strings.Join(ran, "\n"), "link del") {
					t.Fatal("expected link del")
				}
				if _, err := os.Stat(file); !os.IsNotExist(err) {
					t.Fatal("journal should be consumed")
				}
				return
			}
			if err == nil {
				t.Fatal("expected refusal")
			}
			if strings.Contains(strings.Join(ran, "\n"), "link del") {
				t.Fatal("no link del may be issued")
			}
			if _, err := os.Stat(file); err != nil {
				t.Fatal("journal must be kept")
			}
		})
	}
}

// A reused pid with a different starttime is gone — cleanup proceeds
// without signalling it.
func TestCleanupReusedPid(t *testing.T) {
	dir := t.TempDir()
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: os.Getpid(), PIDStart: "999999999999",
		Device: nil, Ifindex: nil, Table: "2022",
	})
	c := &cannedRun{ran: &[]string{}, links: func() string { return "[]" }}
	if err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("journal should be consumed")
	}
}

// A recorded pid that is still alive under a foreign identity refuses.
func TestCleanupAliveForeignPid(t *testing.T) {
	dir := t.TempDir()
	file := journalFixture(t, dir, &linuxNetworkJournal{
		PID: os.Getpid(), PIDStart: "",
		Device: nil, Ifindex: nil, Table: "2022",
	})
	c := &cannedRun{ran: &[]string{}, links: func() string { return "[]" }}
	err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock"))
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected refusal, got %v", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("journal must be kept")
	}
}

// A corrupt journal is an error, never "absent".
func TestCleanupCorruptJournal(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "network-journal.json")
	if err := os.WriteFile(file, []byte("{ not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := &cannedRun{ran: &[]string{}, links: func() string { return "[]" }}
	if err := cleanupLinuxTunNetwork(context.Background(), c.run, file, filepath.Join(dir, ".lock")); err == nil {
		t.Fatal("expected error")
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("journal must be kept")
	}
}

// verifyProtectedPath refuses anything a non-root writer could have
// replaced: relative paths, symlinks, and other/group-writable files.
func TestVerifyProtectedPath(t *testing.T) {
	dir := t.TempDir()
	regular := filepath.Join(dir, "sash-helper")
	if err := os.WriteFile(regular, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(regular, link); err != nil {
		t.Fatal(err)
	}
	worldWritable := filepath.Join(dir, "world")
	if err := os.WriteFile(worldWritable, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(worldWritable, 0o622); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		path string
		ok   bool
	}{
		{"relative path", "sash-helper", false},
		{"symlink leaf", link, false},
		{"world-writable leaf", worldWritable, false},
		{"non-root owned file", regular, os.Getuid() == 0},
		{"missing file", filepath.Join(dir, "gone"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := linuxVerifyProtectedPath(tc.path)
			if tc.ok && err != nil {
				t.Fatalf("expected pass, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected refusal")
			}
		})
	}
}

// copyConsentedFile is the consent anchor: the staged bytes must hash
// to the consented digest before they are published into binDir.
func TestCopyConsentedFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	payload := []byte("helper payload")
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	goodSha := hex.EncodeToString(sum[:])
	t.Run("hash match stages the file", func(t *testing.T) {
		staged := filepath.Join(dir, "staged-ok")
		if err := copyConsentedFile(src, goodSha, staged); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(staged)
		if err != nil || string(got) != string(payload) {
			t.Fatal("staged contents differ")
		}
	})
	t.Run("hash mismatch refuses", func(t *testing.T) {
		staged := filepath.Join(dir, "staged-bad")
		err := copyConsentedFile(src, strings.Repeat("0", 64), staged)
		if err == nil || !strings.Contains(err.Error(), "digest") {
			t.Fatalf("expected digest refusal, got %v", err)
		}
		if _, err := os.Stat(staged); !os.IsNotExist(err) {
			t.Fatal("a mismatched file must not be staged")
		}
	})
	t.Run("symlink input refuses", func(t *testing.T) {
		link := filepath.Join(dir, "src-link")
		if err := os.Symlink(src, link); err != nil {
			t.Fatal(err)
		}
		if err := copyConsentedFile(link, goodSha, filepath.Join(dir, "s3")); err == nil {
			t.Fatal("expected refusal")
		}
	})
	t.Run("oversize input refuses", func(t *testing.T) {
		big := filepath.Join(dir, "big")
		f, err := os.Create(big)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(maxCoreSize + 1); err != nil {
			t.Fatal(err)
		}
		f.Close()
		if err := copyConsentedFile(big, strings.Repeat("a", 64), filepath.Join(dir, "s4")); err == nil {
			t.Fatal("expected refusal")
		}
	})
}

// installConsent as a non-root caller can never publish: the bin dir
// must be canonical, root-owned and not writable by others.
func TestInstallConsentRefusesUnprotectedDir(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root-owned check cannot fail for root")
	}
	dir := t.TempDir()
	p := &linuxPlatform{binDir: dir}
	src := filepath.Join(dir, "helper-src")
	core := filepath.Join(dir, "core-src")
	for _, f := range []string{src, core} {
		if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := coreSHA256
	coreSHA256 = strings.Repeat("a", 64)
	defer func() { coreSHA256 = old }()
	if _, err := p.installConsent(src, strings.Repeat("b", 64), core); err == nil {
		t.Fatal("expected refusal on a non-root-owned bin dir")
	}
}
