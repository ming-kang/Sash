package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const sampleConfig = "external-controller: 127.0.0.1:9090\nsecret: value\ntun: {enable: true}\ndns: {enable: true}\n"

func TestWhitelist(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name, text string
		ok         bool
	}{
		{"valid", sampleConfig + "rule-providers: {local: {path: rules/local.yaml}}\n", true},
		{"path", sampleConfig + "external-ui: ../ui\n", false},
		{"windows drive", sampleConfig + "proxy-providers: {remote: {type: inline, payload: [], path: 'C:/proxy.yaml'}}\n", false},
		{"reserved", sampleConfig + "external-ui: assets/NUL.html\n", false},
		{"not loopback", strings.Replace(sampleConfig, "127.0.0.1", "0.0.0.0", 1), false},
		{"nested override", strings.Replace(sampleConfig, "enable: true", "enable: true, iproute2-table-index: 1", 1), false},
		{"nested duplicate", strings.Replace(sampleConfig, "enable: true", "enable: true, enable: false", 1), false},
		{"controller socket", sampleConfig + "external-controller-unix: core.sock\n", false},
		{"script", sampleConfig + "script: {}\n", false},
		{"file URL", sampleConfig + "geoxurl: {geoip: file:///etc/passwd}\n", false},
		{"plugin", sampleConfig + "proxies: [{name: test, type: ss, plugin: custom}]\n", false},
		{"remote proxy provider", sampleConfig + "proxy-providers: {remote: {type: http, url: https://example.com/proxies, path: providers/remote.yaml}}\n", true},
		{"dot-slash path", sampleConfig + "rule-providers: {local: {path: ./rules/local.yaml}}\n", true},
		{"top-level path", sampleConfig + "external-ui: ./ui\n", false},
		{"anytls proxy", sampleConfig + "proxies: [{name: test, type: anytls, server: example.com, port: 443, password: p}]\n", true},
		{"sniffer", sampleConfig + "sniffer: {enable: true, sniff: {TLS: {ports: [443, 8443-8490], override-destination: true}}}\n", true},
		{"udp", sampleConfig + "udp: true\n", true},
		{"tun tuning", strings.Replace(sampleConfig, "tun: {enable: true}", "tun: {enable: true, udp-timeout: 300, gso: true, route-address: [1.0.0.0/8]}", 1), true},
		{"tun iproute2", strings.Replace(sampleConfig, "tun: {enable: true}", "tun: {enable: true, iproute2-table-index: 2022}", 1), false},
		{"fake-ip-ttl", strings.Replace(sampleConfig, "dns: {enable: true}", "dns: {enable: true, fake-ip-ttl: 1}", 1), true},
		{"rule provider proxy", sampleConfig + "rule-providers: {ads: {type: http, behavior: domain, format: mrs, url: https://example.com/a.mrs, path: rules/ads.mrs, proxy: PROXY}}\n", true},
		{"group extras", sampleConfig + "proxy-groups: [{name: g, type: url-test, proxies: [a], expected-status: 204, filter: x, max-failed-times: 5}]\n", true},
		{"duplicate", sampleConfig + "secret: other\n", false},
		{"quoted duplicate", sampleConfig + "'secret': other\n", false},
		{"anchor", strings.Replace(sampleConfig, "value", "&anchor value", 1), false},
		{"alias", strings.Replace(sampleConfig, "value", "*missing", 1), false},
		{"merge", sampleConfig + "<<: {mode: global}\n", false},
		{"tag", strings.Replace(sampleConfig, "value", "!!binary dGVzdA==", 1), false},
		{"multiple documents", sampleConfig + "---\n" + sampleConfig, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := validateConfig([]byte(tc.text), dir)
			if (err == nil) != tc.ok {
				t.Fatalf("validation: %v", err)
			}
			if tc.ok {
				b, err := yaml.Marshal(cfg)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = validateConfig(b, dir); err != nil {
					t.Fatalf("canonical config: %v", err)
				}
			}
		})
	}
	t.Run("symlink", func(t *testing.T) {
		if err := os.Symlink(t.TempDir(), filepath.Join(dir, "rules")); err != nil {
			t.Skip(err)
		}
		if _, err := validateConfig([]byte(sampleConfig+"rule-providers: {local: {path: rules/local.yaml}}\n"), dir); err == nil {
			t.Fatal("accepted symlink")
		}
	})
}
