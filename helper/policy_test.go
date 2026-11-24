package main

import (
	"strings"
	"testing"
)

func TestControllerPolicy(t *testing.T) {
	for _, p := range strings.Fields("/version /configs /proxies /group /rules /connections /proxies/a%20b/delay /group/g/delay /providers/proxies /providers/rules /providers/proxies/p/healthcheck /providers/proxies/p/n/healthcheck /traffic /memory /logs?level=info /connections?interval=1000 /dns/query?name=example.com&type=A") {
		if _, ok := controllerTarget("GET", p); !ok {
			t.Errorf("denied %s", p)
		}
	}
	for _, tc := range []struct {
		method, path string
		want         action
	}{
		{"PUT", "/proxies/g", selectAction}, {"PUT", "/providers/proxies/p", proxyAction},
		{"PUT", "/providers/rules/r", proxyAction}, {"DELETE", "/connections", proxyAction},
		{"DELETE", "/connections/id", proxyAction}, {"DELETE", "/proxies/g", proxyAction},
		{"POST", "/cache/dns/flush", proxyAction}, {"PUT", "/storage/dashboard", proxyAction},
		{"PATCH", "/configs/", patchAction}, {"POST", "/restart/", restartAction},
	} {
		if r, ok := controllerTarget(tc.method, tc.path); !ok || r.action != tc.want {
			t.Errorf("incorrect route for %v: %v", tc, r)
		}
	}
	if route, ok := controllerTarget("GET", "/logs?token=test"); !ok || route.path != "/logs" {
		t.Error("did not strip token")
	}
	for _, tc := range [][2]string{
		{"PUT", "/configs"}, {"PUT", "/%63onfigs/"}, {"POST", "/configs/geo"}, {"POST", "/upgrade"},
		{"GET", "/upgrade/ui"}, {"POST", "/restart/extra"}, {"GET", "/debug"}, {"GET", "/%64ebug/pprof/"},
		{"GET", "/storage/data?targetPath=%2Fetc%2Fconfig"}, {"PUT", "/proxies/%2f..%2fconfigs"},
		{"PUT", "/proxies/%252f..%252fconfigs"}, {"PUT", "/proxies/%2e%2e"}, {"GET", "//version"},
		{"GET", "/group/g/delay?url=file%3A%2F%2F%2Fetc%2Fconfig"},
	} {
		if _, ok := controllerTarget(tc[0], tc[1]); ok {
			t.Errorf("allowed %v", tc)
		}
	}
}
func TestControllerBodies(t *testing.T) {
	for _, tc := range []struct {
		a  action
		b  string
		ok bool
	}{
		{selectAction, "{\"name\":\"Sash\"}", true}, {selectAction, "{\"name\":1}", false},
		{selectAction, "{\"name\":\"Sash\",\"path\":\"config.yaml\"}", false}, {selectAction, "[]", false}, {selectAction, "{}", false},
		{patchAction, "{\"mode\":\"global\",\"ipv6\":true,\"tun\":{\"enable\":true}}", true},
		{patchAction, "{\"mode\":\"unknown\"}", false}, {patchAction, "{\"external-ui\":\"anything\"}", false},
		{patchAction, "{\"geoxurl\":{\"geoip\":\"/tmp/db\"}}", false}, {patchAction, "{\"tuic-server\":{\"certificate\":\"/tmp/cert\"}}", false},
		{patchAction, "{\"tun\":{\"enable\":false}}", false}, {patchAction, "{\"tun\":{\"enable\":true,\"file-descriptor\":10}}", false},
		{patchAction, "{\"tun\":{\"enable\":true,\"device\":\"tun2\"}}", false}, {patchAction, "{\"tun\":{\"enable\":false,\"enable\":true}}", false},
	} {
		if _, err := controllerBody([]byte(tc.b), tc.a, false); (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.b, err)
		}
	}
}
