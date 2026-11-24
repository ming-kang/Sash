package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

type schema func(any, string) error
type config map[string]any

func invalid(p string) error { return fmt.Errorf("Unsupported privileged Core %s", p) }
func shape(required []string, fields map[string]schema) schema {
	return func(x any, p string) error {
		m, ok := x.(map[string]any)
		if !ok {
			return invalid(p)
		}
		for k, v := range m {
			f, ok := fields[k]
			if !ok {
				return invalid(p + ": " + k)
			}
			if err := f(v, p+"."+k); err != nil {
				return err
			}
		}
		for _, k := range required {
			if _, ok := m[k]; !ok {
				return invalid(p + "." + k)
			}
		}
		return nil
	}
}
func object(m map[string]schema) schema { return shape(nil, m) }
func test(fn func(any) bool) schema {
	return func(x any, p string) error {
		if !fn(x) {
			return invalid(p)
		}
		return nil
	}
}

var str = test(func(x any) bool { _, ok := x.(string); return ok })
var flag = test(func(x any) bool { _, ok := x.(bool); return ok })
var enabled = test(func(x any) bool { b, ok := x.(bool); return ok && b })

func stringTest(f func(string) bool) schema {
	return test(func(x any) bool { s, ok := x.(string); return ok && f(s) })
}
func integer(max float64) schema {
	return test(func(x any) bool {
		var n float64
		switch v := x.(type) {
		case float64:
			n = v
		case int:
			n = float64(v)
		case int64:
			n = float64(v)
		case uint64:
			n = float64(v)
		case json.Number:
			var err error
			n, err = v.Float64()
			if err != nil {
				return false
			}
		default:
			return false
		}
		return n >= 0 && n <= max && n == math.Trunc(n)
	})
}
func choice(ss ...string) schema {
	return stringTest(func(x string) bool {
		for _, s := range ss {
			if x == s {
				return true
			}
		}
		return false
	})
}
func list(of schema) schema {
	return func(x any, p string) error {
		a, ok := x.([]any)
		if !ok {
			return invalid(p)
		}
		for i, v := range a {
			if err := of(v, fmt.Sprintf("%s.%d", p, i)); err != nil {
				return err
			}
		}
		return nil
	}
}
func record(of schema) schema {
	return func(x any, p string) error {
		m, ok := x.(map[string]any)
		if !ok {
			return invalid(p)
		}
		for k, v := range m {
			if err := of(v, p+"."+k); err != nil {
				return err
			}
		}
		return nil
	}
}
func either(a, b schema) schema {
	return func(x any, p string) error {
		if a(x, p) == nil {
			return nil
		}
		return b(x, p)
	}
}

var stringsList = list(str)
var strLists = record(either(str, stringsList))
var nonneg = integer(1<<53 - 1)
var intList = list(nonneg)
var stringOrIntList = list(either(nonneg, str))
var ports = integer(65535)
var mode = choice("rule", "global", "direct")
var logLevel = choice("silent", "error", "warning", "info", "debug")
var findProcess = choice("always", "strict", "off")
var deviceName = regexp.MustCompile("^[A-Za-z0-9_.-]{1,64}$")
var pathPart = regexp.MustCompile("^[A-Za-z0-9_.-]+$")
var reservedPart = regexp.MustCompile("(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\.|$)")
var webURL = stringTest(func(s string) bool {
	u, e := url.Parse(s)
	return e == nil && (strings.EqualFold(u.Scheme, "https") || strings.EqualFold(u.Scheme, "http")) && u.Hostname() != ""
})

func loopback(x any, p string) error {
	s, ok := x.(string)
	if ok {
		host, port, e := net.SplitHostPort(strings.TrimSpace(s))
		n, err := strconv.Atoi(port)
		if e == nil && err == nil && n > 0 && n <= 65535 && strconv.Itoa(n) == port && (host == "127.0.0.1" || host == "::1" || strings.EqualFold(host, "localhost")) {
			return nil
		}
	}
	return fmt.Errorf("Privileged Core requires a loopback address for %s", strings.TrimPrefix(p, "configuration."))
}

var proxySchema = shape([]string{"name", "type"}, map[string]schema{
	"name": str, "type": choice("ss", "vmess", "vless", "trojan", "socks5", "http", "hysteria2", "tuic", "anytls", "direct", "reject"),
	"server": str, "port": nonneg, "password": str, "username": str, "uuid": str, "cipher": str, "alterId": nonneg, "flow": str, "udp": flag,
	"network": choice("tcp", "ws", "grpc"), "dialer-proxy": str, "tls": flag, "sni": str, "servername": str, "skip-cert-verify": flag,
	"client-fingerprint": str, "alpn": stringsList,
	"ws-opts":      object(map[string]schema{"path": str, "headers": record(str), "max-early-data": nonneg, "early-data-header-name": str}),
	"grpc-opts":    object(map[string]schema{"grpc-service-name": str}),
	"reality-opts": shape([]string{"public-key"}, map[string]schema{"public-key": str, "short-id": str}),
	"obfs":         str, "obfs-password": str,
})
var groupSchema = shape([]string{"name", "type"}, map[string]schema{
	"name": str, "type": choice("select", "url-test", "fallback", "load-balance", "relay"), "proxies": stringsList, "use": stringsList,
	"url": webURL, "interval": nonneg, "tolerance": nonneg, "timeout": nonneg, "lazy": flag, "strategy": str,
	"expected-status": either(nonneg, str), "filter": str, "exclude-filter": str, "max-failed-times": nonneg,
	"include-all": flag, "hidden": flag, "icon": str,
})
var healthCheckSchema = object(map[string]schema{
	"enable": flag, "url": webURL, "interval": nonneg, "lazy": flag, "expected-status": either(nonneg, str), "timeout": str,
})
var rulesSchema = object(map[string]schema{
	"path": str, "type": choice("file", "http", "inline"), "behavior": choice("domain", "ipcidr", "classical"),
	"format": choice("yaml", "text", "mrs"), "interval": nonneg, "url": webURL, "payload": stringsList,
	"proxy": str, "header": strLists,
})
var providersSchema = shape([]string{"type"}, map[string]schema{
	"path": str, "type": choice("inline", "http", "file"), "payload": list(proxySchema),
	"url": webURL, "interval": nonneg, "header": strLists, "filter": str, "exclude-filter": str, "exclude-type": str,
	"proxy": str, "health-check": healthCheckSchema,
	"override": object(map[string]schema{"additional-prefix": str, "additional-suffix": str}),
})
var tunSchema = shape([]string{"enable"}, map[string]schema{
	"enable": enabled, "device": stringTest(deviceName.MatchString), "stack": choice("mixed", "system", "gvisor"), "dns-mode": str,
	"dns-hijack": stringsList, "auto-route": flag, "auto-detect-interface": flag, "strict-route": flag, "route-exclude-address": stringsList, "mtu": nonneg,
	"udp-timeout": nonneg, "gso": flag, "endpoint-independent-nat": flag, "disable-icmp-forwarding": flag, "congestion-controller": str,
	"route-address": stringsList, "route-address-set": stringsList, "route-exclude-address-set": stringsList,
	"include-interface": stringsList, "exclude-interface": stringsList,
	"include-uid": intList, "exclude-uid": intList, "include-uid-range": stringsList, "exclude-uid-range": stringsList,
	"include-android-user": intList, "include-package": stringsList, "exclude-package": stringsList,
	"exclude-src-port": intList, "exclude-dst-port": intList, "exclude-src-port-range": stringsList, "exclude-dst-port-range": stringsList,
	"auto-redirect": flag, "loopback-address": str,
})
var dnsSchema = shape([]string{"enable"}, map[string]schema{
	"enable": enabled, "ipv6": flag, "listen": loopback, "enhanced-mode": choice("fake-ip", "redir-host", "normal"), "fake-ip-range": str,
	"fake-ip-range6": str, "fake-ip-ttl": nonneg, "fake-ip-filter": stringsList, "fake-ip-filter-mode": str, "use-hosts": flag, "use-system-hosts": flag,
	"respect-rules": flag, "prefer-h3": flag, "nameserver": stringsList, "default-nameserver": stringsList, "proxy-server-nameserver": stringsList,
	"direct-nameserver": stringsList, "fallback": stringsList, "nameserver-policy": strLists, "proxy-server-nameserver-policy": strLists,
	"fallback-filter": object(map[string]schema{"geoip": flag, "geoip-code": str, "ipcidr": stringsList, "domain": stringsList, "geosite": stringsList}),
})
var snifferSchema = object(map[string]schema{
	"enable": flag, "force-dns-mapping": flag, "parse-pure-ip": flag, "override-destination": flag,
	"force-domain": stringsList, "skip-domain": stringsList, "skip-src-address": stringsList, "skip-dst-address": stringsList,
	"sniff":          record(object(map[string]schema{"ports": stringOrIntList, "override-destination": flag})),
	"port-whitelist": stringOrIntList,
})
var privilegedSchema = shape([]string{"external-controller", "secret", "tun", "dns"}, map[string]schema{
	"mixed-port": ports, "allow-lan": flag, "bind-address": str, "external-controller": loopback, "external-ui": str,
	"secret": stringTest(func(x string) bool { return strings.TrimSpace(x) != "" }), "mode": mode, "log-level": logLevel, "ipv6": flag,
	"unified-delay": flag, "tcp-concurrent": flag, "find-process-mode": findProcess, "geo-auto-update": flag, "geo-update-interval": nonneg,
	"geodata-mode": flag, "geoxurl": object(map[string]schema{"geoip": webURL, "geosite": webURL, "mmdb": webURL, "asn": webURL}),
	"profile": object(map[string]schema{"store-selected": flag, "store-fake-ip": flag}), "tun": tunSchema, "dns": dnsSchema,
	"udp": flag, "sniffer": snifferSchema,
	"hosts": strLists, "proxies": list(proxySchema), "proxy-groups": list(groupSchema), "rule-providers": record(rulesSchema),
	"proxy-providers": record(providersSchema), "rules": stringsList, "sub-rules": record(stringsList),
})

func yamlValue(n *yaml.Node, depth int) (any, error) {
	bad := errors.New("Unsupported privileged Core YAML structure")
	if depth > 64 || n.Anchor != "" || n.Kind == yaml.AliasNode {
		return nil, bad
	}
	switch n.Kind {
	case yaml.MappingNode:
		if n.ShortTag() != "!!map" {
			return nil, bad
		}
		m := map[string]any{}
		for i := 0; i < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode || k.Anchor != "" || k.ShortTag() != "!!str" {
				return nil, bad
			}
			if _, ok := m[k.Value]; ok {
				return nil, errors.New("duplicate privileged Core YAML key")
			}
			v, e := yamlValue(n.Content[i+1], depth+1)
			if e != nil {
				return nil, e
			}
			m[k.Value] = v
		}
		return m, nil
	case yaml.SequenceNode:
		if n.ShortTag() != "!!seq" {
			return nil, bad
		}
		a := make([]any, len(n.Content))
		for i, c := range n.Content {
			v, e := yamlValue(c, depth+1)
			if e != nil {
				return nil, e
			}
			a[i] = v
		}
		return a, nil
	case yaml.ScalarNode:
		switch n.ShortTag() {
		case "!!str":
			return n.Value, nil
		case "!!int", "!!float", "!!bool", "!!null":
			var v any
			if e := n.Decode(&v); e != nil {
				return nil, bad
			}
			return v, nil
		}
	}
	return nil, bad
}

func protectedRelativePath(root, s string) error {
	cleaned := path.Clean(strings.ReplaceAll(s, "\\", "/"))
	parts := strings.Split(cleaned, "/")
	if len(parts) < 2 {
		return errors.New("Configuration paths must use a subdirectory of the work directory")
	}
	for _, p := range parts {
		if !pathPart.MatchString(p) || p == "." || p == ".." || strings.HasSuffix(p, ".") || reservedPart.MatchString(p) {
			return errors.New("Configuration path escapes the protected Core work directory")
		}
	}
	for _, p := range parts {
		root = filepath.Join(root, p)
		info, err := os.Lstat(root)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Symbolic link in protected configuration path")
		}
	}
	return nil
}

func validateConfig(b []byte, root string) (config, error) {
	if !utf8.Valid(b) {
		return nil, errors.New("Invalid privileged Core YAML")
	}
	d := yaml.NewDecoder(bytes.NewReader(b))
	var n yaml.Node
	if d.Decode(&n) != nil || len(n.Content) != 1 {
		return nil, errors.New("Invalid privileged Core YAML")
	}
	var rest yaml.Node
	if d.Decode(&rest) != io.EOF {
		return nil, errors.New("Expected one privileged Core YAML document")
	}
	v, e := yamlValue(n.Content[0], 0)
	if e != nil {
		return nil, e
	}
	if e = privilegedSchema(v, "configuration"); e != nil {
		return nil, e
	}
	m := config(v.(map[string]any))
	check := func(x any) error {
		if s, ok := x.(string); ok {
			return protectedRelativePath(root, s)
		}
		return nil
	}
	if e = check(m["external-ui"]); e != nil {
		return nil, e
	}
	for _, g := range []string{"rule-providers", "proxy-providers"} {
		if ps, ok := m[g].(map[string]any); ok {
			for _, p := range ps {
				if e = check(p.(map[string]any)["path"]); e != nil {
					return nil, e
				}
			}
		}
	}
	return m, nil
}
