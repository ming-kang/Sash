//go:build !helpercontract

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"go.yaml.in/yaml/v3"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

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
		table: strconv.Itoa(table),
	}
	return s, nil
}

type linuxNetworkSession struct {
	p           *linuxPlatform
	journal     *linuxNetworkJournal
	journalPath string
	lockDir     string
	table       string
	provenName  string
	proven      bool
}

func (s *linuxNetworkSession) snapshot(ctx context.Context) error {
	j := s.journal
	if !s.proven && j.PID > 0 {
		if name, ifindex, ok := coreTunDevice(ctx, s.p.run, j.PID, s.p.procRoot); ok {
			s.proven = true
			s.provenName = name
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
