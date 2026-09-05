// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/http"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var extendedTCPTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

// Microsoft SDK shared/tcpmib.h MIB_TCPROW_OWNER_PID has six DWORDs:
// state, local address, local port, remote address, remote port, owning PID.
// Read the ABI as bytes (addresses/ports are network order), avoiding Go struct
// alignment assumptions. TCP_TABLE_OWNER_PID_ALL is TCP_TABLE_CLASS value 5.
func controllerConnectionOwner(c net.Conn, pid uint32) error {
	local, ok := c.LocalAddr().(*net.TCPAddr)
	if !ok || !local.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		return errors.New("controller connection is not IPv4 loopback")
	}
	remote, ok := c.RemoteAddr().(*net.TCPAddr)
	if !ok || !remote.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		return errors.New("controller peer is not IPv4 loopback")
	}
	var size uint32
	ret, _, _ := extendedTCPTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 5, 0)
	if ret != uintptr(windows.ERROR_INSUFFICIENT_BUFFER) || size < 4 || size > 16<<20 {
		return failure("CORE_IDENTITY", "Cannot query controller connection ownership")
	}
	for range 3 {
		b := make([]byte, size)
		ret, _, _ = extendedTCPTable.Call(uintptr(unsafe.Pointer(&b[0])), uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 5, 0)
		runtime.KeepAlive(b)
		if ret == uintptr(windows.ERROR_INSUFFICIENT_BUFFER) {
			if size > 16<<20 {
				return errors.New("TCP table exceeds bound")
			}
			continue
		}
		if ret != 0 {
			return syscall.Errno(ret)
		}
		count := binary.LittleEndian.Uint32(b[:4])
		if uint64(count)*24+4 > uint64(len(b)) {
			return errors.New("invalid TCP ownership table")
		}
		for i := uint32(0); i < count; i++ {
			row := b[4+i*24 : 4+(i+1)*24]
			if binary.LittleEndian.Uint32(row[:4]) == 5 && net.IP(row[4:8]).Equal(remote.IP) && int(binary.BigEndian.Uint16(row[8:10])) == remote.Port && net.IP(row[12:16]).Equal(local.IP) && int(binary.BigEndian.Uint16(row[16:18])) == local.Port && binary.LittleEndian.Uint32(row[20:24]) == pid {
				return nil
			}
		}
		return failure("CORE_IDENTITY", "Controller socket is not owned by retained Core process")
	}
	return failure("CORE_IDENTITY", "Controller ownership table kept changing")
}
func ownedControllerTransport(p *ownedProcess, address string) *http.Transport {
	return &http.Transport{Proxy: nil, ForceAttemptHTTP2: false, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 20 * time.Second, DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
		if target != address {
			return nil, failure("CORE_IDENTITY", "Alternate controller destinations are forbidden")
		}
		var dialer net.Dialer
		dialer.Timeout = 2 * time.Second
		c, err := dialer.DialContext(ctx, "tcp4", address)
		if err != nil {
			return nil, err
		}
		running, err := p.running()
		if err != nil || !running {
			c.Close()
			return nil, failure("CORE_IDENTITY", "Owned Core is no longer running")
		}
		if err = controllerConnectionOwner(c, p.pid); err != nil {
			c.Close()
			return nil, err
		}
		running, err = p.running()
		if err != nil || !running {
			c.Close()
			return nil, failure("CORE_IDENTITY", "Owned Core exited during controller verification")
		}
		return c, nil
	}}
}
