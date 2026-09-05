// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// A protected child DACL alone is insufficient: DELETE_CHILD on an ancestor
// would let a normal user replace the fixed SCM executable path while idle.
// Do not repair permissive machine ACLs silently; fail the installation/check.
func verifyAncestors(handles []windows.Handle) error {
	installer, _, _, err := windows.LookupSID("", "NT SERVICE\\TrustedInstaller")
	if err != nil {
		return err
	}
	trusted := map[string]bool{"S-1-5-18": true, "S-1-5-32-544": true, installer.String(): true}
	const unsafeMask = windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | 0x40 /* FILE_DELETE_CHILD */ | windows.FILE_WRITE_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES | windows.GENERIC_WRITE | windows.GENERIC_ALL
	for _, h := range handles {
		sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		owner, _, err := sd.Owner()
		if err != nil || owner == nil || !trusted[owner.String()] {
			return failure("UNSAFE_STORAGE", "Installation ancestor has an untrusted owner")
		}
		acl, _, err := sd.DACL()
		if err != nil || acl == nil {
			return failure("UNSAFE_STORAGE", "Installation ancestor has no restrictive ACL")
		}
		for i := uint32(0); i < uint32(acl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err = windows.GetAce(acl, i, &ace); err != nil {
				return err
			}
			if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
				continue
			}
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
				return failure("UNSAFE_STORAGE", "Unsupported installation ancestor ACE")
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			if !trusted[sid] && uint32(ace.Mask)&unsafeMask != 0 {
				return failure("UNSAFE_STORAGE", "Installation ancestor permits untrusted modification/replacement")
			}
		}
	}
	return nil
}
