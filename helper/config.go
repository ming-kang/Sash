//go:build windows

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
)

const defaultPipe = `\\.\pipe\sash-tun`

var (
	sidPattern  = regexp.MustCompile(`^S-1-\d+(-\d+)+$`)
	pipePattern = regexp.MustCompile(`^\\\\\.\\pipe\\[A-Za-z0-9._-]+$`)
)

// config is fixed when the administrator installs the service: the control
// pipe never accepts a Core path, arguments or an account.
type config struct {
	user       string
	core       string
	home       string
	configFile string
	stdout     string
	stderr     string
	pipe       string
}

func parseConfig(args []string) (config, error) {
	var c config
	flags := flag.NewFlagSet("sash-tun-helper", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&c.user, "user", "", "")
	flags.StringVar(&c.core, "core", "", "")
	flags.StringVar(&c.home, "home", "", "")
	flags.StringVar(&c.configFile, "config", "", "")
	flags.StringVar(&c.stdout, "stdout", "", "")
	flags.StringVar(&c.stderr, "stderr", "", "")
	flags.StringVar(&c.pipe, "pipe", defaultPipe, "")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 {
		return c, fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if !sidPattern.MatchString(c.user) {
		return c, errors.New("--user must be an account SID")
	}
	for _, path := range []struct{ name, value string }{
		{"--core", c.core},
		{"--home", c.home},
		{"--config", c.configFile},
		{"--stdout", c.stdout},
		{"--stderr", c.stderr},
	} {
		if !filepath.IsAbs(path.value) {
			return c, fmt.Errorf("%s must be an absolute path", path.name)
		}
	}
	if !pipePattern.MatchString(c.pipe) {
		return c, errors.New(`--pipe must look like \\.\pipe\name`)
	}
	return c, nil
}
