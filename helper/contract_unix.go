//go:build helpercontract && (darwin || linux)

package main

import "net"

func contractListen(endpoint string) (net.Listener, error) { return net.Listen("unix", endpoint) }
