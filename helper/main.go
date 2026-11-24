package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"syscall"
)

func main() {
	args := os.Args[1:]
	if slices.Contains(args, "--version") {
		fmt.Println(buildVersion)
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	p, err := newPlatform(args)
	if errors.Is(err, errDone) {
		return
	}
	if err == nil {
		err = serve(ctx, p, coreSHA256)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "sash-helper:", err)
		os.Exit(1)
	}
}
