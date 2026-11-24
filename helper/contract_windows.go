//go:build helpercontract

package main

import (
	"github.com/Microsoft/go-winio"
	"net"
)

func contractListen(endpoint string) (net.Listener, error) { return winio.ListenPipe(endpoint, nil) }
