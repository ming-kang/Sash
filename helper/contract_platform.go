//go:build helpercontract

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
)

type contractPlatform struct{ bin, work, endpoint string }

func newPlatform(args []string) (Platform, error) {
	if len(args) != 4 || args[0] != "--contract" {
		return nil, errors.New("expected contract-only helper arguments")
	}
	return contractPlatform{args[1], args[2], args[3]}, nil
}
func (p contractPlatform) BinDir() string                                  { return p.bin }
func (p contractPlatform) WorkDir() string                                 { return p.work }
func (contractPlatform) AuthorizePeer(net.Conn) bool                       { return true }
func (contractPlatform) VerifyProtectedPath(context.Context, string) error { return nil }
func (contractPlatform) ValidateConfig(context.Context, string, []byte, string) error {
	return errPlatformPending
}
func (contractPlatform) PrepareConfig(context.Context, []byte, string) ([]byte, error) {
	return nil, errPlatformPending
}
func (contractPlatform) RecoverNetwork(context.Context) error { return nil }
func (contractPlatform) PrepareNetwork(context.Context, []byte, string) (NetworkSession, error) {
	return nil, errPlatformPending
}
func (p contractPlatform) Listen(context.Context) (net.Listener, error) {
	l, e := contractListen(p.endpoint)
	if e == nil {
		fmt.Println("ready")
	}
	return l, e
}
