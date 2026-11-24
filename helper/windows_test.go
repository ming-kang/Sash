//go:build windows && !helpercontract

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSid = "S-1-5-21-1234-5678-9012-1000"

func TestHelperPipeSddl(t *testing.T) {
	sddl, err := helperPipeSddl(testSid)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"(A;;GA;;;SY)", "(A;;GA;;;OW)",
		"(A;;0x12019b;;;" + testSid + ")",
	} {
		if !strings.Contains(sddl, want) {
			t.Fatalf("SDDL %q missing %s", sddl, want)
		}
	}
	for _, bad := range []string{
		"(A;;GA;;;" + testSid, "(A;;GRGW;;;" + testSid,
		"WD", "AU", "BU",
	} {
		if strings.Contains(sddl, bad) {
			t.Fatalf("SDDL %q unexpectedly contains %s", sddl, bad)
		}
	}
	// Client mask: no FILE_CREATE_PIPE_INSTANCE/WRITE_DAC/WRITE_OWNER/DELETE.
	if helperPipeClientRights&0x00000004 != 0 {
		t.Fatal("client rights grant FILE_APPEND_DATA (pipe instance)")
	}
	for _, bit := range []uint32{0x00040000, 0x00080000, 0x00010000} {
		if helperPipeClientRights&bit != 0 {
			t.Fatalf("client rights grant %x", bit)
		}
	}
	if helperPipeClientRights&0x00120003 != 0x00120003 {
		t.Fatal("client rights lost FILE_READ_DATA/WRITE_DATA/SYNCHRONIZE")
	}
	for _, bad := range []string{"not a sid", testSid + ";evil", "", "S-1-5-18;"} {
		if _, err := helperPipeSddl(bad); err == nil {
			t.Fatalf("helperPipeSddl(%q) should fail", bad)
		}
	}
}

func TestParseProbePayload(t *testing.T) {
	// Only an explicit adapter:null is absent.
	if p, err := parseProbePayload(`{"adapter":null,"routes":[],"dnsV4":[],"dnsV6":[]}`, "Meta"); err != nil || p != nil {
		t.Fatalf("adapter:null → (%v, %v), want absent nil", p, err)
	}
	for name, text := range map[string]string{
		"missing adapter":   `{}`,
		"not json":          `not json`,
		"adapter empty":     `{"adapter":{}}`,
		"missing routes":    `{"adapter":{"ifIndex":3,"guid":"{g}","luid":"1","status":"Up"}}`,
		"missing dns field": `{"adapter":{"ifIndex":3,"guid":"{g}","luid":"1","status":"Up"},"routes":[],"dnsV4":[]}`,
	} {
		if _, err := parseProbePayload(text, "Meta"); err == nil {
			t.Fatalf("%s: %q should be unknown (error), not absent", name, text)
		}
	}
	probe, err := parseProbePayload(
		`{"adapter":{"ifIndex":3,"guid":"{g}","luid":"1","status":"Up"},"routes":[],"dnsV4":["198.18.0.2"],"dnsV6":null}`,
		"Meta",
	)
	if err != nil {
		t.Fatal(err)
	}
	if probe.IfIndex != 3 || probe.Guid != "{g}" || probe.Luid != "1" || probe.Status != "Up" {
		t.Fatalf("bad adapter record: %+v", probe)
	}
	if len(probe.DnsV4) != 1 || probe.DnsV4[0] != "198.18.0.2" {
		t.Fatalf("bad dnsV4: %v", probe.DnsV4)
	}
	if probe.DnsV6 != nil {
		t.Fatalf("dnsV6 null must stay nil (unknown), got %v", probe.DnsV6)
	}
	// PowerShell collapses single-element arrays into bare objects.
	one, err := parseProbePayload(
		`{"adapter":{"ifIndex":3,"guid":"{g}","luid":"1","status":"Up"},`+
			`"routes":{"prefix":"0.0.0.0/0","nextHop":"198.18.0.2","family":"IPv4"},`+
			`"dnsV4":[],"dnsV6":[]}`,
		"Meta",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(one.Routes) != 1 || one.Routes[0].Prefix != "0.0.0.0/0" || one.Routes[0].NextHop != "198.18.0.2" {
		t.Fatalf("single-element route object not normalized: %+v", one.Routes)
	}
	// Multicast prefixes are skipped.
	multi, err := parseProbePayload(
		`{"adapter":{"ifIndex":3,"guid":"{g}","luid":"1","status":"Up"},`+
			`"routes":[{"prefix":"ff00::/8","nextHop":"::","family":"IPv6"},`+
			`{"prefix":"224.0.0.0/4","nextHop":"0.0.0.0","family":"IPv4"},`+
			`{"prefix":"::/0","nextHop":"fe80::1","family":"IPv6"},`+
			`{"prefix":"0.0.0.0/0","nextHop":"198.18.0.2","family":"IPv4"}],`+
			`"dnsV4":[],"dnsV6":[]}`,
		"Meta",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(multi.Routes) != 1 || len(multi.RoutesV6) != 1 {
		t.Fatalf("multicast filtering wrong: v4=%+v v6=%+v", multi.Routes, multi.RoutesV6)
	}
}

func TestNetworkJournalSchema(t *testing.T) {
	valid := `{"version":3,"pid":4321,"corePath":"C:\\Sash\\core\\bin\\mihomo-abc.exe",` +
		`"coreCreatedAt":1763300000000,"adapterName":"Meta","adapterIndex":42,` +
		`"adapterGuid":"{6A93F1C9-0000-0000-0000-000000000001}","adapterLuid":"0x80000000000000",` +
		`"routes":[{"prefix":"0.0.0.0/0","family":"v4","nextHop":"198.18.0.2"},` +
		`{"prefix":"::/0","family":"v6","nextHop":"fe80::1"}],` +
		`"dnsV4":["198.18.0.2"],"dnsV6":[],"startedAt":"2026-01-01T00:00:00Z"}`
	dir := t.TempDir()
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(journalPath(dir), []byte(text+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(valid)
	journal, err := readNetworkJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if journal.PID != 4321 || journal.AdapterIndex != 42 ||
		journal.AdapterLuid != "0x80000000000000" || len(journal.Routes) != 2 {
		t.Fatalf("bad journal: %+v", journal)
	}
	if journal.DnsV4 == nil || len(*journal.DnsV4) != 1 {
		t.Fatalf("dnsV4 must round-trip: %+v", journal.DnsV4)
	}
	if journal.DnsV6 == nil || len(*journal.DnsV6) != 0 {
		t.Fatalf("dnsV6 must round-trip as empty (not unknown): %+v", journal.DnsV6)
	}
	for name, patch := range map[string]string{
		"version":       `"version":1`,
		"adapterIndex":  `"adapterIndex":-1`,
		"route family":  `"family":"v5"`,
		"startedAt bad": `"startedAt":""`,
	} {
		bad := valid
		switch name {
		case "version":
			bad = strings.Replace(valid, `"version":3`, `"version":1`, 1)
		case "adapterIndex":
			bad = strings.Replace(valid, `"adapterIndex":42`, `"adapterIndex":-1`, 1)
		case "route family":
			bad = strings.Replace(valid, `"family":"v6"`, `"family":"v5"`, 1)
		case "startedAt bad":
			bad = strings.Replace(valid, `"startedAt":"2026-01-01T00:00:00Z"`, `"startedAt":""`, 1)
		}
		_ = patch
		write(bad)
		if _, err := readNetworkJournal(dir); err == nil {
			t.Fatalf("%s should reject", name)
		}
	}
	// Unknown fields are rejected by the shared strict decoder.
	write(strings.Replace(valid, `"startedAt"`, `"extra":true,"startedAt"`, 1))
	if _, err := readNetworkJournal(dir); err == nil {
		t.Fatal("extra key should reject")
	}
	// null DNS round-trips as unknown.
	write(strings.Replace(valid, `"dnsV4":["198.18.0.2"]`, `"dnsV4":null`, 1))
	j, err := readNetworkJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if j.DnsV4 != nil {
		t.Fatalf("dnsV4 null must stay nil, got %+v", j.DnsV4)
	}
	// Absent journal reads as nil.
	if err := os.Remove(journalPath(dir)); err != nil {
		t.Fatal(err)
	}
	if j, err := readNetworkJournal(dir); err != nil || j != nil {
		t.Fatalf("absent journal → (%v, %v)", j, err)
	}
}

func TestOwnsControllerConnection(t *testing.T) {
	table := strings.Join([]string{
		"TCP  127.0.0.1:4000  0.0.0.0:0  LISTENING  42",
		"TCP  127.0.0.1:4000  127.0.0.1:6000  ESTABLISHED  17",
		"TCP  127.0.0.1:6000  127.0.0.1:4000  ESTABLISHED  42",
		"TCP  127.0.0.1:4000  127.0.0.1:6001  ESTABLISHED  42",
	}, "\r\n")
	for _, tc := range []struct {
		port, clientPort, pid int
		want                  bool
	}{
		{4000, 6001, 42, true},
		{4000, 6000, 42, false},
		{4000, 6002, 42, false},
	} {
		if got := ownsControllerConnection(table, tc.port, tc.clientPort, tc.pid); got != tc.want {
			t.Fatalf("(%d,%d,%d) → %v, want %v", tc.port, tc.clientPort, tc.pid, got, tc.want)
		}
	}
}

func TestTunAdapterNameAndConfigValidation(t *testing.T) {
	base := "external-controller: 127.0.0.1:9090\nsecret: x\ntun: {enable: true}\n"
	if got := tunAdapterName([]byte(base)); got != "Meta" {
		t.Fatalf("default adapter %q", got)
	}
	if got := tunAdapterName([]byte(`tun: {enable: true, device: "miho-mo.tun_1"}`)); got != "miho-mo.tun_1" {
		t.Fatalf("device override %q", got)
	}
	p := &windowsPlatform{}
	if err := p.ValidateConfig(t.Context(), "mihomo.exe", []byte(base), ""); err != nil {
		t.Fatal(err)
	}
	bad := strings.Replace(base, "tun: {enable: true}", `tun: {enable: true, device: "C:\\bad"}`, 1)
	if err := p.ValidateConfig(t.Context(), "mihomo.exe", []byte(bad), ""); err == nil {
		t.Fatal("exotic device name should reject")
	}
	badWin := strings.Replace(base, "tun: {enable: true}", `tun: {enable: true, "auto-detect-interface": 3}`, 1)
	if err := p.ValidateConfig(t.Context(), "mihomo.exe", []byte(badWin), ""); err == nil {
		t.Fatal("non-boolean auto-detect-interface should reject")
	}
}

// Early-listen contract: connections must queue until RecoverNetwork
// completes, and a failed recovery exits before any dispatch.
func TestEarlyListenerContract(t *testing.T) {
	var p Platform = &windowsPlatform{}
	early, ok := p.(earlyListener)
	if !ok || !early.ListenBeforeRecovery() {
		t.Fatal("windowsPlatform must implement earlyListener")
	}
	if _, ok := p.(coreProcessPlatform); !ok {
		t.Fatal("windowsPlatform must implement coreProcessPlatform")
	}
	if _, ok := p.(controllerPeerPlatform); !ok {
		t.Fatal("windowsPlatform must implement controllerPeerPlatform")
	}
}

func TestProtectedDirLockedUnderProgramData(t *testing.T) {
	dir := helperProtectedDir()
	if !strings.HasSuffix(strings.ToLower(dir), `sash\core`) {
		t.Fatalf("protected dir %q", dir)
	}
	if !filepath.IsAbs(dir) {
		t.Fatalf("protected dir not absolute: %q", dir)
	}
}
