package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJournal(t *testing.T) {
	type entry struct {
		Version int
		PID     int
	}
	f := filepath.Join(t.TempDir(), "journal")
	if v, e := readJournal[entry](f); v != nil || e != nil {
		t.Fatalf("%v %v", v, e)
	}
	for _, pid := range []int{0, 123} {
		if e := writeJournal(f, entry{1, pid}); e != nil {
			t.Fatal(e)
		}
		if v, e := readJournal[entry](f); e != nil || *v != (entry{1, pid}) {
			t.Fatalf("%v %v", v, e)
		}
	}
	for _, content := range []string{"null", "{\"PID\":1,\"PID\":2}", "{\"foreign\":12}", "{}{}"} {
		if e := os.WriteFile(f, []byte(content), 0600); e != nil {
			t.Fatal(e)
		}
		if v, e := readJournal[entry](f); v != nil || e == nil {
			t.Fatalf("accepted corrupt journal %v %v", v, e)
		}
		if b, e := os.ReadFile(f); e != nil || string(b) != content {
			t.Fatal("altered corrupt journal")
		}
	}
}
