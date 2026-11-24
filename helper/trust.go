package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

var buildVersion = "dev"
var coreSHA256 string
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const maxCoreSize = 512 << 20

func corePath(dir string) string {
	name := "mihomo"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name)
}
func canonicalDir(p string) error {
	real, err := filepath.EvalSymlinks(p)
	if err != nil || real != p {
		return errors.New("helper requires canonical protected directories")
	}
	fi, err := os.Stat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errors.New("protected path is not a directory")
	}
	return nil
}
func verifyCore(ctx context.Context, p Platform, bin, expected string) error {
	invalid := errors.New("Paired Core is missing or invalid; reinstall the helper")
	if !digestPattern.MatchString(expected) {
		return invalid
	}
	if p.VerifyProtectedPath(ctx, bin) != nil || canonicalDir(bin) != nil {
		return invalid
	}
	path := corePath(bin)
	if p.VerifyProtectedPath(ctx, path) != nil {
		return invalid
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() < 1 || before.Size() > maxCoreSize {
		return invalid
	}
	f, err := openRegular(path)
	if err != nil {
		return invalid
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !os.SameFile(info, before) || !info.Mode().IsRegular() {
		return invalid
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxCoreSize+1))
	if err != nil || n != before.Size() || subtle.ConstantTimeCompare([]byte(hex.EncodeToString(h.Sum(nil))), []byte(expected)) != 1 {
		return invalid
	}
	return nil
}
