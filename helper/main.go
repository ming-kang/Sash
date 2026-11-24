//go:build windows

// Command sash-tun-helper is the Windows TUN helper for Sash.
//
// It exists only to lend privilege: installed as a LocalSystem service, it
// starts and stops the one Core executable named at installation so that Core
// can create its TUN adapter and routes. It does not choose, verify, configure
// or talk to the Core — Sash does all of that through the Core's own
// controller, exactly as it does without TUN. Any Core version works.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/signal"

	"golang.org/x/sys/windows/svc"
)

var buildVersion = "dev"

const usage = `Usage:
  sash-tun-helper --version
  sash-tun-helper service <options>   started by the Service Control Manager
  sash-tun-helper run <options>       foreground, for diagnostics

Options:
  --user SID      the only account allowed on the control pipe
  --core PATH     Core executable
  --home DIR      Core home directory (-d)
  --config PATH   Core configuration file (-f)
  --stdout PATH   append Core standard output here
  --stderr PATH   append Core standard error here
  --pipe NAME     control pipe (default ` + defaultPipe + `)
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "sash-tun-helper:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(buildVersion)
		return nil
	}
	if len(args) == 0 || (args[0] != "service" && args[0] != "run") {
		fmt.Fprint(os.Stderr, usage)
		return errors.New("expected --version, service or run")
	}
	cfg, err := parseConfig(args[1:])
	if err != nil {
		return err
	}
	if args[0] == "run" {
		return runForeground(cfg)
	}
	isService, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !isService {
		return errors.New("the service command is started by the Service Control Manager; use run instead")
	}
	return svc.Run(serviceName, &service{cfg: cfg})
}

func runForeground(cfg config) error {
	host, listener, err := open(cfg)
	if err != nil {
		return err
	}
	defer host.close()
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	go serve(listener, host, cfg.home)
	fmt.Fprintf(os.Stderr, "sash-tun-helper %s listening on %s\n", buildVersion, cfg.pipe)
	<-interrupt
	_ = listener.Close()
	return host.stop()
}
