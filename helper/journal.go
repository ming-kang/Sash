package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const maxJournalSize = 4 << 20

func readJournal[T any](path string) (*T, error) {
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errors.New("invalid journal file")
	}
	f, err := openRegular(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, after) {
		return nil, errors.New("journal changed before reading")
	}
	b, err := io.ReadAll(io.LimitReader(f, maxJournalSize+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxJournalSize {
		return nil, errors.New("journal is too large")
	}
	if _, err = uniqueJSONObject(b); err != nil {
		return nil, err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	var out T
	if err = d.Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func writeJournal(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b)+1 > maxJournalSize {
		return errors.New("journal is too large")
	}
	b = append(b, '\n')
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".journal-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return publishJournal(f.Name(), path)
}
