//go:build !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

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

func reapLinuxCore(journal *linuxNetworkJournal) error {
	waitGone := func(timeout time.Duration) {
		deadline := time.Now().Add(timeout)
		for coreInstanceStateOf(journal, "/proc") == coreRunning && time.Now().Before(deadline) {
			time.Sleep(160 * time.Millisecond)
		}
	}
	waitGone(8 * time.Second)
	if coreInstanceStateOf(journal, "/proc") == coreRunning && journal.PIDStart != "" {
		if start, _ := procStarttime(journal.PID, "/proc"); start == journal.PIDStart {
			if err := syscall.Kill(journal.PID, syscall.SIGKILL); err != nil &&
				!errors.Is(err, syscall.ESRCH) {
				return err
			}
		}
		waitGone(3 * time.Second)
	}
	if state := coreInstanceStateOf(journal, "/proc"); state != coreGone {
		return fmt.Errorf("core pid %d state is %s; refusing cleanup and keeping the journal",
			journal.PID, state)
	}
	return nil
}

type linuxCleanupTarget struct {
	device      string
	ifindex     int
	boundName   string
	liveByIndex map[string]any
}

// bindLinuxCleanupTarget verifies interface identity before anything is
// touched. A same-name interface with another ifindex is foreign, and network
// objects without a verified interface remain journaled.
func bindLinuxCleanupTarget(
	ctx context.Context,
	run runFunc,
	journal *linuxNetworkJournal,
) (*linuxCleanupTarget, error) {
	target := &linuxCleanupTarget{}
	if journal.Device != nil {
		target.device = *journal.Device
	}
	if journal.Ifindex != nil {
		target.ifindex = *journal.Ifindex
	}
	links, err := listAllLinks(ctx, run)
	if err != nil {
		return nil, fmt.Errorf("could not enumerate interfaces (%s); keeping the journal", err)
	}
	var sameName map[string]any
	for _, link := range links {
		name, _ := strField(link, "ifname")
		idx, _ := numField(link, "ifindex")
		if idx == target.ifindex && target.ifindex != 0 {
			target.liveByIndex = link
		}
		if name == target.device && target.device != "" {
			sameName = link
		}
	}
	if target.device != "" && target.ifindex != 0 && target.liveByIndex == nil && sameName != nil {
		idx, _ := numField(sameName, "ifindex")
		return nil, fmt.Errorf("%s now has ifindex %d, expected %d; "+
			"refusing deletes by a reused name and keeping the journal",
			target.device, idx, target.ifindex)
	}
	if target.liveByIndex != nil {
		target.boundName, _ = strField(target.liveByIndex, "ifname")
	}
	attributable := target.ifindex != 0 &&
		(target.liveByIndex != nil || (target.device != "" && sameName == nil))
	objectCount := len(journal.Rules) + len(journal.Rules6) + len(journal.Routes) + len(journal.Routes6)
	if objectCount > 0 && !attributable {
		return nil, errors.New("recorded network objects cannot be attributed to a verified interface; keeping the journal")
	}
	return target, nil
}

// deleteLinuxRules deletes only an exact, unique live match for each recorded
// rule. Routes are intentionally left to the kernel when the link is removed.
func deleteLinuxRules(
	ctx context.Context,
	run runFunc,
	journal *linuxNetworkJournal,
	target *linuxCleanupTarget,
) ([]string, error) {
	var failures []string
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
			return nil, fmt.Errorf("could not enumerate IPv%s objects (%s); keeping the journal",
				family.flag, err)
		}
		for _, recorded := range family.rules {
			expected := rebindInterfaceFields(recorded, target.boundName)
			var candidates []map[string]any
			for _, rule := range live.rules {
				if ruleMatches(rule, expected) {
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
	return failures, nil
}

func deleteLinuxDevice(
	ctx context.Context,
	run runFunc,
	target *linuxCleanupTarget,
) ([]string, error) {
	if target.device == "" || target.ifindex == 0 {
		return nil, nil
	}
	fresh, err := listAllLinks(ctx, run)
	if err != nil {
		return nil, fmt.Errorf("could not re-enumerate interfaces (%s); keeping the journal", err)
	}
	var current map[string]any
	for _, link := range fresh {
		idx, _ := numField(link, "ifindex")
		if _, ok := strField(link, "ifname"); idx == target.ifindex && ok {
			current = link
			break
		}
	}
	name, ok := strField(current, "ifname")
	if !ok {
		return nil, nil
	}
	var failures []string
	// The fdinfo record proves the Core held a TUN fd; deleting additionally
	// requires a non-persistent TUN so a shared or foreign device is left alone.
	disposable, err := isDisposableTun(ctx, run, name, target.ifindex)
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
	return failures, nil
}

// verifyLinuxCleanup requires every recorded object to be gone before the
// journal may be dropped. A recorded route destination still present in the
// live table also retains the journal.
func verifyLinuxCleanup(
	ctx context.Context,
	run runFunc,
	journal *linuxNetworkJournal,
	target *linuxCleanupTarget,
) ([]string, error) {
	var failures []string
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
			return nil, fmt.Errorf("could not re-enumerate IPv%s objects (%s); keeping the journal",
				flag, err)
		}
		var lingering []map[string]any
		for _, recorded := range wanted {
			expected := rebindInterfaceFields(recorded, target.boundName)
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
	if target.ifindex != 0 && target.liveByIndex != nil {
		after, err := listAllLinks(ctx, run)
		if err != nil {
			return nil, errors.New("could not re-enumerate interfaces; keeping the journal")
		}
		for _, link := range after {
			if idx, _ := numField(link, "ifindex"); idx == target.ifindex {
				failures = append(failures, fmt.Sprintf("device ifindex %d still present", target.ifindex))
			}
		}
	}
	return failures, nil
}

// Remove only the network objects journaled for a launch: prove the Core is
// gone, bind the recorded interface, delete exact rule matches and the verified
// device, then re-verify everything before removing the journal.
func cleanupLinuxTunNetwork(ctx context.Context, run runFunc, journalFile, lockDir string) error {
	if lockDir == "" {
		lockDir = filepath.Join(filepath.Dir(journalFile), ".cleanup.lock")
	}
	if err := acquireCleanupLock(lockDir, false); err != nil {
		return err
	}
	defer releaseCleanupLock(lockDir)

	journal, err := readLinuxJournal(journalFile)
	if err != nil || journal == nil {
		return err
	}
	if journal.Version != 2 {
		return fmt.Errorf("unsupported journal version %d; refusing cleanup and keeping the journal",
			journal.Version)
	}
	if err := reapLinuxCore(journal); err != nil {
		return err
	}
	target, err := bindLinuxCleanupTarget(ctx, run, journal)
	if err != nil {
		return err
	}

	failures, err := deleteLinuxRules(ctx, run, journal, target)
	if err != nil {
		return err
	}
	deviceFailures, err := deleteLinuxDevice(ctx, run, target)
	if err != nil {
		return err
	}
	failures = append(failures, deviceFailures...)
	if len(failures) == 0 {
		failures, err = verifyLinuxCleanup(ctx, run, journal, target)
		if err != nil {
			return err
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("partial TUN cleanup, journal kept: %s", strings.Join(failures, "; "))
	}
	return os.Remove(journalFile)
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
