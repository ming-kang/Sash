// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"
)

func recoveryFixture(t *testing.T) (string, launchMarker) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("SYSTEM/Admin-only recovery objects require elevation; no SCM/Core exercised")
	}
	root := t.TempDir()
	if err := createPrivateDir(filepath.Join(root, "private"), "", false); err != nil {
		t.Fatal(err)
	}
	token, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	marker := launchMarker{1, jobNamePrefix + token, strings.Repeat("b", 64), strings.Repeat("a", 64), 7}
	b, _ := json.Marshal(marker)
	if err = atomicWrite(filepath.Join(root, "private", "active.json"), b); err != nil {
		t.Fatal(err)
	}
	return root, marker
}
func TestRecoveryBeforeJobCreation(t *testing.T) {
	root, marker := recoveryFixture(t)
	recovered, err := recoverActiveJob(root)
	if err != nil || recovered == nil || *recovered != marker {
		t.Fatalf("launch intent recovery: %+v %v", recovered, err)
	}
	if _, err = os.Stat(filepath.Join(root, "private", "active.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("marker retained", err)
	}
}
func TestRecoveryTerminatesOnlyNamedJob(t *testing.T) {
	root, marker := recoveryFixture(t)
	exe, _ := os.Executable()
	child, err := spawnInJob(exe, root, filepath.Join(root, "child.log"), []string{"-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "sleep"}, marker.JobName)
	if err != nil {
		t.Fatal(err)
	}
	defer child.stop()
	other, err := spawnOwned(exe, root, filepath.Join(root, "other.log"), []string{"-test.run=^TestNativeFixture$", "--", "--sash-test-fixture", "sleep"})
	if err != nil {
		t.Fatal(err)
	}
	defer other.stop()
	if _, err = createRecoveryJob(marker.JobName); !errors.Is(err, errJobCollision) {
		t.Fatal("collision adopted", err)
	}
	if _, err = recoverActiveJob(root); err != nil {
		t.Fatal(err)
	}
	if alive, err := child.running(); err != nil || alive {
		t.Fatal("identified child survived", err)
	}
	if alive, err := other.running(); err != nil || !alive {
		t.Fatal("unrelated child affected", err)
	}
}
func TestRecoveryRejectsPermissiveJobACL(t *testing.T) {
	root, marker := recoveryFixture(t)
	sd, err := windows.SecurityDescriptorFromString("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	name, _ := windows.UTF16PtrFromString(marker.JobName)
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	job, err := windows.CreateJobObject(&sa, name)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	if _, err = recoverActiveJob(root); err == nil {
		t.Fatal("untrusted ACL accepted")
	}
	if _, err = os.Stat(filepath.Join(root, "private", "active.json")); err != nil {
		t.Fatal("evidence removed", err)
	}
}
func TestRecoveryRejectsCorruptMarker(t *testing.T) {
	root, marker := recoveryFixture(t)
	path := filepath.Join(root, "private", "active.json")
	for _, change := range []func(*launchMarker){func(m *launchMarker) { m.SchemaVersion = 0 }, func(m *launchMarker) { m.JobName = `Global\Other` }, func(m *launchMarker) { m.Session = "bad" }, func(m *launchMarker) { m.Generation = 0 }} {
		bad := marker
		change(&bad)
		b, _ := json.Marshal(bad)
		if err := atomicWrite(path, b); err != nil {
			t.Fatal(err)
		}
		if _, err := recoverActiveJob(root); err == nil {
			t.Fatal("corrupt marker accepted", bad)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatal("marker removed", err)
		}
	}
	if err := atomicWrite(path, []byte(strings.Repeat(" ", 4097))); err != nil {
		t.Fatal(err)
	}
	if _, err := recoverActiveJob(root); err == nil {
		t.Fatal("oversized marker accepted")
	}
}
