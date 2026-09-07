//go:build windows

// Test-only linked-token launcher. Never distributed with the production helper.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const acknowledgement = "I_ACKNOWLEDGE_DISPOSABLE_WINDOWS_VM_SERVICE_TEST"

func checkedElevation(t windows.Token) (bool, error) {
	var elevated, size uint32
	err := windows.GetTokenInformation(t, windows.TokenElevation, (*byte)(unsafe.Pointer(&elevated)), 4, &size)
	if err != nil || size != 4 {
		return false, fmt.Errorf("cannot establish token elevation")
	}
	return elevated != 0, nil
}

func run() error {
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || os.Getenv("SASH_VM_ACK") != acknowledgement {
		return fmt.Errorf("disposable hosted VM acknowledgement required")
	}
	args := os.Args[1:]
	child := len(args) > 0 && args[0] == "--child"
	if child {
		args = args[1:]
	}
	if len(args) < 1 || len(args) > 16 || len(strings.Join(args, " ")) > 16000 || !filepath.IsAbs(args[0]) || !strings.EqualFold(filepath.Base(args[0]), "node.exe") {
		return fmt.Errorf("expected bounded absolute Node command")
	}
	current := windows.GetCurrentProcessToken()
	user, err := current.GetTokenUser()
	if err != nil {
		return err
	}
	elevated, err := checkedElevation(current)
	if err != nil {
		return err
	}
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	if child {
		member, err := windows.Token(0).IsMember(admin)
		if err != nil {
			return err
		}
		if elevated || member || user.User.Sid.String() != os.Getenv("SASH_VM_SID") {
			return fmt.Errorf("ordinary same-SID token proof failed")
		}
		if len(args) == 2 && args[1] == "--version" {
			fmt.Fprintln(os.Stderr, "ordinary same-SID token verified")
		}
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = os.Environ()
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		return cmd.Run()
	}
	if !elevated {
		return fmt.Errorf("launcher parent must be elevated")
	}
	linked, err := current.GetLinkedToken()
	if err != nil {
		return fmt.Errorf("no UAC linked token: ordinary-user acceptance cannot run on this VM; no elevated fallback")
	}
	defer linked.Close()
	linkedUser, err := linked.GetTokenUser()
	if err != nil {
		return err
	}
	linkedElevated, err := checkedElevation(linked)
	if err != nil {
		return err
	}
	if linkedElevated || !linkedUser.User.Sid.Equals(user.User.Sid) {
		return fmt.Errorf("linked token is not an unelevated same-SID token")
	}
	var primary windows.Token
	if err = windows.DuplicateTokenEx(linked, windows.TOKEN_ALL_ACCESS, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		return err
	}
	defer primary.Close()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, append([]string{"--child"}, args...)...)
	// Explicit allowlist: no workflow credentials, npm auth, proxy or Node injection.
	for _, name := range []string{"SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SASH_HOME", "RUNNER_TEMP", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "SASH_VM_ACK"} {
		if value, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "SASH_VM_SID="+user.User.Sid.String())
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(primary)}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

func main() {
	if err := run(); err != nil {
		// Never relay child output/argv or private paths in a launcher error.
		if _, ok := err.(*exec.ExitError); ok {
			fmt.Fprintln(os.Stderr, "ordinary child failed")
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
