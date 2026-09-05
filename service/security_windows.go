// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func protectedRoot() (string, error) {
	p, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return "", err
	}
	return filepath.Join(p, serviceName), nil
}
func currentSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}
func canonicalRoot(p string) (string, error) {
	if !filepath.IsAbs(p) || strings.HasPrefix(p, `\\`) || strings.ContainsAny(p, "\x00\"%") || len(p) > 240 || len(filepath.VolumeName(p)) != 2 {
		return "", failure("INVALID_REQUEST", "Root must be a local absolute drive path")
	}
	p = filepath.Clean(p)
	for _, part := range strings.Split(p[3:], `\`) {
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || strings.Contains(part, ":") || reservedWindows.MatchString(part) {
			return "", failure("INVALID_REQUEST", "Noncanonical root component")
		}
	}
	locks, err := lockComponents(p)
	if err != nil {
		return "", err
	}
	defer closeHandles(locks)
	h := locks[len(locks)-1]
	b := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &b[0], uint32(len(b)), 0)
	if err != nil || n >= uint32(len(b)) {
		return "", failure("INVALID_REQUEST", "Cannot canonicalize root")
	}
	final := strings.TrimPrefix(windows.UTF16ToString(b[:n]), `\\?\`)
	if !strings.EqualFold(final, p) {
		return "", failure("INVALID_REQUEST", "Root aliases are not permitted")
	}
	return final, nil
}
func closeHandles(hs []windows.Handle) {
	for i := len(hs) - 1; i >= 0; i-- {
		_ = windows.CloseHandle(hs[i])
	}
}
func openNoReparse(p string) (windows.Handle, error) {
	ptr, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(h)
		return 0, failure("UNSAFE_STORAGE", "Reparse point or unobservable storage")
	}
	return h, nil
}

// Hold ancestor handles without FILE_SHARE_DELETE for the lifetime of an
// operation, so a successful no-reparse check cannot be raced by renaming.
func lockComponents(p string) ([]windows.Handle, error) {
	p = filepath.Clean(p)
	vol := filepath.VolumeName(p)
	if len(vol) != 2 || !filepath.IsAbs(p) {
		return nil, failure("UNSAFE_STORAGE", "Local absolute storage required")
	}
	prefix := vol + `\`
	var hs []windows.Handle
	h, err := openNoReparse(prefix)
	if err != nil {
		return nil, err
	}
	hs = append(hs, h)
	for _, s := range strings.Split(strings.TrimPrefix(p, prefix), `\`) {
		if s == "" {
			continue
		}
		prefix = filepath.Join(prefix, s)
		h, err = openNoReparse(prefix)
		if err != nil {
			closeHandles(hs)
			return nil, err
		}
		hs = append(hs, h)
	}
	return hs, nil
}
func privateSD(owner string, readable bool, inherit bool) (*windows.SECURITY_DESCRIPTOR, error) {
	flags := ""
	if inherit {
		flags = "OICI"
	}
	s := "O:BAG:BAD:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;BA)"
	if readable {
		if _, err := windows.StringToSid(owner); err != nil {
			return nil, err
		}
		s += "(A;;0x1200a9;;;" + owner + ")"
	}
	return windows.SecurityDescriptorFromString(s)
}
func createPrivateDir(p, owner string, readable bool) error {
	sd, err := privateSD(owner, readable, true)
	if err != nil {
		return err
	}
	ptr, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(ptr, &sa)
	runtime.KeepAlive(sd)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	h, err := openNoReparse(p)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return verifyPrivateACL(h, owner, readable)
}
func verifyPrivateACL(h windows.Handle, owner string, readable bool) error {
	return verifyACLType(h, owner, readable, windows.SE_FILE_OBJECT)
}
func verifyACLType(h windows.Handle, owner string, readable bool, kind windows.SE_OBJECT_TYPE) error {
	sd, err := windows.GetSecurityInfo(h, kind, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	sid, _, err := sd.Owner()
	if err != nil || sid == nil || (sid.String() != "S-1-5-18" && sid.String() != "S-1-5-32-544") {
		return failure("UNSAFE_STORAGE", "Protected storage owner is not SYSTEM/Administrators")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return failure("UNSAFE_STORAGE", "Protected storage has no restrictive DACL")
	}
	var system, admin bool
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return failure("UNSAFE_STORAGE", "Unsupported protected storage ACE")
		}
		id := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if id == "S-1-5-18" {
			system = true
			continue
		}
		if id == "S-1-5-32-544" {
			admin = true
			continue
		}
		// Owner RX on root/helper is deliberately non-inheritable; nothing grants
		// the enrolled user create/write/delete/WRITE_DAC/WRITE_OWNER permissions.
		if !readable || id != owner || uint32(ace.Mask) & ^uint32(0x1200a9) != 0 || ace.Header.AceFlags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) != 0 {
			return failure("UNSAFE_STORAGE", "Untrusted access to protected storage")
		}
	}
	if !system || !admin {
		return failure("UNSAFE_STORAGE", "Missing privileged storage ACL")
	}
	return nil
}
func applyPrivateACL(p, owner string, readable bool) error {
	sd, err := privateSD(owner, readable, false)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	sid, _, err := sd.Owner()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, sid, nil, dacl, nil)
}
func atomicWrite(p string, b []byte) error {
	// Called only below a verified, pinned private root. The temporary file
	// inherits the private parent DACL before its first byte is written.
	f, err := os.CreateTemp(filepath.Dir(p), ".stage-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = applyPrivateACL(name, "", false); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return moveReplace(name, p)
}
func moveReplace(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func verifyTree(root, owner string) ([]windows.Handle, error) {
	locks, err := lockComponents(root)
	if err != nil {
		return nil, err
	}
	if err = verifyAncestors(locks[:len(locks)-1]); err != nil {
		closeHandles(locks)
		return nil, err
	}
	if err = verifyPrivateACL(locks[len(locks)-1], owner, true); err != nil {
		closeHandles(locks)
		return nil, err
	}
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if p == root {
			return nil
		}
		h, err := openNoReparse(p)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(h)
		return verifyPrivateACL(h, owner, p == filepath.Join(root, "sash-service.exe"))
	})
	if err != nil {
		closeHandles(locks)
		return nil, fmt.Errorf("protected storage: %w", err)
	}
	return locks, nil
}

// Enrollment uses an individual kernel owner. Administrative mutations also
// require that owner to match the current token, not alternate UAC credentials.
func enrollmentSID(root string) (string, error) {
	locks, err := lockComponents(root)
	if err != nil {
		return "", err
	}
	defer closeHandles(locks)
	sd, err := windows.GetSecurityInfo(locks[len(locks)-1], windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", err
	}
	sid, _, err := sd.Owner()
	if err != nil || sid == nil {
		return "", failure("OWNER_MISMATCH", "Cannot establish user root owner")
	}
	_, _, kind, err := sid.LookupAccount("")
	if err != nil || kind != windows.SidTypeUser || sid.String() == "S-1-5-18" || sid.String() == "S-1-5-19" || sid.String() == "S-1-5-20" {
		return "", failure("OWNER_MISMATCH", "User root must be owned by an individual Windows user; create it without elevation before enrollment")
	}
	return sid.String(), nil
}

// Querying token elevation and root ownership requires no administrator rights.
type privilegeStatus struct {
	Elevated     bool `json:"elevated"`
	OwnerMatches bool `json:"ownerMatches"`
}

func privileges(root string) (privilegeStatus, error) {
	out := privilegeStatus{Elevated: windows.GetCurrentProcessToken().IsElevated()}
	caller, err := currentSID()
	if err != nil {
		return out, err
	}
	locks, err := lockComponents(root)
	if err != nil {
		return out, err
	}
	defer closeHandles(locks)
	sd, err := windows.GetSecurityInfo(locks[len(locks)-1], windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return out, err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return out, failure("OWNER_MISMATCH", "Cannot establish user root owner")
	}
	out.OwnerMatches = owner.String() == caller
	return out, nil
}
func requireRootOwner(root string) error {
	p, err := privileges(root)
	if err != nil {
		return err
	}
	if !p.OwnerMatches {
		return failure("OWNER_MISMATCH", "Current Windows user does not own the requested root")
	}
	return nil
}
