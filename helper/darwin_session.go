//go:build darwin && !helpercontract

package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.yaml.in/yaml/v3"
)

// The crash journal records ONLY the Core's process identity and the utun it
// provably owns (attributed via the Core's own utun_control fd). Objects the
// kernel reaps with the interface — routes on the utun, the utun itself, the
// session DNS registration — are not listed: macOS removes them when the fd
// closes, so there is nothing to delete.
type tunSessionJournal struct {
	Version   int
	PID       int
	ProcStart string
	Iface     string
	CreatedAt string
}

type tunSessionJournalFile struct {
	Version   int             `json:"version"`
	PID       *int            `json:"pid"`
	ProcStart *string         `json:"procStart"`
	Iface     json.RawMessage `json:"iface"`
	CreatedAt *string         `json:"createdAt"`
}

func journalPath(workDir string) string { return filepath.Join(workDir, sessionFile) }

// Strict parse: any malformed field is "corrupt", never silently emptied.
func parseSessionJournal(raw *tunSessionJournalFile) (*tunSessionJournal, error) {
	if raw.Version != 3 || raw.PID == nil || raw.ProcStart == nil || raw.Iface == nil || raw.CreatedAt == nil {
		return nil, errors.New("TUN session journal has unsupported or missing fields")
	}
	journal := &tunSessionJournal{
		Version:   raw.Version,
		PID:       *raw.PID,
		ProcStart: *raw.ProcStart,
		CreatedAt: *raw.CreatedAt,
	}
	if string(raw.Iface) != "null" {
		if err := json.Unmarshal(raw.Iface, &journal.Iface); err != nil {
			return nil, errors.New("TUN session journal has unsupported or missing fields")
		}
	}
	return journal, nil
}

func sessionJournalValue(j tunSessionJournal) any {
	var iface *string
	if j.Iface != "" {
		iface = &j.Iface
	}
	return struct {
		Version   int     `json:"version"`
		PID       int     `json:"pid"`
		ProcStart string  `json:"procStart"`
		Iface     *string `json:"iface"`
		CreatedAt string  `json:"createdAt"`
	}{j.Version, j.PID, j.ProcStart, iface, j.CreatedAt}
}

// readSessionJournal returns nil when there is no journal; a corrupt or
// unreadable file is an error so evidence is never silently destroyed.
func readSessionJournal(workDir string) (*tunSessionJournal, error) {
	raw, err := readJournal[tunSessionJournalFile](journalPath(workDir))
	if err != nil {
		var typeError *json.UnmarshalTypeError
		if errors.As(err, &typeError) {
			return nil, errors.New("TUN session journal has unsupported or missing fields")
		}
		return nil, errors.New("TUN session journal is corrupt")
	}
	if raw == nil {
		return nil, nil
	}
	return parseSessionJournal(raw)
}

func writeSessionJournal(workDir string, j tunSessionJournal) error {
	return writeJournal(journalPath(workDir), sessionJournalValue(j))
}

// writeFileAtomic is atomicWriteFile: temp file in the same directory, sync,
// rename, then sync the directory so the write is durable.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".atomic-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return durableRename(f.Name(), path)
}

// durableRenameSync: rename + fsync of both containing directories.
func durableRename(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	for _, dir := range []string{filepath.Dir(from), filepath.Dir(to)} {
		f, err := os.Open(dir)
		if err != nil {
			return err
		}
		_ = f.Sync()
		_ = f.Close()
	}
	return nil
}

// durableRemoveFile unlinks and fsyncs the containing directory.
func durableRemoveFile(path string) error {
	if err := os.Remove(path); err != nil {
		return err
	}
	f, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

var utunUnitPattern = regexp.MustCompile(`utun_control[^\n]*?unit\s+(\d+)`)

// utunIfaceFromLsof attributes the tunnel device to THIS Core: its
// utun_control fd carries the kernel unit number (`lsof` prints `unit N`,
// interface `utun(N-1)`). This is direct evidence, not a guess from the
// route table.
func utunIfaceFromLsof(output string) string {
	match := utunUnitPattern.FindStringSubmatch(output)
	if match == nil {
		return ""
	}
	unit, err := strconv.Atoi(match[1])
	if err != nil || unit <= 0 {
		return ""
	}
	return fmt.Sprintf("utun%d", unit-1)
}

func coreUtunInterface(pid int) string {
	output, err := runCommand(context.Background(), 10*time.Second, "/usr/sbin/lsof", "-nP", "-p", strconv.Itoa(pid))
	if err != nil {
		return ""
	}
	return utunIfaceFromLsof(output)
}

// processStartTime is `ps -o lstart=`; the bool distinguishes "ps failed"
// from "ps answered empty" — callers must not guess on a failure.
func processStartTime(pid int) (string, bool) {
	output, err := runCommand(context.Background(), 10*time.Second, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(output), true
}

func pidExists(pid int) bool {
	return !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

type recordedProcessState int

const (
	stateSame recordedProcessState = iota
	stateGone
	stateReused
	stateUnknown
)

// Is the process the journal recorded still that process? A live pid is
// compared on its start time so PID reuse is never honoured.
func checkRecordedProcess(pid int, procStart string) recordedProcessState {
	if err := syscall.Kill(pid, 0); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return stateGone
		}
		return stateUnknown
	}
	start, ok := processStartTime(pid)
	if !ok {
		return stateUnknown
	}
	if start == procStart {
		return stateSame
	}
	return stateReused
}

// reapRecordedCore signals only the recorded process, and only while it
// provably IS that process; a state that cannot be determined keeps the
// journal so a live Core is never abandoned with its evidence destroyed.
func reapRecordedCore(journal *tunSessionJournal) error {
	if journal.PID <= 0 {
		return nil
	}
	// An empty recorded identity can never be re-validated: when the pid is
	// still alive there is no proof it is our Core, so the journal stays.
	var initial recordedProcessState
	if journal.ProcStart != "" {
		initial = checkRecordedProcess(journal.PID, journal.ProcStart)
	} else if pidExists(journal.PID) {
		initial = stateUnknown
	} else {
		initial = stateGone
	}
	switch initial {
	case stateUnknown:
		return fmt.Errorf("Cannot determine whether recorded Core %d still runs; keeping TUN session journal", journal.PID)
	case stateGone, stateReused:
		return nil
	}
	_ = syscall.Kill(journal.PID, syscall.SIGTERM)
	if err := waitForExit(journal, "SIGTERM"); err != nil {
		return err
	}
	// A SIGKILL is only honoured once the process is provably gone.
	return waitForExit(journal, "SIGKILL")
}

func waitForExit(journal *tunSessionJournal, signal string) error {
	if signal == "SIGKILL" {
		_ = syscall.Kill(journal.PID, syscall.SIGKILL)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := checkRecordedProcess(journal.PID, journal.ProcStart)
		if current == stateUnknown {
			return fmt.Errorf("Cannot confirm recorded Core %d exit after %s; keeping TUN session journal", journal.PID, signal)
		}
		if current != stateSame {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	if signal == "SIGTERM" {
		return nil // escalate to SIGKILL
	}
	return fmt.Errorf("recorded Core %d did not exit after SIGKILL; keeping TUN session journal", journal.PID)
}

// recoverTunSession reaps the Core a crashed helper left behind, then drops
// the journal. Kernel-owned objects are gone with the process — deleting
// them here would mean guessing at other owners' state. A corrupt journal
// or a failed reap keeps the journal and returns an error.
func recoverTunSession(workDir string) error {
	journal, err := readSessionJournal(workDir)
	if err != nil {
		return err
	}
	if journal == nil {
		return nil
	}
	if err := reapRecordedCore(journal); err != nil {
		return err
	}
	if err := durableRemoveFile(journalPath(workDir)); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[sash-helper] recovered tun session pid=%d iface=%s\n", journal.PID, journal.Iface)
	return nil
}

type darwinNetworkSession struct {
	workDir string
}

// prepareMacosNetwork builds the network session for one Core launch: the
// intent journal lands before the Core is spawned so a crash between spawn
// and attribution still reaps the right process; the utun is attributed
// only via the Core's own utun_control fd.
func prepareMacosNetwork(workDir string) (NetworkSession, error) {
	// A leftover journal means the previous helper died mid-session: recover
	// it through the same entry before doing anything else.
	if err := recoverTunSession(workDir); err != nil {
		return nil, err
	}
	intent := tunSessionJournal{Version: 3, PID: 0, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := writeSessionJournal(workDir, intent); err != nil {
		return nil, err
	}
	return &darwinNetworkSession{workDir: workDir}, nil
}

// RecordCoreStart persists the process identity FIRST: a crash while lsof
// lags must still know which Core to reap.
func (s *darwinNetworkSession) RecordCoreStart(_ context.Context, pid int) error {
	procStart, _ := processStartTime(pid)
	journal := tunSessionJournal{
		Version:   3,
		PID:       pid,
		ProcStart: procStart,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeSessionJournal(s.workDir, journal); err != nil {
		return err
	}
	// lsof can lag the spawn; retry briefly, then leave iface unattributed
	// rather than guessing from the route table.
	deadline := time.Now().Add(8 * time.Second)
	iface := coreUtunInterface(pid)
	for iface == "" && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
		iface = coreUtunInterface(pid)
	}
	if iface == "" {
		fmt.Fprintf(os.Stderr, "[sash-helper] could not attribute a utun to Core %d\n", pid)
		return nil
	}
	journal.Iface = iface
	return writeSessionJournal(s.workDir, journal)
}

func (s *darwinNetworkSession) Cleanup(_ context.Context) error {
	return recoverTunSession(s.workDir)
}

// prepareMacosConfig injects `tun.dns-mode: native` unless the profile pins
// the field; only values the paired sing-tun understands may pass.
func prepareMacosConfig(configText []byte) ([]byte, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(configText, &doc); err != nil {
		return configText, nil // not our call — the shared schema validation rejects it
	}
	tun, ok := doc["tun"].(map[string]any)
	if !ok || tun["enable"] != true {
		return configText, nil
	}
	if raw, present := tun["dns-mode"]; present {
		switch raw {
		case "native", "hijack", "disabled":
		default:
			return nil, fmt.Errorf("Unsupported tun.dns-mode %v", raw)
		}
	} else {
		tun["dns-mode"] = "native"
	}
	return yaml.Marshal(doc)
}

// installConsentedHelper is the consent-anchored install invoked elevated
// from the osascript install script only. The helper digest binds the staged
// helper to exactly the bytes the admin consented to; the Core digest is the
// one embedded in that consented helper build — callers never supply it.
func installConsentedHelper(binDir, helperSource, helperSha256, coreSource string) (string, error) {
	if !filepath.IsAbs(binDir) {
		return "", errors.New("Core bin directory must be a canonical absolute path")
	}
	real, err := filepath.EvalSymlinks(binDir)
	if err != nil || real != binDir {
		return "", errors.New("Core bin directory must be a canonical absolute path")
	}
	if err := (&darwinPlatform{}).VerifyProtectedPath(context.Background(), binDir); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(binDir, ".core-publish-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	digest := coreSHA256
	if !digestPattern.MatchString(digest) {
		return "", errors.New("No paired Core digest embedded")
	}
	stagedCore := filepath.Join(dir, "core")
	stagedHelper := filepath.Join(dir, "helper")
	if err := copyConsentedFile(helperSource, helperSha256, stagedHelper); err != nil {
		return "", err
	}
	if err := copyConsentedFile(coreSource, digest, stagedCore); err != nil {
		return "", err
	}
	for _, staged := range []string{stagedCore, stagedHelper} {
		if err := os.Chmod(staged, 0o755); err != nil {
			return "", err
		}
	}
	if err := durableRename(stagedCore, filepath.Join(binDir, "mihomo")); err != nil {
		return "", err
	}
	if err := durableRename(stagedHelper, filepath.Join(binDir, "sash-helper")); err != nil {
		return "", err
	}
	return digest, nil
}

func copyConsentedFile(source, expectedSha256, staged string) error {
	if !digestPattern.MatchString(expectedSha256) {
		return errors.New("Consented file digest required")
	}
	if err := copyProtectedInput(source, staged); err != nil {
		return err
	}
	actual, err := fileSha256(staged)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(actual), []byte(expectedSha256)) != 1 {
		return errors.New("Consented file digest mismatch")
	}
	return nil
}

// copyProtectedInput opens the source with O_NOFOLLOW, re-stats it as the
// same file, and publishes size-bounded bytes into an exclusive new file.
func copyProtectedInput(source, target string) error {
	before, err := os.Lstat(source)
	if err != nil || !before.Mode().IsRegular() {
		return errors.New("Expected a regular Core input file")
	}
	f, err := openRegular(source)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !os.SameFile(before, stat) || !stat.Mode().IsRegular() {
		return errors.New("Core input changed before opening")
	}
	if stat.Size() < 1 || stat.Size() > maxCoreSize {
		return errors.New("Invalid Core input file size")
	}
	dest, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dest, io.LimitReader(f, maxCoreSize))
	syncErr := dest.Sync()
	closeErr := dest.Close()
	return errors.Join(copyErr, syncErr, closeErr)
}

func fileSha256(path string) (string, error) {
	f, err := openRegular(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, maxCoreSize+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
