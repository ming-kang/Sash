// SPDX-License-Identifier: MIT
package main

import (
	"errors"
	"io/fs"
	"testing"
)

func memoryOps(files map[string][]byte) fileOps {
	return fileOps{Read: func(p string) ([]byte, error) {
		b, ok := files[p]
		if !ok {
			return nil, fs.ErrNotExist
		}
		return append([]byte(nil), b...), nil
	}, Write: func(p string, b []byte) error { files[p] = append([]byte(nil), b...); return nil }, Remove: func(p string) error {
		if _, ok := files[p]; !ok {
			return fs.ErrNotExist
		}
		delete(files, p)
		return nil
	}}
}
func TestStatePublicationCommitAndRollback(t *testing.T) {
	for _, commit := range []bool{false, true} {
		files := map[string][]byte{"config": []byte("old"), "asset": []byte("prior")}
		ops := memoryOps(files)
		j, err := beginTransaction(ops, "journal", map[string][]byte{"config": []byte("new"), "asset": []byte("next"), "added": []byte("x")})
		if err != nil {
			t.Fatal(err)
		}
		if string(files["config"]) != "new" || files["journal"] == nil {
			t.Fatal("publication did not retain rollback data")
		}
		if commit {
			err = j.commit(ops, "journal")
			if string(files["config"]) != "new" {
				t.Fatal("commit changed config")
			}
		} else {
			err = j.rollback(ops, "journal")
			if string(files["config"]) != "old" || string(files["asset"]) != "prior" || files["added"] != nil {
				t.Fatal("rollback lost prior protected state")
			}
		}
		if err != nil || files["journal"] != nil {
			t.Fatalf("transaction did not finish: %v", err)
		}
	}
}
func TestFailedPublicationCompensates(t *testing.T) {
	files := map[string][]byte{"a": []byte("old-a"), "b": []byte("old-b")}
	ops := memoryOps(files)
	write := ops.Write
	ops.Write = func(p string, b []byte) error {
		if p == "b" && string(b) == "new-b" {
			return errors.New("injected write failure")
		}
		return write(p, b)
	}
	if _, err := beginTransaction(ops, "journal", map[string][]byte{"a": []byte("new-a"), "b": []byte("new-b")}); err == nil {
		t.Fatal("failure hidden")
	}
	if string(files["a"]) != "old-a" || string(files["b"]) != "old-b" || files["journal"] != nil {
		t.Fatal("partial publication not compensated")
	}
}
func TestIncompleteRollbackKeepsEvidenceAndBlocksMutation(t *testing.T) {
	files := map[string][]byte{"config": []byte("old")}
	ops := memoryOps(files)
	j, err := beginTransaction(ops, "journal", map[string][]byte{"config": []byte("new")})
	if err != nil {
		t.Fatal(err)
	}
	write := ops.Write
	ops.Write = func(p string, b []byte) error {
		if p == "config" {
			return errors.New("injected rollback failure")
		}
		return write(p, b)
	}
	if err = j.rollback(ops, "journal"); err == nil {
		t.Fatal("rollback failure hidden")
	}
	if files["journal"] == nil {
		t.Fatal("rollback evidence deleted")
	}
	if _, err = beginTransaction(ops, "journal", map[string][]byte{"other": []byte("x")}); err == nil {
		t.Fatal("new publication ignored unresolved evidence")
	}
	ops.Write = write
	if err = j.rollback(ops, "journal"); err != nil {
		t.Fatal(err)
	}
	if string(files["config"]) != "old" {
		t.Fatal("recovery failed")
	}
}
func TestReloadRestoreKeepsJournalUntilHealthCommit(t *testing.T) {
	files := map[string][]byte{"config": []byte("old")}
	ops := memoryOps(files)
	j, err := beginTransaction(ops, "journal", map[string][]byte{"config": []byte("new")})
	if err != nil {
		t.Fatal(err)
	}
	if err = j.restore(ops); err != nil {
		t.Fatal(err)
	}
	if string(files["config"]) != "old" || files["journal"] == nil {
		t.Fatal("unverified reload compensation lost evidence")
	}
	if err = j.commit(ops, "journal"); err != nil {
		t.Fatal(err)
	}
}
