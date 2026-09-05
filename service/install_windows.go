// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func elevated() error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return failure("ELEVATION_REQUIRED", "This command requires an elevated administrator token")
	}
	return nil
}
func stopSCM(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	var process windows.Handle
	if st.ProcessId != 0 {
		process, err = windows.OpenProcess(windows.SYNCHRONIZE, false, st.ProcessId)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(process)
	}
	if st.State != svc.StopPending {
		if _, err = s.Control(svc.Stop); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(35 * time.Second)
	for time.Now().Before(deadline) {
		st, err = s.Query()
		if err != nil {
			return err
		}
		if st.State == svc.Stopped {
			if process != 0 {
				wait, err := windows.WaitForSingleObject(process, 10000)
				if err != nil {
					return err
				}
				if wait != windows.WAIT_OBJECT_0 {
					return failure("SERVICE_UNAVAILABLE", "SCM stopped but its retained process has not exited")
				}
			}
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return failure("SERVICE_UNAVAILABLE", "SCM service did not confirm stopped; no process was signalled by PID")
}
func installService(userRoot, source, want string) error {
	if err := elevated(); err != nil {
		return err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return err
	}
	if err := requireDetachedHelper(); err != nil {
		return err
	}
	release, err := adminLock()
	if err != nil {
		return err
	}
	defer release()
	if want == "" || len(want) > 128 || strings.ContainsAny(want, " \r\n\x00") {
		return failure("INVALID_REQUEST", "An exact approved Core version is required")
	}
	sid, err := enrollmentSID(userRoot)
	if err != nil {
		return err
	}
	root, err := protectedRoot()
	if err != nil {
		return err
	}
	parents, err := lockComponents(filepath.Dir(root))
	if err != nil {
		return err
	}
	defer closeHandles(parents)
	if err = verifyAncestors(parents); err != nil {
		return err
	}
	if err = createPrivateDir(root, sid, true); err != nil {
		return err
	}
	locks, err := verifyTree(root, sid)
	if err != nil {
		return err
	}
	defer closeHandles(locks)
	if err = createPrivateDir(filepath.Join(root, "private"), sid, false); err != nil {
		return err
	}
	if err = createPrivateDir(filepath.Join(root, "private", "runtime"), sid, false); err != nil {
		return err
	}
	// A registration cannot be adopted just because its display name matches.
	existing, stateErr := querySCM(windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS | windows.SERVICE_STOP)
	if stateErr != nil && !errors.Is(stateErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return stateErr
	}
	if stateErr == nil {
		defer existing.Close()
	}
	// For orphaned first installs, ownership and absence of launch evidence are
	// verified before rollback, and enrollment is interpreted only afterwards.
	if errors.Is(stateErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		if _, err = recoverOrphanEnrollment(root, userRoot, sid); err != nil {
			return err
		}
	}
	old, loadErr := loadEnrollment(root)
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
		return loadErr
	}
	if loadErr == nil && (old.Owner != sid || !strings.EqualFold(old.Root, userRoot)) {
		return failure("CONFLICT", "Uninstall is required before changing the enrolled user/root")
	}
	if stateErr == nil {
		checked, _, err := checkedService()
		if err != nil {
			return err
		}
		checked.Close()
		if loadErr != nil {
			return failure("REGISTRATION_MISMATCH", "SCM registration has no valid protected enrollment")
		}
		if err = stopSCM(existing); err != nil {
			return err
		}
	}
	// An absent registration is not proof that a previously launched service
	// process has exited (an administrator could have deleted its registration).
	if stateErr != nil {
		if _, markerErr := os.Stat(filepath.Join(root, "private", "active.json")); !errors.Is(markerErr, os.ErrNotExist) {
			return failure("RECOVERY_REQUIRED", "Launch evidence requires a verified stopped SCM registration before repair")
		}
	}
	if _, err = recoverActiveJob(root); err != nil {
		return err
	}
	// Installation recovery is explicit and elevated. Any incomplete file
	// publication is restored before interpreting a new administrator source.
	installJournal := filepath.Join(root, "private", "install-journal.json")
	if err = recoverTransaction(transactionOps(), installJournal, root); err != nil {
		return err
	}
	if err = recoverTransaction(transactionOps(), filepath.Join(root, "private", "approval-journal.json"), filepath.Join(root, "private")); err != nil {
		return err
	}
	if err = recoverTransaction(transactionOps(), filepath.Join(root, "private", "runtime-journal.json"), filepath.Join(root, "private")); err != nil {
		return err
	}
	old, loadErr = loadEnrollment(root)
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
		return loadErr
	}
	if loadErr == nil && (old.Owner != sid || !strings.EqualFold(old.Root, userRoot)) {
		return failure("CONFLICT", "Recovered enrollment belongs to another user/root")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	stage := filepath.Join(root, "private", "install-"+token)
	if err = createPrivateDir(stage, sid, false); err != nil {
		return err
	}
	// Keep failed stages and their private probe logs as evidence.
	stagedHelper := filepath.Join(stage, "sash-service.exe")
	helperHash, err := copyApprovedSource(self, stagedHelper)
	if err != nil {
		return err
	}
	stagedCore := filepath.Join(stage, "core.exe")
	coreHash, err := copyApprovedSource(source, stagedCore)
	if err != nil {
		return err
	}
	if err = verifyBinaryVersion(stagedHelper, stage, version, true); err != nil {
		return err
	}
	if err = verifyBinaryVersion(stagedCore, stage, want, false); err != nil {
		return err
	}
	next := enrollment{Protocol: protocol, Owner: sid, Root: userRoot, HelperSHA256: helperHash, Core: approval{SHA256: coreHash, Version: want}}
	updates := map[string][]byte{}
	if loadErr == nil {
		if old.PreviousCore != nil && old.Core.SHA256 != coreHash {
			return failure("CONFLICT", "A pending approved Core refresh must pass managed health before another refresh")
		}
		next.PreviousCore = old.PreviousCore
		if old.Core.SHA256 != coreHash {
			h, err := approvedFile(filepath.Join(root, "private", "core.exe"), old.Core.SHA256, sid, false)
			if err != nil {
				return err
			}
			windows.CloseHandle(h)
			prior, err := os.ReadFile(filepath.Join(root, "private", "core.exe"))
			if err != nil {
				return err
			}
			updates[filepath.Join(root, "private", "core.exe.bak")] = prior
			next.PreviousCore = &old.Core
		}
	}
	// verifyTree closes file validation handles during its walk; only protected
	// directory handles remain pinned. The caller runs from a detached helper,
	// so neither our image nor a retained validation handle locks this target.
	updates[filepath.Join(root, "sash-service.exe")], err = os.ReadFile(stagedHelper)
	if err != nil {
		return err
	}
	updates[filepath.Join(root, "private", "core.exe")], err = os.ReadFile(stagedCore)
	if err != nil {
		return err
	}
	updates[policyPath(root)], err = json.Marshal(next)
	if err != nil {
		return err
	}
	j, err := beginTransaction(transactionOps(), installJournal, updates)
	if err != nil {
		return err
	}
	rollback := func(cause error) error {
		rb := j.rollback(transactionOps(), installJournal)
		if loadErr == nil && rb == nil {
			rb = applyPrivateACL(filepath.Join(root, "sash-service.exe"), sid, true)
		}
		return errors.Join(cause, rb)
	}
	if err = applyPrivateACL(filepath.Join(root, "sash-service.exe"), sid, true); err != nil {
		return rollback(err)
	}
	manager, err := mgr.Connect()
	if err != nil {
		return rollback(err)
	}
	defer manager.Disconnect()
	var service *mgr.Service
	created := false
	if stateErr != nil {
		service, err = manager.CreateService(serviceName, filepath.Join(root, "sash-service.exe"), mgr.Config{StartType: mgr.StartAutomatic, ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, ErrorControl: mgr.ErrorNormal, DisplayName: "Sash Service", Description: "Privileged network runtime for the enrolled Sash user", ServiceStartName: "LocalSystem"}, "run")
		created = err == nil
	} else {
		service, err = manager.OpenService(serviceName)
	}
	if err != nil {
		return rollback(err)
	}
	defer service.Close()
	// Commit bytes before SCM starts reading policy. Boot stays Core-idle.
	if err = j.commit(transactionOps(), installJournal); err != nil {
		if created {
			_ = service.Delete()
		}
		return rollback(err)
	}
	if err = service.Start(); err != nil {
		return failure("SERVICE_UNAVAILABLE", "Protected installation committed but SCM start failed; repeat elevated install to repair")
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, err := service.Query()
		if err != nil {
			return err
		}
		if st.State == svc.Running {
			_ = os.RemoveAll(stage)
			return nil
		}
		if st.State == svc.Stopped {
			return failure("SERVICE_UNAVAILABLE", "Service failed its startup integrity checks; protected evidence retained")
		}
		time.Sleep(100 * time.Millisecond)
	}
	return failure("SERVICE_UNAVAILABLE", "SCM startup did not become available in time")
}
func uninstallService(userRoot string) error {
	if err := elevated(); err != nil {
		return err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return err
	}
	if err := requireDetachedHelper(); err != nil {
		return err
	}
	release, err := adminLock()
	if err != nil {
		return err
	}
	defer release()
	sid, err := enrollmentSID(userRoot)
	if err != nil {
		return err
	}
	root, err := protectedRoot()
	if err != nil {
		return err
	}
	p, err := loadEnrollment(root)
	if err != nil {
		return err
	}
	if p.Owner != sid || !strings.EqualFold(p.Root, userRoot) {
		return failure("CONFLICT", "Uninstall root/user differs from enrollment")
	}
	locks, err := verifyTree(root, sid)
	if err != nil {
		return err
	}
	service, err := querySCM(windows.SERVICE_QUERY_STATUS | windows.SERVICE_QUERY_CONFIG | windows.SERVICE_STOP | windows.DELETE)
	if err != nil {
		closeHandles(locks)
		return err
	}
	defer service.Close()
	checked, _, err := checkedService()
	if err != nil {
		closeHandles(locks)
		return err
	}
	checked.Close()
	if err = stopSCM(service); err != nil {
		closeHandles(locks)
		return err
	}
	if _, err = recoverActiveJob(root); err != nil {
		closeHandles(locks)
		return err
	}
	if err = service.Delete(); err != nil {
		closeHandles(locks)
		return err
	}
	closeHandles(locks)
	if err = os.RemoveAll(root); err != nil {
		return failure("RECOVERY_REQUIRED", "SCM deletion succeeded but protected files remain; remove them through an elevated repair")
	}
	return nil
}

// Serialize explicit administrative repair/refresh/enrollment across processes.
// The mutex is kernel-owned by Administrators, not the enrolled ordinary user.
func adminLock() (func(), error) {
	sd, err := privateSD("", false, false)
	if err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(`Global\SashService-administration`)
	if err != nil {
		return nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	h, err := windows.CreateMutex(&sa, false, name)
	runtime.KeepAlive(sd)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	if err = verifyACLType(h, "", false, windows.SE_KERNEL_OBJECT); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	runtime.LockOSThread()
	wait, err := windows.WaitForSingleObject(h, 30000)
	if err != nil || (wait != windows.WAIT_OBJECT_0 && wait != 0x80 /* WAIT_ABANDONED_0 */) {
		runtime.UnlockOSThread()
		windows.CloseHandle(h)
		return nil, failure("CONFLICT", "Another administrator operation is active or uncertain")
	}
	return func() { _ = windows.ReleaseMutex(h); _ = windows.CloseHandle(h); runtime.UnlockOSThread() }, nil
}

type maintenanceStage struct {
	Protocol   int    `json:"protocol"`
	HelperPath string `json:"helperPath"`
	Directory  string `json:"directory"`
}

const maintenancePrefix = "SashService-maintenance-"

// Copy only: this process must exit before the caller starts the copy. Never
// spawn-and-wait from the installed executable, which would keep it locked.
func stageMaintenance(userRoot string) (maintenanceStage, error) {
	var out maintenanceStage
	if err := elevated(); err != nil {
		return out, err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return out, err
	}
	root, err := protectedRoot()
	if err != nil {
		return out, err
	}
	parents, err := lockComponents(filepath.Dir(root))
	if err != nil {
		return out, err
	}
	defer closeHandles(parents)
	if err = verifyAncestors(parents); err != nil {
		return out, err
	}
	token, err := randomToken()
	if err != nil {
		return out, err
	}
	dir := filepath.Join(filepath.Dir(root), maintenancePrefix+token)
	// Never adopt an existing directory, even if its ACL appears acceptable.
	sd, err := privateSD("", false, true)
	if err != nil {
		return out, err
	}
	ptr, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return out, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(ptr, &sa)
	runtime.KeepAlive(sd)
	if err != nil {
		return out, err
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(dir)
		}
	}()
	h, err := openNoReparse(dir)
	if err != nil {
		return out, err
	}
	defer windows.CloseHandle(h)
	if err = verifyPrivateACL(h, "", false); err != nil {
		return out, err
	}
	self, err := os.Executable()
	if err != nil {
		return out, err
	}
	dest := filepath.Join(dir, "sash-service.exe")
	// Pins source components and denies writes/deletion while copying and
	// verifying byte equality. Destination inherits private ACLs from creation.
	hash, err := copyApprovedSource(self, dest)
	if err != nil {
		return out, err
	}
	verified, err := approvedFile(dest, hash, "", false)
	if err != nil {
		return out, err
	}
	windows.CloseHandle(verified)
	success = true
	return maintenanceStage{Protocol: protocol, HelperPath: dest, Directory: dir}, nil
}

// Run from a non-staged helper after the staged process exits. Never recursively
// remove caller-selected paths or unknown contents, even as administrator.
func cleanupMaintenance(userRoot, directory string) error {
	if err := elevated(); err != nil {
		return err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return err
	}
	root, err := protectedRoot()
	if err != nil {
		return err
	}
	parent := filepath.Dir(root)
	name := filepath.Base(directory)
	if !strings.HasPrefix(name, maintenancePrefix) || !sessionPattern.MatchString(strings.TrimPrefix(name, maintenancePrefix)) || !strings.EqualFold(directory, filepath.Join(parent, name)) {
		return failure("INVALID_REQUEST", "Not a fixed maintenance staging directory")
	}
	parents, err := lockComponents(parent)
	if err != nil {
		return err
	}
	defer closeHandles(parents)
	if err = verifyAncestors(parents); err != nil {
		return err
	}
	h, err := openNoReparse(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() {
		if h != 0 {
			windows.CloseHandle(h)
		}
	}()
	if err = verifyPrivateACL(h, "", false); err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != "sash-service.exe" || entry.IsDir() {
			return failure("UNSAFE_STORAGE", "Unknown maintenance staging contents")
		}
		file := filepath.Join(directory, entry.Name())
		f, err := openNoReparse(file)
		if err != nil {
			return err
		}
		err = verifyPrivateACL(f, "", false)
		windows.CloseHandle(f)
		if err != nil {
			return err
		}
	}
	if len(entries) != 0 {
		if err = os.Remove(filepath.Join(directory, "sash-service.exe")); err != nil {
			return err
		}
	}
	windows.CloseHandle(h)
	h = 0
	return os.Remove(directory)
}

// Reject legacy callers before any mutation rather than deleting SCM and only
// then discovering that this process still has the target executable mapped.
func requireDetachedHelper() error {
	root, err := protectedRoot()
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.EqualFold(self, filepath.Join(root, "sash-service.exe")) {
		return failure("MAINTENANCE_REQUIRED", "Run stage-maintenance, wait for its exit, then invoke the returned helper")
	}
	return nil
}

// Only called under the administrator lock after confirming SCM absence and
// pinning a restrictive, non-reparse protected tree. No runtime evidence is cleared.
func recoverOrphanEnrollment(root, userRoot, sid string) (enrollment, error) {
	for _, name := range []string{"active.json", "runtime-journal.json"} {
		if _, err := os.Lstat(filepath.Join(root, "private", name)); !errors.Is(err, os.ErrNotExist) {
			return enrollment{}, failure("RECOVERY_REQUIRED", "Runtime evidence prevents orphaned-install repair")
		}
	}
	// Even an otherwise invalid current policy cannot be adopted from another owner.
	checkOwner := func(raw []byte) error {
		var p enrollment
		if err := decodeJSON(raw, &p); err != nil {
			return err
		}
		if p.Owner != sid || !strings.EqualFold(p.Root, userRoot) {
			return failure("OWNER_MISMATCH", "Protected enrollment belongs to another user/root")
		}
		if p.Protocol != protocol || !sessionPattern.MatchString(p.HelperSHA256) || !sessionPattern.MatchString(p.Core.SHA256) || p.Core.Version == "" {
			return failure("RECOVERY_REQUIRED", "Invalid journal enrollment snapshot")
		}
		return nil
	}
	current, loadErr := loadEnrollment(root)
	if loadErr == nil && (current.Owner != sid || !strings.EqualFold(current.Root, userRoot)) {
		return enrollment{}, failure("OWNER_MISMATCH", "Protected enrollment belongs to another user/root")
	}
	if raw, err := os.ReadFile(policyPath(root)); err == nil {
		// A parseable policy with a foreign identity always blocks rollback too.
		var p map[string]any
		if decodeJSON(raw, &p) == nil {
			if owner, ok := p["owner"]; ok && owner != sid {
				return enrollment{}, failure("OWNER_MISMATCH", "Foreign policy owner")
			}
			if enrolled, ok := p["root"]; ok {
				text, ok := enrolled.(string)
				if !ok || !strings.EqualFold(text, userRoot) {
					return enrollment{}, failure("ROOT_MISMATCH", "Foreign policy root")
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return enrollment{}, err
	}
	type pending struct {
		path    string
		journal journal
	}
	var journals []pending
	restoresPolicy := false
	for _, name := range []string{"install-journal.json", "approval-journal.json"} {
		jp := filepath.Join(root, "private", name)
		raw, err := os.ReadFile(jp)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return enrollment{}, err
		}
		var j journal
		if err = decodeJSON(raw, &j); err != nil {
			return enrollment{}, err
		}
		allowed := map[string]bool{policyPath(root): true, filepath.Join(root, "private", "core.exe"): true}
		if name == "install-journal.json" {
			allowed[filepath.Join(root, "sash-service.exe")] = true
			allowed[filepath.Join(root, "private", "core.exe.bak")] = true
		}
		seen := map[string]bool{}
		for _, snapshot := range j.Files {
			if !allowed[snapshot.Path] || seen[snapshot.Path] || (!snapshot.Existed && len(snapshot.Data) != 0) {
				return enrollment{}, failure("RECOVERY_REQUIRED", "Orphaned install journal has invalid fixed-role targets")
			}
			seen[snapshot.Path] = true
			if snapshot.Path == policyPath(root) {
				restoresPolicy = true
				if snapshot.Existed {
					if err = checkOwner(snapshot.Data); err != nil {
						return enrollment{}, err
					}
				} else if name != "install-journal.json" {
					return enrollment{}, failure("RECOVERY_REQUIRED", "Approval journal lacks prior enrollment")
				}
			}
		}
		if !seen[policyPath(root)] || !seen[filepath.Join(root, "private", "core.exe")] ||
			(name == "install-journal.json" && !seen[filepath.Join(root, "sash-service.exe")]) {
			return enrollment{}, failure("RECOVERY_REQUIRED", "Incomplete orphaned install journal roles")
		}
		journals = append(journals, pending{jp, j})
	}
	// These transactions cannot overlap during a legitimate first installation.
	if len(journals) > 1 {
		return enrollment{}, failure("RECOVERY_REQUIRED", "Conflicting orphaned install journals")
	}
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) && !restoresPolicy {
		return enrollment{}, loadErr
	}
	for _, item := range journals {
		if err := item.journal.rollback(transactionOps(), item.path); err != nil {
			return enrollment{}, err
		}
	}
	p, err := loadEnrollment(root)
	if errors.Is(err, os.ErrNotExist) {
		return enrollment{}, nil
	}
	if err != nil {
		return enrollment{}, err
	}
	if p.Owner != sid || !strings.EqualFold(p.Root, userRoot) {
		return enrollment{}, failure("OWNER_MISMATCH", "Recovered enrollment belongs to another user/root")
	}
	return p, nil
}

func repairStatus(userRoot string) (status, error) {
	if err := elevated(); err != nil {
		return status{}, err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return status{}, err
	}
	if err := requireDetachedHelper(); err != nil {
		return status{}, err
	}
	release, err := adminLock()
	if err != nil {
		return status{}, err
	}
	defer release()
	service, err := querySCM(windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS)
	if err == nil {
		service.Close()
		return status{}, failure("RECOVERY_REQUIRED", "Repair status requires confirmed absent SCM registration")
	}
	if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return status{}, err
	}
	root, err := protectedRoot()
	if err != nil {
		return status{}, err
	}
	sid, err := enrollmentSID(userRoot)
	if err != nil {
		return status{}, err
	}
	locks, err := verifyTree(root, sid)
	if err != nil {
		return status{}, err
	}
	defer closeHandles(locks)
	p, err := recoverOrphanEnrollment(root, userRoot, sid)
	if err != nil {
		return status{}, err
	}
	return status{Protocol: protocol, Supported: true, Installed: false, Running: false, Compatible: true, Version: version, Root: userRoot, CoreVersion: p.Core.Version}, nil
}

// Internal administrative repair preflight: start only the fixed, already
// enrolled host. No approved bytes, policy or Core launch request are published.
func startExistingService(userRoot string) (status, error) {
	if err := elevated(); err != nil {
		return status{}, err
	}
	if err := requireRootOwner(userRoot); err != nil {
		return status{}, err
	}
	release, err := adminLock()
	if err != nil {
		return status{}, err
	}
	defer release()
	root, err := protectedRoot()
	if err != nil {
		return status{}, err
	}
	sid, err := enrollmentSID(userRoot)
	if err != nil {
		return status{}, err
	}
	locks, err := verifyTree(root, sid)
	if err != nil {
		return status{}, err
	}
	defer closeHandles(locks)
	p, err := loadEnrollment(root)
	if err != nil {
		return status{}, err
	}
	if p.Owner != sid || !strings.EqualFold(p.Root, userRoot) {
		return status{}, failure("OWNER_MISMATCH", "Existing service enrollment differs from requested user/root")
	}
	if p.Protocol != protocol {
		return status{}, failure("PROTOCOL_MISMATCH", "Existing enrollment is incompatible")
	}
	helper, err := approvedFile(filepath.Join(root, "sash-service.exe"), p.HelperSHA256, sid, true)
	if err != nil {
		return status{}, err
	}
	defer windows.CloseHandle(helper)
	// Validate the same handle used for Start; no delete/reopen registration race.
	service, err := querySCM(windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS | windows.SERVICE_START)
	if err != nil {
		return status{}, err
	}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return status{}, err
	}
	if !strings.EqualFold(config.BinaryPathName, expectedCommand(root)) || !strings.EqualFold(config.ServiceStartName, "LocalSystem") || config.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS {
		return status{}, failure("REGISTRATION_MISMATCH", "Service registration identity changed")
	}
	transport := pipeTransport()
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return startIdleHost(ctx, service, func() (status, error) { return fetchStatus(ctx, userRoot, transport) })
}

type idleHostService interface {
	Query() (svc.Status, error)
	Start(...string) error
}

// The caller must pin and validate enrollment, image hash/ACL and SCM config
// first. The interface permits isolated tests without touching the real SCM.
func startIdleHost(ctx context.Context, service idleHostService, observe func() (status, error)) (status, error) {
	state, err := service.Query()
	if err != nil {
		return status{}, err
	}
	if state.State != svc.Stopped {
		return status{}, failure("CONFLICT", "Idle recovery requires a confirmed stopped SCM service")
	}
	if err = service.Start(); err != nil {
		return status{}, err
	}
	for {
		state, err = service.Query()
		if err != nil {
			return status{}, err
		}
		if state.State == svc.Running {
			observed, err := observe()
			if err != nil {
				return status{}, err
			}
			if observed.Core.Running {
				return status{}, failure("CONFLICT", "Recovered service Core is active; ownership is not adopted")
			}
			return observed, nil
		}
		if state.State != svc.StartPending {
			return status{}, failure("SERVICE_UNAVAILABLE", "Existing service did not start idle")
		}
		select {
		case <-ctx.Done():
			return status{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
