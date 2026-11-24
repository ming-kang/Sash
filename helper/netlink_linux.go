//go:build !helpercontract

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func parseIpJSON[T ~map[string]any | ~[]map[string]any](out, label string) (T, error) {
	trimmed := strings.TrimSpace(out)
	var zero T
	if trimmed == "" {
		return zero, nil
	}
	var v T
	if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
		return zero, fmt.Errorf("invalid ip(8) %s output", label)
	}
	return v, nil
}

func ipList(out, label string) ([]map[string]any, error) {
	return parseIpJSON[[]map[string]any](out, label)
}

func listObjects(v any) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func strField(m map[string]any, key string) (string, bool) {
	v, ok := m[key].(string)
	return v, ok
}

func numField(m map[string]any, key string) (int, bool) {
	switch v := m[key].(type) {
	case float64:
		return int(v), v == float64(int(v))
	case int:
		return v, true
	case json.Number:
		n, err := strconv.Atoi(string(v))
		return n, err == nil
	}
	return 0, false
}

func isInterfaceRule(rule map[string]any, device string) bool {
	iif, _ := strField(rule, "iif")
	oif, _ := strField(rule, "oif")
	return iif == device || oif == device
}

func isInterfaceRoute(route map[string]any, device string) bool {
	dev, _ := strField(route, "dev")
	return dev == device
}

// Kernel-proven attribution: the interface a Core process actually
// holds a TUN fd for, via /proc/<pid>/fdinfo `iff:` rows.
func coreTunDevice(ctx context.Context, run runFunc, pid int, procRoot string) (name string, ifindex int, ok bool) {
	fdinfoDir := filepath.Join(procRoot, strconv.Itoa(pid), "fdinfo")
	entries, err := os.ReadDir(fdinfoDir)
	if err != nil {
		return "", 0, false
	}
	iff := regexp.MustCompile(`(?m)^iff:\t(.+)$`)
	var names []string
	for _, entry := range entries {
		text, err := os.ReadFile(filepath.Join(fdinfoDir, entry.Name()))
		if err != nil {
			continue
		}
		if m := iff.FindSubmatch(text); m != nil {
			names = append(names, strings.TrimSpace(string(m[1])))
		}
	}
	for _, n := range names {
		out, err := run(ctx, "ip", "-j", "link", "show", "dev", n)
		if err != nil {
			continue
		}
		links, err := ipList(out, "link")
		if err != nil || len(links) == 0 {
			continue
		}
		if idx, ok := numField(links[0], "ifindex"); ok && idx != 0 {
			return n, idx, true
		}
	}
	return "", 0, false
}

// Full-object identity: every field must agree, no extra live fields.
func objectIdentical(live, recorded map[string]any) bool {
	keys := map[string]bool{}
	for k := range live {
		keys[k] = true
	}
	for k := range recorded {
		keys[k] = true
	}
	for k := range keys {
		lv, lok := live[k]
		rv, rok := recorded[k]
		if lok != rok {
			return false
		}
		lj, _ := json.Marshal(lv)
		rj, _ := json.Marshal(rv)
		if lok && string(lj) != string(rj) {
			return false
		}
	}
	return true
}

var detachedKeys = map[string]bool{"iif_detached": true, "oif_detached": true}

// `*_detached` is runtime state, not identity.
func stripDetached(rule map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range rule {
		if !detachedKeys[k] {
			out[k] = v
		}
	}
	return out
}

func ruleMatches(rule, recorded map[string]any) bool {
	return objectIdentical(stripDetached(rule), stripDetached(recorded))
}

// The complete deletable selector of a live `ip -j rule` object.
func ruleSelectorPairs(rule map[string]any) [][2]string {
	pairs := [][2]string{}
	rangeOf := func(lo, hi any) string {
		if lo == nil {
			return ""
		}
		if hi != nil && hi != lo {
			return fmt.Sprintf("%v-%v", lo, hi)
		}
		return fmt.Sprintf("%v", lo)
	}
	if _, ok := rule["not"]; ok {
		pairs = append(pairs, [2]string{"not", "not"})
	}
	if from, ok := firstPresent(rule, "from", "src"); ok {
		v := fmt.Sprintf("%v", from)
		if l, ok := rule["srclen"]; ok {
			v = fmt.Sprintf("%v/%v", v, l)
		}
		pairs = append(pairs, [2]string{"from", v})
	}
	if to, ok := firstPresent(rule, "to", "dst"); ok {
		v := fmt.Sprintf("%v", to)
		if l, ok := rule["dstlen"]; ok {
			v = fmt.Sprintf("%v/%v", v, l)
		}
		pairs = append(pairs, [2]string{"to", v})
	}
	if v, ok := rule["tos"]; ok && v != nil {
		pairs = append(pairs, [2]string{"tos", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["fwmark"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		if m, ok := rule["fwmask"]; ok && m != nil {
			s += fmt.Sprintf("/%v", m)
		}
		pairs = append(pairs, [2]string{"fwmark", s})
	}
	// The interface name is emitted even when `*_detached` is set: the
	// kernel keeps iifname after the device dies and rule_find compares.
	if v, ok := rule["iif"]; ok && v != nil {
		pairs = append(pairs, [2]string{"iif", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["oif"]; ok && v != nil {
		pairs = append(pairs, [2]string{"oif", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["l3mdev"]; ok && v != nil && v != false {
		pairs = append(pairs, [2]string{"l3mdev", "l3mdev"})
	}
	if v, ok := rule["ipproto"]; ok && v != nil {
		pairs = append(pairs, [2]string{"ipproto", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["sport_start"], rule["sport_end"]); v != "" {
		pairs = append(pairs, [2]string{"sport", v})
	} else if v, ok := rule["sport"]; ok && v != nil {
		pairs = append(pairs, [2]string{"sport", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["dport_start"], rule["dport_end"]); v != "" {
		pairs = append(pairs, [2]string{"dport", v})
	} else if v, ok := rule["dport"]; ok && v != nil {
		pairs = append(pairs, [2]string{"dport", fmt.Sprintf("%v", v)})
	}
	if v := rangeOf(rule["uid_start"], rule["uid_end"]); v != "" {
		pairs = append(pairs, [2]string{"uidrange", v})
	} else if v, ok := rule["uidrange"]; ok && v != nil {
		pairs = append(pairs, [2]string{"uidrange", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["suppress_prefixlength"]; ok && v != nil {
		pairs = append(pairs, [2]string{"suppress_prefixlength", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["suppress_ifgroup"]; ok && v != nil {
		pairs = append(pairs, [2]string{"suppress_ifgroup", fmt.Sprintf("%v", v)})
	}
	if _, ok := rule["nop"]; ok {
		pairs = append(pairs, [2]string{"nop", "nop"})
	}
	if v, ok := numField(rule, "priority"); ok {
		pairs = append(pairs, [2]string{"pref", strconv.Itoa(v)})
	}
	if v, ok := firstPresent(rule, "table", "lookup"); ok {
		pairs = append(pairs, [2]string{"lookup", fmt.Sprintf("%v", v)})
	}
	if v, ok := rule["goto"]; ok && v != nil {
		pairs = append(pairs, [2]string{"goto", fmt.Sprintf("%v", v)})
	}
	return pairs
}

func firstPresent(m map[string]any, keys ...string) (any, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

// Rebuild a full `ip rule del` selector from a live `ip -j` rule object.
func ruleDeleteArgs(rule map[string]any) []string {
	var args []string
	for _, pair := range ruleSelectorPairs(rule) {
		if pair[0] == pair[1] {
			args = append(args, pair[0])
		} else {
			args = append(args, pair[0], pair[1])
		}
	}
	return args
}

// Whether `name` is a non-persistent TUN whose detail response answers
// for the SAME ifindex the journal verified.
func isDisposableTun(ctx context.Context, run runFunc, name string, ifindex int) (bool, error) {
	out, err := run(ctx, "ip", "-j", "-d", "link", "show", "dev", name)
	if err != nil {
		return false, err
	}
	parsed, err := ipList(out, "link")
	if err != nil {
		return false, err
	}
	if len(parsed) == 0 {
		return false, nil
	}
	entry := parsed[0]
	idx, _ := numField(entry, "ifindex")
	info, _ := entry["linkinfo"].(map[string]any)
	data, _ := info["info_data"].(map[string]any)
	return idx == ifindex &&
		info["info_kind"] == "tun" &&
		data["type"] == "tun" &&
		data["persist"] == false, nil
}

// The recorded selector re-bound to the interface's verified live name.
func rebindInterfaceFields(recorded map[string]any, boundName string) map[string]any {
	if boundName == "" {
		return recorded
	}
	merged := map[string]any{}
	for k, v := range recorded {
		merged[k] = v
	}
	for _, k := range []string{"iif", "oif", "dev"} {
		if _, ok := merged[k].(string); ok {
			merged[k] = boundName
		}
	}
	return merged
}

// iproute2 errors that mean the object is already gone.
var alreadyGoneRe = regexp.MustCompile(`(?i)No such process|No such file|does not exist|Cannot find device|ifindex.*does not exist`)

func isAlreadyGone(err error) bool {
	return err != nil && alreadyGoneRe.MatchString(err.Error())
}

func listAllLinks(ctx context.Context, run runFunc) ([]map[string]any, error) {
	out, err := run(ctx, "ip", "-j", "link", "show")
	if err != nil {
		return nil, err
	}
	return ipList(out, "link")
}

type netObjects struct {
	rules  []map[string]any
	routes []map[string]any
}

// Exact IPv4 (`ip`) or IPv6 (`ip -6`) rule/route tables; a kernel
// without IPv6 support yields an empty family table.
var v6UnsupportedRe = regexp.MustCompile(`(?i)address family|not supported|ipv6.*(disabled|unsupported)|EINVAL`)
var fibTableMissingRe = regexp.MustCompile(`(?i)table does not exist|FIB table`)

func listNetObjects(ctx context.Context, run runFunc, family string, table string) (netObjects, error) {
	flag := "-4"
	if family == "6" {
		// No if_inet6 means the kernel lacks IPv6 entirely; `ip -6` then
		// exits nonzero with error text that varies by iproute2 version.
		if _, err := os.Stat("/proc/net/if_inet6"); err != nil {
			return netObjects{[]map[string]any{}, []map[string]any{}}, nil
		}
		flag = "-6"
	}
	var out netObjects
	ruleText, err := run(ctx, "ip", flag, "-j", "rule", "show")
	if err != nil {
		if family == "6" && v6UnsupportedRe.MatchString(err.Error()) {
			return netObjects{[]map[string]any{}, []map[string]any{}}, nil
		}
		return out, err
	}
	if out.rules, err = ipList(ruleText, "rule"); err != nil {
		return out, err
	}
	routeText, err := run(ctx, "ip", flag, "-j", "route", "show", "table", table)
	if err != nil {
		if fibTableMissingRe.MatchString(err.Error()) {
			out.routes = []map[string]any{}
			return out, nil
		}
		return out, err
	}
	if out.routes, err = ipList(routeText, "route"); err != nil {
		return out, err
	}
	return out, nil
}
