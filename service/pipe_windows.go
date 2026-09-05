// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// FILE_READ_DATA|FILE_WRITE_DATA|FILE_READ_EA|FILE_WRITE_EA|
// FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE.
// In particular this is NOT GENERIC_WRITE/FILE_GENERIC_WRITE: bit 0x4 means
// FILE_CREATE_PIPE_INSTANCE, not innocuous append-data on a pipe.
const pipeClientAccess uint32 = 0x0012019b

func pipeSD(owner string) (string, error) {
	if _, err := windows.StringToSid(owner); err != nil {
		return "", err
	}
	return "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0012019b;;;" + owner + ")", nil
}
func pipeHandle(c net.Conn) (windows.Handle, error) {
	f, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return 0, errors.New("named pipe does not expose a native handle")
	}
	return windows.Handle(f.Fd()), nil
}
func querySCM(access uint32) (*mgr.Service, error) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	defer windows.CloseServiceHandle(scm)
	name, err := windows.UTF16PtrFromString(serviceName)
	if err != nil {
		return nil, err
	}
	h, err := windows.OpenService(scm, name, access)
	if err != nil {
		return nil, err
	}
	return &mgr.Service{Name: serviceName, Handle: h}, nil
}
func expectedCommand(root string) string {
	return windows.EscapeArg(filepath.Join(root, "sash-service.exe")) + " run"
}
func checkedService() (*mgr.Service, svc.Status, error) {
	s, err := querySCM(windows.SERVICE_QUERY_STATUS | windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return nil, svc.Status{}, err
	}
	fail := func(err error) (*mgr.Service, svc.Status, error) { s.Close(); return nil, svc.Status{}, err }
	root, err := protectedRoot()
	if err != nil {
		return fail(err)
	}
	config, err := s.Config()
	if err != nil {
		return fail(err)
	}
	if !strings.EqualFold(config.BinaryPathName, expectedCommand(root)) || !strings.EqualFold(config.ServiceStartName, "LocalSystem") || config.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS {
		return fail(failure("REGISTRATION_MISMATCH", "Service registration identity changed"))
	}
	state, err := s.Query()
	if err != nil {
		return fail(err)
	}
	return s, state, nil
}

type verifiedPipe struct {
	net.Conn
	process windows.Handle
	once    sync.Once
}

func (p *verifiedPipe) Close() error {
	err := p.Conn.Close()
	p.once.Do(func() { _ = windows.CloseHandle(p.process) })
	return err
}
func dialVerifiedPipe(ctx context.Context) (net.Conn, error) {
	s, st, err := checkedService()
	if err != nil {
		return nil, err
	}
	defer s.Close()
	if st.State != svc.Running || st.ProcessId == 0 {
		return nil, failure("SERVICE_UNAVAILABLE", "Installed service is not running")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, st.ProcessId)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			_ = windows.CloseHandle(process)
		}
	}()
	image := make([]uint16, 32768)
	n := uint32(len(image))
	if err = windows.QueryFullProcessImageName(process, 0, &image[0], &n); err != nil {
		return nil, err
	}
	root, err := protectedRoot()
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(windows.UTF16ToString(image[:n]), filepath.Join(root, "sash-service.exe")) {
		return nil, failure("REGISTRATION_MISMATCH", "Service process image differs from fixed installation")
	}
	// Verify ACLs using this caller's SID before trusting SYSTEM to serve requests.
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	locks, err := lockComponents(root)
	if err != nil {
		return nil, err
	}
	defer closeHandles(locks)
	if err = verifyAncestors(locks[:len(locks)-1]); err != nil {
		return nil, err
	}
	if err = verifyPrivateACL(locks[len(locks)-1], sid, true); err != nil {
		return nil, err
	}
	helper, err := openNoReparse(filepath.Join(root, "sash-service.exe"))
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(helper)
	if err = verifyPrivateACL(helper, sid, true); err != nil {
		return nil, err
	}
	// A normal user cannot query a SYSTEM process token on all Windows policies.
	// SCM's validated LocalSystem registration and retained process/image identity
	// are authoritative; do not request privileged token-query rights here.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c, err := winio.DialPipeAccessImpLevel(ctx, pipeName, pipeClientAccess, winio.PipeImpLevelIdentification)
	if err != nil {
		return nil, err
	}
	h, err := pipeHandle(c)
	if err != nil {
		c.Close()
		return nil, err
	}
	var pid uint32
	if err = windows.GetNamedPipeServerProcessId(h, &pid); err != nil {
		c.Close()
		return nil, err
	}
	after, err := s.Query()
	if err != nil {
		c.Close()
		return nil, err
	}
	wait, err := windows.WaitForSingleObject(process, 0)
	if err != nil || wait != uint32(windows.WAIT_TIMEOUT) || pid != st.ProcessId || after.ProcessId != pid || after.State != svc.Running {
		c.Close()
		return nil, failure("SERVICE_IDENTITY", "Named pipe server is not the retained SCM process")
	}
	success = true
	return &verifiedPipe{Conn: c, process: process}, nil
}

// Microsoft namedpipeapi.h declares BOOL ImpersonateNamedPipeClient(HANDLE).
// x/sys exposes OpenThreadToken/RevertToSelf but not this entry point.
var impersonatePipe = windows.NewLazySystemDLL("advapi32.dll").NewProc("ImpersonateNamedPipeClient")

func authenticatedSID(c net.Conn) (string, error) {
	h, err := pipeHandle(c)
	if err != nil {
		return "", err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, callErr := impersonatePipe.Call(uintptr(h))
	if result == 0 {
		return "", fmt.Errorf("pipe impersonation: %w", callErr)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil { // Never return an impersonated thread to Go's pool.
			fmt.Fprintln(os.Stderr, "Fatal: failed to revert pipe impersonation")
			os.Exit(1)
		}
	}()
	var token windows.Token
	if err = windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

type pipeContextKey struct{}

func pipeServer(owner string, handler http.Handler) (*http.Server, net.Listener, error) {
	sd, err := pipeSD(owner)
	if err != nil {
		return nil, nil, err
	}
	// go-winio v0.6.2 uses FILE_PIPE_REJECT_REMOTE_CLIENTS and FILE_CREATE for
	// the first instance. It fails rather than attaching to a pre-existing pipe.
	listener, err := winio.ListenPipe(pipeName, &winio.PipeConfig{SecurityDescriptor: sd, InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		return nil, nil, err
	}
	server := &http.Server{ErrorLog: log.New(os.Stderr, "", log.LstdFlags|log.LUTC), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, pipeContextKey{}, c)
		},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, ok := r.Context().Value(pipeContextKey{}).(net.Conn)
			if !ok {
				writeError(w, failure("OWNER_MISMATCH", "Missing kernel pipe identity"))
				return
			}
			// HTTP has consumed bytes before impersonation, as required by Windows.
			sid, err := authenticatedSID(c)
			if err != nil || sid != owner {
				writeError(w, failure("OWNER_MISMATCH", "Named pipe client is not enrolled user"))
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxRequest)
			handler.ServeHTTP(w, r)
		}),
	}
	return server, listener, nil
}
