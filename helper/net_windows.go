//go:build windows && !helpercontract

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unsafe"

	yaml "go.yaml.in/yaml/v3"
	"golang.org/x/sys/windows"
)

var powershellArgs = []string{
	"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
}

func runPowershell(ctx context.Context, script string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append(append([]string{}, powershellArgs...), "-Command", script)
	out, err := exec.CommandContext(ctx, "powershell.exe", args...).Output()
	if err != nil {
		return nil, err
	}
	return out, nil
}

// probeScript is language-independent: cmdlet field access plus numeric
// AddressFamily filters, mirroring windows-shared.ts PROBE_SCRIPT_BODY.
// ObjectNotFound maps to adapter:null (absent); every other error escapes
// as unknown.
func probeScript(adapterName string) string {
	quoted, _ := json.Marshal(adapterName)
	return `
$ErrorActionPreference = 'Stop'
$name = ` + string(quoted) + `
$adapter = $null
try {
  $adapter = Get-NetAdapter -Name $name -ErrorAction Stop |
    Select-Object -First 1 @{n='ifIndex';e={$_.ifIndex}},@{n='guid';e={[string]$_.InterfaceGuid}},@{n='luid';e={[string]$_.NetLuid}},@{n='status';e={[string]$_.Status}}
} catch {
  if ($_.Exception -and $_.Exception.ErrorRecord -and $_.Exception.ErrorRecord.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
    $adapter = $null
  } elseif ($_.CategoryInfo -and $_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
    $adapter = $null
  } else {
    throw
  }
}
$routes = @()
if ($adapter) {
  $routes = @(Get-NetRoute -InterfaceIndex $adapter.ifIndex -ErrorAction Stop |
    Where-Object { $_.Store -eq 'ActiveStore' } |
    Select-Object @{n='prefix';e={$_.DestinationPrefix}},@{n='nextHop';e={$_.NextHop}},@{n='family';e={[string]$_.AddressFamily}})
}
$dns = @()
if ($adapter) {
  $dns = @(Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ErrorAction Stop |
    Select-Object @{n='family';e={$_.AddressFamily}},@{n='servers';e={@($_.ServerAddresses)}})
}
$dnsV4 = $null
$dnsV6 = $null
if ($adapter) {
  foreach ($entry in $dns) {
    if ($entry.family -eq 2) { $dnsV4 = @($entry.servers) }
    if ($entry.family -eq 23) { $dnsV6 = @($entry.servers) }
  }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ adapter = $adapter; routes = $routes; dnsV4 = $dnsV4; dnsV6 = $dnsV6 }) -Depth 4 -Compress`
}

type routeEntry struct {
	Prefix  string `json:"prefix"`
	NextHop string `json:"nextHop"`
	Family  string `json:"family"`
}

type adapterRecord struct {
	IfIndex int    `json:"ifIndex"`
	Guid    string `json:"guid"`
	Luid    string `json:"luid"`
	Status  string `json:"status"`
}

type probePayload struct {
	Adapter json.RawMessage `json:"adapter"`
	Routes  json.RawMessage `json:"routes"`
	DnsV4   json.RawMessage `json:"dnsV4"`
	DnsV6   json.RawMessage `json:"dnsV6"`
}

type adapterProbe struct {
	Name     string
	IfIndex  int
	Guid     string
	Luid     string
	Status   string
	Routes   []routeEntry // IPv4
	RoutesV6 []routeEntry // IPv6
	DnsV4    []string     // nil = unreadable (unknown), empty = confirmed none
	DnsV6    []string
}

func isSkippedPrefix(prefix string) bool {
	lower := strings.ToLower(prefix)
	return strings.HasPrefix(lower, "ff") ||
		strings.HasPrefix(lower, "224.") ||
		strings.HasPrefix(lower, "255.")
}

func decodeStringList(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}, nil
	}
	return nil, errors.New("expected a string array")
}

func decodeRoutes(raw json.RawMessage) ([]routeEntry, error) {
	if len(raw) == 0 {
		return nil, errors.New("missing routes")
	}
	if string(raw) == "null" {
		return []routeEntry{}, nil
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		var single json.RawMessage
		if err := json.Unmarshal(raw, &single); err != nil {
			return nil, err
		}
		list = []json.RawMessage{single}
	}
	out := make([]routeEntry, 0, len(list))
	for _, item := range list {
		var entry routeEntry
		if err := json.Unmarshal(item, &entry); err != nil {
			return nil, err
		}
		if entry.Prefix == "" {
			return nil, errors.New("route without a prefix")
		}
		out = append(out, entry)
	}
	return out, nil
}

// parseProbePayload parses the PowerShell JSON. Only an explicit
// adapter:null means "absent"; missing keys or malformed payloads are
// unknown (error) — never read as absent.
func parseProbePayload(text, adapterName string) (*adapterProbe, error) {
	var payload probePayload
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, fmt.Errorf("probe output unparseable: %w", err)
	}
	if payload.Adapter == nil {
		return nil, errors.New("malformed payload: missing adapter field")
	}
	if payload.Routes == nil || payload.DnsV4 == nil || payload.DnsV6 == nil {
		return nil, errors.New("incomplete payload: missing routes or dns fields")
	}
	if string(bytes.TrimSpace(payload.Adapter)) == "null" {
		return nil, nil
	}
	var rec adapterRecord
	if err := json.Unmarshal(payload.Adapter, &rec); err != nil || rec.IfIndex == 0 {
		return nil, errors.New("malformed adapter record")
	}
	routes, err := decodeRoutes(payload.Routes)
	if err != nil {
		return nil, fmt.Errorf("malformed routes: %w", err)
	}
	dnsV4, err := decodeStringList(payload.DnsV4)
	if err != nil {
		return nil, fmt.Errorf("malformed dnsV4: %w", err)
	}
	dnsV6, err := decodeStringList(payload.DnsV6)
	if err != nil {
		return nil, fmt.Errorf("malformed dnsV6: %w", err)
	}
	probe := &adapterProbe{
		Name: adapterName, IfIndex: rec.IfIndex, Guid: rec.Guid,
		Luid: rec.Luid, Status: rec.Status, DnsV4: dnsV4, DnsV6: dnsV6,
	}
	for _, r := range routes {
		if isSkippedPrefix(r.Prefix) {
			continue
		}
		if strings.EqualFold(r.Family, "IPv6") {
			probe.RoutesV6 = append(probe.RoutesV6, r)
		} else {
			probe.Routes = append(probe.Routes, r)
		}
	}
	return probe, nil
}

// probeAdapter runs the single PowerShell probe; nil = adapter absent
// (proof), error = unknown.
func probeAdapter(ctx context.Context, adapterName string) (*adapterProbe, error) {
	out, err := runPowershell(ctx, probeScript(adapterName), 20*time.Second)
	if err != nil {
		return nil, fmt.Errorf("adapter probe failed: %w", err)
	}
	return parseProbePayload(string(out), adapterName)
}

// --- journal ---

type journalRoute struct {
	Prefix  string `json:"prefix"`
	Family  string `json:"family"`
	NextHop string `json:"nextHop,omitempty"`
}

type windowsJournal struct {
	Version       int            `json:"version"`
	PID           int            `json:"pid"`
	CorePath      string         `json:"corePath"`
	CoreCreatedAt int64          `json:"coreCreatedAt"`
	AdapterName   string         `json:"adapterName"`
	AdapterIndex  int            `json:"adapterIndex"`
	AdapterGuid   string         `json:"adapterGuid"`
	AdapterLuid   string         `json:"adapterLuid"`
	Routes        []journalRoute `json:"routes"`
	// nil = unreadable at start (unknown); empty = confirmed none.
	DnsV4     *[]string `json:"dnsV4"`
	DnsV6     *[]string `json:"dnsV6"`
	StartedAt string    `json:"startedAt"`
}

func journalPath(workDir string) string {
	return filepath.Join(workDir, networkJournal)
}

func readNetworkJournal(workDir string) (*windowsJournal, error) {
	journal, err := readJournal[windowsJournal](journalPath(workDir))
	if err != nil {
		return nil, err
	}
	if journal == nil {
		return nil, nil
	}
	if journal.Version != 3 || journal.PID <= 0 || journal.AdapterIndex <= 0 ||
		journal.CorePath == "" || journal.AdapterName == "" ||
		journal.AdapterGuid == "" || journal.AdapterLuid == "" ||
		journal.StartedAt == "" {
		return nil, errors.New("Corrupt network journal: invalid fields")
	}
	for _, r := range journal.Routes {
		if r.Family != "v4" && r.Family != "v6" {
			return nil, errors.New("Corrupt network journal: invalid route family")
		}
	}
	return journal, nil
}

// --- reclaim ---

func normalizePath(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, `\`, "/"))
}

// killIfOurCore kills the journaled Core only when provably ours: image
// path + creation FILETIME off one stable kernel handle.
func killIfOurCore(journal *windowsJournal) error {
	proc, err := openProcessHandle(journal.PID)
	if err != nil {
		return err
	}
	if proc == nil {
		return nil
	}
	defer proc.close()
	// An exited process can still be opened while another handle keeps it alive.
	if proc.waitExit(0) {
		return nil
	}
	image, err := proc.imagePath()
	if err != nil {
		if proc.waitExit(0) {
			return nil
		}
		return fmt.Errorf("could not read image of journaled Core %d: %w", journal.PID, err)
	}
	createdAt, err := proc.createdAt()
	if err != nil {
		if proc.waitExit(0) {
			return nil
		}
		return fmt.Errorf("could not read creation time of journaled Core %d: %w", journal.PID, err)
	}
	if normalizePath(image) != normalizePath(journal.CorePath) ||
		createdAt != journal.CoreCreatedAt {
		return nil // recycled PID — not ours to kill
	}
	if !proc.terminate(10 * time.Second) {
		return fmt.Errorf("Core process %d did not exit", journal.PID)
	}
	return nil
}

// probeOurAdapter proves the probed adapter is the journaled one via
// GUID+LUID. Unknown identity is an error — never treated as gone.
func probeOurAdapter(ctx context.Context, journal *windowsJournal) (*adapterProbe, bool, error) {
	probe, err := probeAdapter(ctx, journal.AdapterName)
	if err != nil {
		return nil, false, err
	}
	if probe == nil {
		return nil, false, nil // adapter absent — kernel already tore it down
	}
	if probe.Guid == "" || probe.Luid == "" {
		return nil, false, fmt.Errorf(
			"adapter %s exists but its identity cannot be read; leaving the journal",
			journal.AdapterName,
		)
	}
	ours := strings.EqualFold(probe.Guid, journal.AdapterGuid) &&
		probe.Luid == journal.AdapterLuid
	return probe, ours, nil
}

func routePresent(routes []routeEntry, prefix, nextHop string) bool {
	for _, r := range routes {
		if r.Prefix == prefix && (nextHop == "" || r.NextHop == nextHop) {
			return true
		}
	}
	return false
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	as, bs := append([]string{}, a...), append([]string{}, b...)
	sort.Strings(as)
	sort.Strings(bs)
	return strings.Join(as, ",") == strings.Join(bs, ",")
}

func stringContains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// reclaimJournaledNetwork reclaims exactly the journaled objects.
// strict=false: best-effort, journal dropped only when a final probe proves
// nothing is left. strict=true: ambiguity or leftovers reject; the journal
// is kept.
func reclaimJournaledNetwork(ctx context.Context, journal *windowsJournal, workDir string, strict bool) error {
	if err := killIfOurCore(journal); err != nil {
		return err
	}
	probe, ours, err := probeOurAdapter(ctx, journal)
	if err != nil {
		return err
	}
	if probe != nil && !ours {
		// Foreign adapter holding our alias — never touch its objects.
		if strict {
			return fmt.Errorf(
				"adapter %s GUID/LUID is not the journaled one; leaving it and the journal",
				journal.AdapterName,
			)
		}
		return nil
	}
	if probe != nil {
		deadline := time.Now().Add(5 * time.Second)
		for probe != nil && probe.Status != "Up" && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(400 * time.Millisecond):
			}
			probe, ours, err = probeOurAdapter(ctx, journal)
			if err != nil {
				return err
			}
			if probe != nil && !ours {
				if strict {
					return fmt.Errorf(
						"adapter %s was recreated by a foreign provider", journal.AdapterName,
					)
				}
				return nil
			}
		}
	}
	dnsLeftover := false
	if probe != nil {
		for _, route := range journal.Routes {
			pool := probe.Routes
			if route.Family == "v6" {
				pool = probe.RoutesV6
			}
			if !routePresent(pool, route.Prefix, route.NextHop) {
				continue
			}
			args := []string{
				"interface", map[bool]string{true: "ipv6", false: "ipv4"}[route.Family == "v6"],
				"delete", "route", "prefix=" + route.Prefix,
				fmt.Sprintf("interface=%d", probe.IfIndex),
			}
			if route.NextHop != "" {
				args = append(args, "nexthop="+route.NextHop)
			}
			args = append(args, "store=active")
			if out, err := exec.CommandContext(ctx, "netsh.exe", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("netsh route delete failed: %w: %s", err, out)
			}
		}
		families := []struct {
			family    string
			journaled *[]string
			current   []string
		}{
			{"ipv4", journal.DnsV4, probe.DnsV4},
			{"ipv6", journal.DnsV6, probe.DnsV6},
		}
		for _, f := range families {
			if f.journaled == nil {
				fmt.Printf("[reclaim] %s DNS on %s was not recorded at start; "+
					"leaving it and keeping the journal\n", f.family, journal.AdapterName)
				dnsLeftover = true
				continue
			}
			if len(*f.journaled) == 0 {
				continue
			}
			if f.current == nil {
				fmt.Printf("[reclaim] %s DNS on %s could not be read; "+
					"leaving it and keeping the journal\n", f.family, journal.AdapterName)
				dnsLeftover = true
				continue
			}
			if sameStringSet(f.current, *f.journaled) {
				out, err := exec.CommandContext(ctx, "netsh.exe",
					"interface", f.family, "set", "dnsservers",
					"name="+journal.AdapterName, "dhcp",
				).CombinedOutput()
				if err != nil {
					return fmt.Errorf("netsh dns reset failed: %w: %s", err, out)
				}
			} else {
				partial := false
				for _, d := range *f.journaled {
					if stringContains(f.current, d) {
						partial = true
						break
					}
				}
				if partial {
					fmt.Printf("[reclaim] %s DNS on %s was modified externally "+
						"(%s); leaving it and keeping the journal\n",
						f.family, journal.AdapterName, strings.Join(f.current, ", "))
					dnsLeftover = true
				}
			}
		}
		after, afterOurs, err := probeOurAdapter(ctx, journal)
		if err != nil {
			return err
		}
		if after != nil && afterOurs {
			leftover := false
			for _, r := range journal.Routes {
				pool := after.Routes
				if r.Family == "v6" {
					pool = after.RoutesV6
				}
				if routePresent(pool, r.Prefix, r.NextHop) {
					leftover = true
				}
			}
			dnsReverify := func(j *[]string, cur []string) bool {
				if j == nil {
					return cur != nil // null recorded, now readable — unknown state
				}
				if len(*j) == 0 {
					return false
				}
				if cur == nil {
					return true // now unreadable — unknown
				}
				for _, d := range *j {
					if stringContains(cur, d) {
						return true
					}
				}
				return false
			}
			leftover = leftover ||
				dnsReverify(journal.DnsV4, after.DnsV4) ||
				dnsReverify(journal.DnsV6, after.DnsV6)
			if leftover {
				if strict {
					return fmt.Errorf(
						"journaled objects on %s were not reclaimed", journal.AdapterName,
					)
				}
				return nil
			}
		}
	}
	if dnsLeftover {
		if strict {
			return fmt.Errorf(
				"externally modified DNS on %s; keeping the journal", journal.AdapterName,
			)
		}
		return nil
	}
	if err := os.Remove(journalPath(workDir)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// cleanupNetworkJournal is the tolerant path for stop/uninstall; returns
// true when the journal still exists afterwards.
func cleanupNetworkJournal(ctx context.Context, workDir string) (bool, error) {
	journal, err := readNetworkJournal(workDir)
	if err != nil {
		return false, err
	}
	if journal == nil {
		return false, nil
	}
	if err := reclaimJournaledNetwork(ctx, journal, workDir, false); err != nil {
		return false, err
	}
	_, statErr := os.Stat(journalPath(workDir))
	return statErr == nil, nil
}

// RecoverNetwork is the strict reclaim run before the service accepts work.
func (p *windowsPlatform) RecoverNetwork(ctx context.Context) error {
	journal, err := readNetworkJournal(p.workDir)
	if err != nil {
		return err
	}
	if journal == nil {
		return nil
	}
	if err := reclaimJournaledNetwork(ctx, journal, p.workDir, true); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[sash-helper] recovered tun session pid=%d iface=%s\n", journal.PID, journal.AdapterName)
	return nil
}

// --- config ---

var tunDevicePattern = regexp.MustCompile(`^[\w.-]{1,64}$`)

// tunAdapterName mirrors the TS: mihomo names its adapter "Meta" unless
// tun.device overrides it.
func tunAdapterName(configText []byte) string {
	var parsed map[string]any
	if err := yaml.Unmarshal(configText, &parsed); err != nil {
		return "Meta"
	}
	tun, ok := parsed["tun"].(map[string]any)
	if !ok {
		return "Meta"
	}
	if device, ok := tun["device"].(string); ok && tunDevicePattern.MatchString(device) {
		return device
	}
	return "Meta"
}

func (p *windowsPlatform) ValidateConfig(_ context.Context, _ string, configBytes []byte, _ string) error {
	var parsed map[string]any
	if err := yaml.Unmarshal(configBytes, &parsed); err != nil {
		return nil // shared policy already handles malformed configs
	}
	tun, ok := parsed["tun"].(map[string]any)
	if !ok {
		return nil
	}
	if device, present := tun["device"]; present {
		name, ok := device.(string)
		if !ok || !tunDevicePattern.MatchString(name) {
			return errors.New("TUN device name must be a simple interface alias")
		}
	}
	if v, present := tun["auto-detect-interface"]; present {
		if _, ok := v.(bool); !ok {
			return errors.New("tun.auto-detect-interface must be a boolean")
		}
	}
	return nil
}

func (p *windowsPlatform) PrepareConfig(_ context.Context, configBytes []byte, _ string) ([]byte, error) {
	return configBytes, nil
}

// --- protected path verification ---

// FileSystemRights bits the TS WRITE_RIGHTS regex covered: any of these in
// an Allow ACE for a non-safe principal fails the audit.
const writeAccessMask = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA |
	windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES |
	0x40 /* FILE_DELETE_CHILD */ | windows.DELETE |
	windows.WRITE_DAC | windows.WRITE_OWNER |
	windows.GENERIC_WRITE | windows.GENERIC_ALL

func isReparse(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return true, nil
	}
	if attrs, ok := info.Sys().(*windows.Win32FileAttributeData); ok {
		return attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0, nil
	}
	return false, nil
}

func sidSafe(sid string) bool {
	return sid == sidLocalSystem || sid == sidAdministrators ||
		strings.HasPrefix(sid, sidTrustedInstallerPre)
}

// auditEntry checks one path's owner + DACL (TS auditEntry equivalent).
func auditEntry(path string) error {
	reparse, err := isReparse(path)
	if err != nil {
		return err
	}
	if reparse {
		return fmt.Errorf("protected path component must not be a link or reparse point: %s", path)
	}
	sd, err := windows.GetNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("could not audit %s: %w", path, err)
	}
	if sd == nil {
		return fmt.Errorf("could not audit %s: no security descriptor", path)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !sidSafe(owner.String()) {
		return fmt.Errorf(
			"protected path component is not owned by SYSTEM/Administrators: %s (owner %v)",
			path, owner,
		)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return nil // empty DACL grants nothing
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		sidStr := sid.String()
		if sidSafe(sidStr) {
			continue
		}
		if ace.Mask&writeAccessMask != 0 {
			return fmt.Errorf("protected path grants write rights to %s: %s", sidStr, path)
		}
	}
	return nil
}

// VerifyProtectedPath is the FlClash-style check: the file and its direct
// parent must not be links, must be admin-owned, and must not grant write
// rights to non-admin principals. No whole-ancestor walk.
func (p *windowsPlatform) VerifyProtectedPath(_ context.Context, file string) error {
	if _, err := os.Lstat(file); err != nil {
		return err
	}
	if err := auditEntry(file); err != nil {
		return err
	}
	return auditEntry(filepath.Dir(file))
}

// verifyPreCreatePath is the pre-creation gate: existing components must
// not be links/reparse points (ownership resets happen later in install).
func verifyPreCreatePath(path string) error {
	if reparse, err := isReparse(path); err == nil && reparse {
		return fmt.Errorf("protected path component must not be a link or reparse point: %s", path)
	}
	parent := filepath.Dir(path)
	if _, err := os.Lstat(parent); err == nil {
		if reparse, err := isReparse(parent); err == nil && reparse {
			return fmt.Errorf(
				"protected path component must not be a link or reparse point: %s", parent,
			)
		}
	}
	return nil
}

// --- network session ---

type windowsNetworkSession struct {
	workDir        string
	adapterName    string
	job            windows.Handle
	journalWritten bool
}

func (s *windowsNetworkSession) RecordCoreStart(ctx context.Context, pid int) error {
	job, err := assignCoreToKillJob(pid)
	if err != nil {
		return err
	}
	s.job = job
	ok := false
	defer func() {
		if !ok {
			windows.CloseHandle(s.job)
			s.job = 0
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	var probe *adapterProbe
	for time.Now().Before(deadline) {
		var err error
		probe, err = probeAdapter(ctx, s.adapterName)
		if err != nil {
			return err
		}
		if probe != nil && probe.Guid != "" {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	if probe == nil || probe.Guid == "" {
		return fmt.Errorf("TUN adapter %s did not appear", s.adapterName)
	}
	image, createdAt, alive, err := processIdentity(pid)
	if err != nil {
		return err
	}
	if !alive {
		return fmt.Errorf("Core process %d is not running", pid)
	}
	// Preserve unknown (nil) — never degrade it to "confirmed empty".
	journal := windowsJournal{
		Version:       3,
		PID:           pid,
		CorePath:      image,
		CoreCreatedAt: createdAt,
		AdapterName:   probe.Name,
		AdapterIndex:  probe.IfIndex,
		AdapterGuid:   probe.Guid,
		AdapterLuid:   probe.Luid,
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	if probe.DnsV4 != nil {
		v := probe.DnsV4
		journal.DnsV4 = &v
	}
	if probe.DnsV6 != nil {
		v := probe.DnsV6
		journal.DnsV6 = &v
	}
	for _, r := range probe.Routes {
		journal.Routes = append(journal.Routes,
			journalRoute{Prefix: r.Prefix, Family: "v4", NextHop: r.NextHop})
	}
	for _, r := range probe.RoutesV6 {
		journal.Routes = append(journal.Routes,
			journalRoute{Prefix: r.Prefix, Family: "v6", NextHop: r.NextHop})
	}
	if err := writeJournal(journalPath(s.workDir), journal); err != nil {
		return err
	}
	s.journalWritten = true
	ok = true
	return nil
}

func (s *windowsNetworkSession) Cleanup(ctx context.Context) error {
	if s.job != 0 {
		windows.CloseHandle(s.job)
		s.job = 0
	}
	if !s.journalWritten {
		journal, err := readNetworkJournal(s.workDir)
		if err == nil && journal == nil {
			return nil
		}
	}
	_, err := cleanupNetworkJournal(ctx, s.workDir)
	return err
}

// PrepareNetwork refuses to take over an adapter another provider created;
// a failed probe is UNKNOWN and rejects the start.
func (p *windowsPlatform) PrepareNetwork(ctx context.Context, configBytes []byte, workDir string) (NetworkSession, error) {
	adapterName := tunAdapterName(configBytes)
	existing, err := probeAdapter(ctx, adapterName)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fmt.Errorf(
			"TUN adapter %s already exists (owned by another provider)", adapterName,
		)
	}
	return &windowsNetworkSession{workDir: workDir, adapterName: adapterName}, nil
}
