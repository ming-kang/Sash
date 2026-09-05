// SPDX-License-Identifier: MIT
package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayStrictRouteMatrix(t *testing.T) {
	providers := map[string]bool{"proxy/approved": true, "rule/rules": true}
	for _, tc := range []struct {
		method, path, body string
		ok                 bool
	}{
		{"GET", "/proxies/US%3A1", "", true}, {"PUT", "/proxies/Group%3A%20One", `{"name":"DIRECT"}`, true},
		{"GET", "/proxies/%E6%97%A5%E6%9C%AC%3A1/delay?url=https%3A%2F%2Fexample.org&timeout=1000", "", true},
		{"GET", "/%63onfigs", "", false}, {"GET", "/proxies/a%2Fdelay", "", false},
		{"GET", "/proxies/%2e%2e", "", false}, {"GET", "/proxies/%252e%252e", "", false},
		{"GET", "/version", "", true}, {"GET", "/configs", "", true}, {"GET", "/traffic", "", true}, {"GET", "/logs?level=info", "", true}, {"GET", "/connections", "", true}, {"GET", "/proxies/PROXY/delay?url=https%3A%2F%2Fexample.org&timeout=1000", "", true},
		{"PATCH", "/configs", `{"mode":"global","log-level":"warning"}`, true}, {"PUT", "/proxies/PROXY", `{"name":"DIRECT"}`, true}, {"DELETE", "/connections/id", "", true}, {"PUT", "/providers/proxies/approved", "", true}, {"PUT", "/providers/rules/rules", "", true}, {"GET", "/providers/proxies/approved/healthcheck", "", true},
		{"PUT", "/configs", `{"path":"C:/bad"}`, false}, {"PATCH", "/configs", `{"tun":{"enable":true}}`, false}, {"PATCH", "/configs", `{"mode":"rule","secret":"leak"}`, false}, {"PATCH", "/configs", `{"mode":"global","mode":"rule"}`, false}, {"PATCH", "/configs", `{"log-level":"bogus"}`, false},
		{"POST", "/restart", "", false}, {"POST", "/upgrade", "", false}, {"GET", "/cache/fakeip/flush", "", false}, {"POST", "/cache/fakeip/flush", "", false}, {"PUT", "/providers/proxies/unknown", "", false}, {"PUT", "/providers/proxies/approved", `{"payload":"bad"}`, false}, {"PUT", "/proxies/PROXY", `{"name":"DIRECT","path":"C:/bad"}`, false},
		{"GET", "/configs?secret=x", "", false}, {"GET", "/configs?", "{}", false}, {"GET", "/logs?level=info&level=debug", "", false}, {"GET", "/proxies/a/delay?url=file%3A%2F%2F%2FC%3A%2Fsecret", "", false}, {"GET", "/configs/", "", false}, {"GET", "//configs", "", false}, {"GET", "/configs/../upgrade", "", false}, {"GET", "/proxies/a%2Fb", "", false}, {"GET", "/version/upgrade", "", false},
	} {
		t.Run(tc.method+tc.path+tc.body, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			err := gatewayRequest(req, providers)
			if (err == nil) != tc.ok {
				t.Fatalf("allowed=%v want=%v: %v", err == nil, tc.ok, err)
			}
		})
	}
}
func TestGatewayWebsocketOnlyOnTelemetry(t *testing.T) {
	for _, p := range []string{"/traffic", "/logs", "/connections", "/memory", "/configs", "/version"} {
		r := httptest.NewRequest("GET", p, nil)
		r.Header.Set("Upgrade", "websocket")
		err := gatewayRequest(r, nil)
		want := p != "/configs" && p != "/version"
		if (err == nil) != want {
			t.Fatalf("unexpected upgrade policy %s: %v", p, err)
		}
	}
}
func TestConfigsResponseNeverReturnsPrivateFields(t *testing.T) {
	b, err := publicConfigs([]byte(`{"secret":"PRIVATE","external-controller":"127.0.0.1:1","future-secret":"PRIVATE","authentication":["PRIVATE"],"mode":"rule","tun":{"enable":true,"future-secret":"PRIVATE"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "PRIVATE") || strings.Contains(string(b), "external-controller") {
		t.Fatalf("credential leak: %s", b)
	}
	if !strings.Contains(string(b), `"mode":"rule"`) || !strings.Contains(string(b), `"enable":true`) {
		t.Fatal("public dashboard fields missing")
	}
}
