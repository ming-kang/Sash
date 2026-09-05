// SPDX-License-Identifier: MIT
//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func nativeStatus(root string) (status, error) {
	s, scmState, err := checkedService()
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		protected, e := protectedRoot()
		if e != nil {
			return status{}, e
		}
		if _, e = os.Stat(protected); e == nil {
			return status{}, failure("RECOVERY_REQUIRED", "Protected installation exists without its SCM registration")
		} else if !errors.Is(e, os.ErrNotExist) {
			return status{}, e
		}
		return status{Protocol: protocol, Supported: true, Installed: false, Running: false, Compatible: true, Version: version, Root: root}, nil
	}
	if err != nil {
		return status{}, err
	}
	s.Close()
	if scmState.State != svc.Running {
		return unavailableStatus(windows.GetCurrentProcessToken().IsElevated(), verifiedEnrollment)
	}
	transport := pipeTransport()
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return fetchStatus(ctx, root, transport)
}
func run(args []string) error {
	if len(args) == 0 {
		return failure("INVALID_REQUEST", "Expected version, privileges, status, repair-status, bridge, stage-maintenance, cleanup-maintenance, install, or uninstall")
	}
	if args[0] == "version" {
		if len(args) != 1 {
			return failure("INVALID_REQUEST", "version accepts no arguments")
		}
		return json.NewEncoder(os.Stdout).Encode(struct {
			Protocol int    `json:"protocol"`
			Version  string `json:"version"`
		}{protocol, version})
	}
	if args[0] == "run" {
		if len(args) != 1 {
			return failure("INVALID_REQUEST", "SCM entry accepts no arguments")
		}
		isService, err := svc.IsWindowsService()
		if err != nil {
			return err
		}
		if !isService {
			return failure("FORBIDDEN", "run is reserved for the Service Control Manager")
		}
		return svc.Run(serviceName, scmHandler{})
	}
	switch args[0] {
	case "start-service", "repair-status", "status", "bridge", "install", "uninstall", "privileges", "stage-maintenance", "cleanup-maintenance":
	default:
		return failure("INVALID_REQUEST", "Unknown native command")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "Canonical enrolled user data directory")
	var core, coreVersion, directory string
	if args[0] == "cleanup-maintenance" {
		flags.StringVar(&directory, "directory", "", "Protected maintenance staging directory")
	}
	if args[0] == "install" {
		flags.StringVar(&core, "core", "", "Administrator-approved staged executable")
		flags.StringVar(&coreVersion, "core-version", "", "Exact approved Core version")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return failure("INVALID_REQUEST", err.Error())
	}
	if flags.NArg() != 0 {
		return failure("INVALID_REQUEST", "Unexpected positional arguments")
	}
	canonical, err := canonicalRoot(*root)
	if err != nil {
		return err
	}
	switch args[0] {
	case "privileges":
		p, err := privileges(canonical)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(p)
	case "stage-maintenance":
		stage, err := stageMaintenance(canonical)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(stage)
	case "cleanup-maintenance":
		if err := cleanupMaintenance(canonical, directory); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": protocol, "cleaned": true})
	case "start-service":
		state, err := startExistingService(canonical)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(state)
	case "repair-status":
		state, err := repairStatus(canonical)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(state)
	case "status":
		state, err := nativeStatus(canonical)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(state)
	case "bridge":
		return bridge(canonical)
	case "install":
		if err = installService(canonical, core, coreVersion); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": protocol, "installed": true})
	case "uninstall":
		if err = uninstallService(canonical); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": protocol, "installed": false})
	}
	return failure("INVALID_REQUEST", "Unknown command")
}
func main() {
	if err := run(os.Args[1:]); err != nil {
		wire := &wireError{Code: "SERVICE_UNAVAILABLE", Message: "Native service operation failed"}
		var known *wireError
		if errors.As(err, &known) {
			wire = known
		}
		// stdout is a machine-readable error envelope only; verbose diagnostics are
		// separate from the bridge's single success startup line.
		var started *bridgeRuntimeError
		if !errors.As(err, &started) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"error": wire})
		}
		fmt.Fprintln(os.Stderr, wire)
		os.Exit(1)
	}
}

// Caller first validates the fixed SCM registration. Ordinary tokens never
// consult private metadata; neither fallback invents a Core observation.
func unavailableStatus(admin bool, load func() (enrollment, error)) (status, error) {
	out := status{Protocol: protocol, Supported: true, Installed: true, Running: false, Compatible: true, Version: version}
	if !admin {
		return out, nil
	}
	p, err := load()
	if err != nil {
		return status{}, err
	}
	out.Root, out.CoreVersion = p.Root, p.Core.Version
	out.Compatible = p.Protocol == protocol
	return out, nil
}
func verifiedEnrollment() (enrollment, error) {
	root, err := protectedRoot()
	if err != nil {
		return enrollment{}, err
	}
	sid, err := currentSID()
	if err != nil {
		return enrollment{}, err
	}
	locks, err := verifyTree(root, sid)
	if err != nil {
		return enrollment{}, err
	}
	defer closeHandles(locks)
	p, err := loadEnrollment(root)
	if err != nil {
		return enrollment{}, err
	}
	if p.Owner != sid {
		return enrollment{}, failure("OWNER_MISMATCH", "Protected enrollment belongs to another Windows user")
	}
	return p, nil
}
