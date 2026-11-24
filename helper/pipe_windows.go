//go:build windows && !helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strings"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

var sidPattern = regexp.MustCompile(`^S-1-[0-9-]+$`)

// helperPipeSddl is the front-pipe DACL: full access for SYSTEM and OWNER
// RIGHTS (the SCM/dev session may run as either), and exactly the client
// rights for the installer user — no FILE_CREATE_PIPE_INSTANCE, WRITE_DAC,
// WRITE_OWNER or DELETE.
func helperPipeSddl(installerSid string) (string, error) {
	if !sidPattern.MatchString(installerSid) {
		return "", fmt.Errorf("invalid installer SID %q", installerSid)
	}
	return fmt.Sprintf(
		`D:P(A;;GA;;;SY)(A;;GA;;;OW)(A;;0x%x;;;%s)`,
		helperPipeClientRights, installerSid,
	), nil
}

// listenAclPipe binds \\.\pipe\sash-helper under the ACL'd SDDL. go-winio
// tags the first instance FILE_FLAG_FIRST_PIPE_INSTANCE, so a squatter that
// already owns the name makes this call fail (the SCM sees a failed start).
func listenAclPipe(ctx context.Context, pipePath, installerSid string) (net.Listener, error) {
	sddl, err := helperPipeSddl(installerSid)
	if err != nil {
		return nil, err
	}
	listener, err := winio.ListenPipe(pipePath, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		return nil, fmt.Errorf("named pipe %s: %w", pipePath, err)
	}
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	return listener, nil
}

// pipeHandle extracts the underlying pipe handle from a go-winio conn.
func pipeHandle(conn net.Conn) (windows.Handle, error) {
	holder, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return 0, errors.New("pipe connection does not expose its handle")
	}
	return windows.Handle(holder.Fd()), nil
}

var advapi = windows.NewLazySystemDLL("advapi32.dll")
var procImpersonateNamedPipeClient = advapi.NewProc("ImpersonateNamedPipeClient")

func impersonateNamedPipeClient(handle windows.Handle) error {
	r1, _, err := procImpersonateNamedPipeClient.Call(uintptr(handle))
	if r1 == 0 {
		if err != windows.ERROR_SUCCESS {
			return err
		}
		return windows.GetLastError()
	}
	return nil
}

// clientIsInstaller performs the per-connection peer check ON the accepted
// server-side handle: impersonate the client, open the thread token, compare
// its user SID to the installer's. RevertToSelf runs on every path; a failed
// revert is fatal for the service (the thread would keep a client identity).
func clientIsInstaller(conn net.Conn, installerSid string) bool {
	handle, err := pipeHandle(conn)
	if err != nil {
		fmt.Printf("[pipe-auth] rejected: %v\n", err)
		return false
	}
	if err := impersonateNamedPipeClient(handle); err != nil {
		fmt.Printf("[pipe-auth] impersonate failed: %v\n", err)
		return false
	}
	match, reverted := false, false
	func() {
		defer func() {
			if err := windows.RevertToSelf(); err != nil {
				reverted = false
				fmt.Printf("[pipe-auth] RevertToSelf failed: %v\n", err)
				return
			}
			reverted = true
		}()
		thread := windows.CurrentThread()
		var token windows.Token
		if err := windows.OpenThreadToken(
			thread, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_IMPERSONATE, false, &token,
		); err != nil {
			if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &token); err != nil {
				fmt.Printf("[pipe-auth] OpenThreadToken failed: %v\n", err)
				return
			}
		}
		defer token.Close()
		user, err := token.GetTokenUser()
		if err != nil {
			fmt.Printf("[pipe-auth] GetTokenUser failed: %v\n", err)
			return
		}
		match = user.User.Sid.String() == installerSid
	}()
	if !reverted {
		// Continuing under a client identity is forbidden: kill the process
		// the way the TS listener's fatal listener error does (SCM restart).
		fmt.Println("[pipe-auth] fatal: RevertToSelf failed after impersonation")
		os.Exit(1)
	}
	if !match {
		fmt.Println("[pipe-auth] rejected match=false")
	}
	return match
}

// serverProcessIdentity resolves the endpoint's server image + account from
// the server PID the kernel reports on a client pipe handle.
func serverProcessIdentity(handle windows.Handle) (pid uint32, image string, system bool, err error) {
	if err := windows.GetNamedPipeServerProcessId(handle, &pid); err != nil {
		return 0, "", false, err
	}
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid,
	)
	if err != nil {
		return pid, "", false, nil
	}
	defer windows.Close(h)
	{
		buf := make([]uint16, 32768)
		n := uint32(len(buf))
		if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil && n > 0 {
			image = windows.UTF16ToString(buf[:n])
		}
	}
	var token windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &token); err == nil {
		defer token.Close()
		if user, err := token.GetTokenUser(); err == nil {
			system = user.User.Sid.String() == sidLocalSystem
		}
	}
	return pid, image, system, nil
}

// connectAclPipe is the client side used by `pipe-client`: open the pipe
// with exactly the DACL's client mask at SECURITY_IMPERSONATION, then prove
// the endpoint is the protected SYSTEM service — image path + SYSTEM token.
func connectAclPipe(ctx context.Context, pipePath, serverImagePath string) (net.Conn, error) {
	deadline := time.Now().Add(10 * time.Second)
	var conn net.Conn
	var err error
	for {
		conn, err = winio.DialPipeAccessImpLevel(
			ctx, pipePath, helperPipeClientRights, winio.PipeImpLevelImpersonation,
		)
		if err == nil {
			break
		}
		transient := errors.Is(err, windows.ERROR_PIPE_BUSY) ||
			errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
			errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
		if !transient || time.Now().After(deadline) {
			return nil, fmt.Errorf("CreateFileW(%s) failed: %w", pipePath, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	handle, herr := pipeHandle(conn)
	if herr != nil {
		conn.Close()
		return nil, herr
	}
	pid, image, system, err := serverProcessIdentity(handle)
	if err != nil {
		conn.Close()
		return nil, err
	}
	normalize := func(s string) string {
		return strings.ToLower(strings.ReplaceAll(s, `\`, "/"))
	}
	if image == "" || normalize(image) != normalize(serverImagePath) || !system {
		conn.Close()
		return nil, fmt.Errorf(
			"helper pipe endpoint is not the protected SYSTEM service (pid %d, image %q, system=%v)",
			pid, image, system,
		)
	}
	return conn, nil
}
