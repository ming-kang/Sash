//go:build windows

package main

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
)

const serviceName = "SashTun"

type service struct {
	cfg config
}

func (s *service) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	helper, err := openHelper(s.cfg)
	if err != nil {
		s.report(err)
		return false, 1
	}
	defer helper.close()
	defer func() {
		if err := helper.shutdown(); err != nil {
			s.report(err)
		}
	}()
	go helper.serve()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			status <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			return false, 0
		}
	}
	return false, 0
}

// report appends a service failure to the Core's error log, where Sash
// already looks when a Core fails to start.
func (s *service) report(err error) {
	reportIssue(s.cfg.stderr, err)
}

func reportIssue(logPath string, err error) {
	file, openErr := openLog(logPath)
	if openErr != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s [sash-tun-helper] %v\n", time.Now().Format(time.RFC3339), err)
}
