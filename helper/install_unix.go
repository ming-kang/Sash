//go:build (linux || darwin) && !helpercontract

package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// installConsentedPair stages and verifies both release artifacts before
// publishing them. Platforms supply only their protected-path check and
// durable rename primitive; the consent-bound pipeline stays identical.
func installConsentedPair(
	binDir, helperSource, helperSha256, coreSource string,
	verifyProtected func(string) error,
	publish func(string, string) error,
) (string, error) {
	digest := coreSHA256
	if !digestPattern.MatchString(digest) {
		return "", errors.New("no paired Core digest embedded")
	}
	if !filepath.IsAbs(binDir) {
		return "", errors.New("Core bin directory must be a canonical absolute path")
	}
	real, err := filepath.EvalSymlinks(binDir)
	if err != nil || real != binDir {
		return "", errors.New("Core bin directory must be a canonical absolute path")
	}
	if err := verifyProtected(binDir); err != nil {
		return "", err
	}

	dir, err := os.MkdirTemp(binDir, ".core-publish-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	stagedCore := filepath.Join(dir, "core")
	stagedHelper := filepath.Join(dir, "helper")
	if err := copyConsentedFile(helperSource, helperSha256, stagedHelper); err != nil {
		return "", err
	}
	if err := copyConsentedFile(coreSource, digest, stagedCore); err != nil {
		return "", err
	}
	for _, staged := range []string{stagedCore, stagedHelper} {
		if err := os.Chmod(staged, 0o755); err != nil {
			return "", err
		}
	}
	if err := publish(stagedCore, corePath(binDir)); err != nil {
		return "", err
	}
	if err := publish(stagedHelper, filepath.Join(binDir, "sash-helper")); err != nil {
		return "", err
	}
	return digest, nil
}

// copyConsentedFile hashes the staged bytes, not a second read of the source:
// the digest describes exactly what the privileged publish step received.
func copyConsentedFile(source, expectedSha256, staged string) error {
	if !digestPattern.MatchString(expectedSha256) {
		return errors.New("consented file digest required")
	}
	if err := copyProtectedInput(source, staged); err != nil {
		return err
	}
	actual, err := fileSha256(staged)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(actual), []byte(expectedSha256)) != 1 {
		_ = os.Remove(staged)
		return errors.New("consented file digest mismatch")
	}
	return nil
}

// copyProtectedInput opens the source without following links, proves it is
// still the lstat'ed regular file, and creates an exclusive bounded copy.
func copyProtectedInput(source, target string) error {
	before, err := os.Lstat(source)
	if err != nil || !before.Mode().IsRegular() {
		return errors.New("expected a regular input file")
	}
	f, err := openRegular(source)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !os.SameFile(before, stat) || !stat.Mode().IsRegular() {
		return errors.New("input changed before opening")
	}
	if stat.Size() < 1 || stat.Size() > maxCoreSize {
		return errors.New("invalid input file size")
	}
	dest, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dest, io.LimitReader(f, maxCoreSize))
	syncErr := dest.Sync()
	closeErr := dest.Close()
	return errors.Join(copyErr, syncErr, closeErr)
}

func fileSha256(path string) (string, error) {
	f, err := openRegular(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, maxCoreSize+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
