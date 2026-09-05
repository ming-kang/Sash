// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

type approval struct {
	SHA256  string `json:"sha256"`
	Version string `json:"version"`
}
type enrollment struct {
	Protocol     int       `json:"protocol"`
	Owner        string    `json:"owner"`
	Root         string    `json:"root"`
	HelperSHA256 string    `json:"helperSHA256"`
	Core         approval  `json:"core"`
	PreviousCore *approval `json:"previousCore,omitempty"`
}

func policyPath(root string) string { return filepath.Join(root, "private", "policy.json") }
func loadEnrollment(root string) (enrollment, error) {
	var p enrollment
	b, err := os.ReadFile(policyPath(root))
	if err != nil {
		return p, err
	}
	if err = decodeJSON(b, &p); err != nil {
		return p, err
	}
	if p.Protocol != protocol || p.Owner == "" || !sessionPattern.MatchString(p.HelperSHA256) || !sessionPattern.MatchString(p.Core.SHA256) || p.Core.Version == "" {
		return p, failure("PROTOCOL_MISMATCH", "Invalid protected enrollment")
	}
	if _, err = windows.StringToSid(p.Owner); err != nil {
		return p, err
	}
	if !filepath.IsAbs(p.Root) {
		return p, failure("ROOT_MISMATCH", "Invalid enrolled root")
	}
	return p, nil
}
func saveEnrollment(root string, p enrollment) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return atomicWrite(policyPath(root), b)
}
func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, io.LimitReader(f, 256<<20+1)); err != nil {
		return "", err
	}
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() > 256<<20 {
		return "", errors.New("binary exceeds size limit")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func approvedFile(path, expected, owner string, readable bool) (windows.Handle, error) {
	// Deny concurrent writes/deletion throughout validation and process lifetime.
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.READ_CONTROL, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	fail := func(err error) (windows.Handle, error) { windows.CloseHandle(h); return 0, err }
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return fail(err)
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		return fail(failure("UNSAFE_STORAGE", "Approved executable is not a regular non-reparse file"))
	}
	if err = verifyPrivateACL(h, owner, readable); err != nil {
		return fail(err)
	}
	actual, err := hashFile(path)
	if err != nil {
		return fail(err)
	}
	if actual != expected {
		return fail(failure("BINARY_CHANGED", "Protected executable bytes differ from administrator approval"))
	}
	return h, nil
}
func copyApprovedSource(source, dest string) (string, error) {
	if !filepath.IsAbs(source) {
		return "", failure("INVALID_REQUEST", "Administrator source must be absolute")
	}
	locks, err := lockComponents(source)
	if err != nil {
		return "", err
	}
	defer closeHandles(locks)
	ptr, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(h), source)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return "", failure("INVALID_REQUEST", "Approved source must be a bounded regular executable")
	}
	b, err := io.ReadAll(io.LimitReader(f, 256<<20+1))
	if err != nil {
		return "", err
	}
	if len(b) < 2 || string(b[:2]) != "MZ" {
		return "", failure("INVALID_REQUEST", "Approved source is not a Windows executable")
	}
	sum := sha256.Sum256(b)
	if err = atomicWrite(dest, b); err != nil {
		return "", err
	}
	actual, err := hashFile(dest)
	if err != nil {
		return "", err
	}
	expected := hex.EncodeToString(sum[:])
	if actual != expected {
		return "", failure("BINARY_CHANGED", "Staged executable hash differs after copy")
	}
	return expected, nil
}
func verifyBinaryVersion(exe, dir, want string, helper bool) error {
	log := filepath.Join(dir, "version-"+fmt.Sprint(time.Now().UnixNano())+".log")
	args := []string{"-v"}
	if helper {
		args = []string{"version"}
	}
	if err := atomicWrite(log, nil); err != nil {
		return err
	}
	child, err := spawnOwned(exe, dir, log, args)
	if err != nil {
		return err
	}
	code, waitErr := child.wait(10 * time.Second)
	stopErr := child.stop()
	if waitErr != nil || stopErr != nil {
		return errors.Join(waitErr, stopErr)
	}
	if code != 0 {
		return failure("VERSION_MISMATCH", "Approved executable version probe failed")
	}
	b, err := os.ReadFile(log)
	if err != nil {
		return err
	}
	if len(b) > 65536 {
		return failure("VERSION_MISMATCH", "Oversized version response")
	}
	if helper {
		var v struct {
			Protocol int    `json:"protocol"`
			Version  string `json:"version"`
		}
		if err = decodeJSON(b, &v); err != nil || v.Protocol != protocol || v.Version != version {
			return failure("VERSION_MISMATCH", "Helper version is incompatible")
		}
	} else {
		found := false
		for _, word := range strings.Fields(string(b)) {
			if word == want {
				found = true
			}
		}
		if !found {
			return failure("VERSION_MISMATCH", "Approved Core version differs from requested version")
		}
	}
	return nil
}
