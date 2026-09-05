// SPDX-License-Identifier: MIT
package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// A write-ahead rollback journal is durable before any target changes. A failed
// rollback keeps the journal and all snapshots, and blocks subsequent mutation.
// All paths are service-generated below an already pinned protected directory.
type fileSnapshot struct {
	Path    string `json:"path"`
	Existed bool   `json:"existed"`
	Data    []byte `json:"data,omitempty"`
}
type journal struct {
	Files []fileSnapshot `json:"files"`
}
type fileOps struct {
	Read   func(string) ([]byte, error)
	Write  func(string, []byte) error
	Remove func(string) error
}

func transactionOps() fileOps { return fileOps{os.ReadFile, atomicWrite, os.Remove} }
func beginTransaction(ops fileOps, journalPath string, updates map[string][]byte) (*journal, error) {
	if _, err := ops.Read(journalPath); err == nil {
		return nil, failure("RECOVERY_REQUIRED", "Unresolved protected transaction exists")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	j := &journal{}
	paths := make([]string, 0, len(updates))
	for p := range updates {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		b, err := ops.Read(p)
		existed := err == nil
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		j.Files = append(j.Files, fileSnapshot{p, existed, b})
	}
	raw, err := json.Marshal(j)
	if err != nil {
		return nil, err
	}
	if err = ops.Write(journalPath, raw); err != nil {
		return nil, err
	}
	for _, p := range paths {
		if err = ops.Write(p, updates[p]); err != nil {
			return j, errors.Join(err, j.rollback(ops, journalPath))
		}
	}
	return j, nil
}
func (j *journal) restore(ops fileOps) error {
	var errs []error
	for i := len(j.Files) - 1; i >= 0; i-- {
		s := j.Files[i]
		var err error
		if s.Existed {
			err = ops.Write(s.Path, s.Data)
		} else {
			err = ops.Remove(s.Path)
			if errors.Is(err, fs.ErrNotExist) {
				err = nil
			}
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
func (j *journal) rollback(ops fileOps, journalPath string) error {
	if err := j.restore(ops); err != nil {
		return err
	}
	return ops.Remove(journalPath)
}
func (j *journal) commit(ops fileOps, journalPath string) error { return ops.Remove(journalPath) }
func recoverTransaction(ops fileOps, journalPath, root string) error {
	b, err := ops.Read(journalPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var j journal
	if err = decodeJSON(b, &j); err != nil {
		return err
	}
	// Never trust even a protected journal blindly after corruption.
	for _, s := range j.Files {
		rel, err := filepath.Rel(root, s.Path)
		if err != nil || rel == "." || !filepath.IsLocal(rel) {
			return failure("RECOVERY_REQUIRED", "Protected journal has invalid target")
		}
	}
	return j.rollback(ops, journalPath)
}
