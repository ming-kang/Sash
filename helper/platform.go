package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os/exec"
)

type Platform interface {
	BinDir() string
	WorkDir() string
	Listen(context.Context) (net.Listener, error)
	AuthorizePeer(net.Conn) bool
	VerifyProtectedPath(context.Context, string) error
	ValidateConfig(context.Context, string, []byte, string) error
	PrepareConfig(context.Context, []byte, string) ([]byte, error)
	RecoverNetwork(context.Context) error
	PrepareNetwork(context.Context, []byte, string) (NetworkSession, error)
}
type NetworkSession interface {
	RecordCoreStart(context.Context, int) error
	Cleanup(context.Context) error
}
type earlyListener interface{ ListenBeforeRecovery() bool }
type coreProcessPlatform interface {
	ConfigureCore(*exec.Cmd)
	TrackCore(context.Context, int) (io.Closer, error)
}
type controllerPeerPlatform interface {
	VerifyControllerPeer(context.Context, net.Conn, int) error
}

var errPlatformPending = errors.New("Go helper platform port is not implemented in this verification build")

// errDone signals that newPlatform already ran a one-shot mode (--recover,
// --install-consent) and main should exit successfully without serving.
var errDone = errors.New("platform one-shot mode finished")
