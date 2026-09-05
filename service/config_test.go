// SPDX-License-Identifier: MIT
package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func testBundle(t *testing.T, raw string) *bundle {
	t.Helper()
	var m map[string]any
	if err := decodeJSON([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return &bundle{Config: m}
}
func baseBundle(t *testing.T) *bundle {
	return testBundle(t, `{"mode":"rule","log-level":"info","mixed-port":18379,"allow-lan":false,"external-controller":"127.0.0.1:18380","secret":"unprivileged","proxies":[],"proxy-groups":[{"name":"PROXY","type":"select","proxies":["DIRECT"]}],"rules":["MATCH,PROXY"]}`)
}
func TestConfigInjectsPrivateIdentityWithoutMutatingInput(t *testing.T) {
	b := baseBundle(t)
	p, err := prepareBundle(b, "127.0.0.1:49152", "private")
	if err != nil {
		t.Fatal(err)
	}
	if p.Config["secret"] != "private" || p.Config["external-controller"] != "127.0.0.1:49152" {
		t.Fatal("private identity not injected")
	}
	if b.Config["secret"] != "unprivileged" {
		t.Fatal("input was mutated")
	}
	if p.Config["geo-auto-update"] != false {
		t.Fatal("automatic geo updates not disabled")
	}
}
func TestUnsafeTopLevelOptionsRejected(t *testing.T) {
	for _, key := range strings.Fields("external-ui external-ui-url external-ui-name external-controller-tls external-controller-unix external-controller-pipe listeners tunnels script sub-rules geox-url tls certificate private-key ebpf experimental sniffer payload path url upgrade hooks unknown") {
		t.Run(key, func(t *testing.T) {
			b := baseBundle(t)
			b.Config[key] = "bad"
			if _, err := prepareBundle(b, "127.0.0.1:1", "secret"); err == nil {
				t.Fatal("unsafe option accepted")
			}
		})
	}
}
func TestMalformedConfigTypesFailClosed(t *testing.T) {
	for _, raw := range []string{`{"proxies":null}`, `{"proxies":[null]}`, `{"mixed-port":65536}`, `{"dns":true}`, `{"tun":{"enable":"true"}}`, `{"mode":null}`, `{"proxy-groups":[{"name":"x","type":"select","proxies":{}}]}`, `{"proxies":[{"type":"ss","port":"443"}]}`, `{"proxy-providers":{"x":{"type":"http","url":"https://example.org","path":"providers/x"}}}`, `{"dns":{"nameserver":["file:///C:/secret"]}}`, `{"dns":{"nameserver":["https://example.org/dns-query?certificate=C:/secret"]}}`, `{"tun":{"enable":true}}`, `{"geo-auto-update":true}`, `{"external-controller":"0.0.0.0:9090"}`} {
		t.Run(raw, func(t *testing.T) {
			if _, err := prepareBundle(testBundle(t, raw), "127.0.0.1:1", "secret"); err == nil {
				t.Fatal("malformed config accepted")
			}
		})
	}
}
func TestProxyNestedFilesystemPolicy(t *testing.T) {
	for _, raw := range []string{`{"proxies":[{"type":"trojan","certificate":"C:/secret.pem"}]}`, `{"proxies":[{"type":"trojan","private-key":"../key.pem"}]}`, `{"proxies":[{"type":"wireguard","private-key":"C:/key"}]}`, `{"proxies":[{"type":"ss","plugin":"custom"}]}`, `{"proxies":[{"type":"vmess","ws-opts":{"path":"/safe","certificate":"bad"}}]}`, `{"proxies":[{"type":"vmess","grpc-opts":{"path":"bad"}}]}`, `{"proxy-providers":{"x":{"type":"inline","payload":[{"type":"trojan","certificate":"C:/key"}]}}}`} {
		if _, err := prepareBundle(testBundle(t, raw), "127.0.0.1:1", "secret"); err == nil {
			t.Fatalf("accepted: %s", raw)
		}
	}
	b := testBundle(t, `{"proxies":[{"type":"wireguard","private-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","reserved":[0,1,255]},{"type":"trojan","certificate":"-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----","private-key":"-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"}]}`)
	if _, err := prepareBundle(b, "127.0.0.1:1", "secret"); err != nil {
		t.Fatal(err)
	}
}
func TestAssetPathsAndRoles(t *testing.T) {
	for _, p := range []string{"../x", "/x", "C:/x", `providers\x`, "providers/x:stream", "providers/../x", "providers/CON", "providers/COM1.json", "providers/a.", "providers/x%2fy", "providers/a//b", "providers/.x", "providers/a/b/c"} {
		if relativeAsset(p) {
			t.Fatalf("unsafe path accepted: %s", p)
		}
	}
	for _, p := range []string{"providers/x.json", "providers/group/x.json", "geoip.dat"} {
		if !relativeAsset(p) {
			t.Fatalf("safe path rejected: %s", p)
		}
	}
	for _, p := range []string{"core.exe", "config.json", "private/policy.json", "providers/undeclared.json"} {
		b := baseBundle(t)
		b.Assets = []asset{{Path: p, Data: "eA=="}}
		if _, err := prepareBundle(b, "127.0.0.1:1", "secret"); err == nil {
			t.Fatalf("undeclared role accepted: %s", p)
		}
	}
	b := baseBundle(t)
	b.Assets = []asset{{"geoip.dat", "eA=="}, {"GEOIP.dat", "eA=="}}
	if _, err := prepareBundle(b, "127.0.0.1:1", "secret"); err == nil {
		t.Fatal("case alias accepted")
	}
}
func TestProviderJSONValidatedBeforePublication(t *testing.T) {
	raw := `{"proxy-providers":{"approved":{"type":"file","path":"providers/approved.json","health-check":{"enable":false}}},"rules":["MATCH,DIRECT"]}`
	for _, doc := range []string{`proxies: []`, `{"proxies":[{"type":"trojan","certificate":"C:/secret"}]}`, `{"proxies":[],"external-ui":"C:/"}`} {
		b := testBundle(t, raw)
		b.Assets = []asset{{"providers/approved.json", base64.StdEncoding.EncodeToString([]byte(doc))}}
		if _, err := prepareBundle(b, "127.0.0.1:1", "secret"); err == nil {
			t.Fatalf("unchecked provider accepted: %s", doc)
		}
	}
	b := testBundle(t, raw)
	b.Assets = []asset{{"providers/approved.json", base64.StdEncoding.EncodeToString([]byte(`{"proxies":[{"type":"ss","name":"safe","server":"example.org","port":443,"cipher":"aes-128-gcm","password":"x"}]}`))}}
	p, err := prepareBundle(b, "127.0.0.1:1", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Providers["proxy/approved"] {
		t.Fatal("provider refresh enrollment missing")
	}
	if !json.Valid(p.Assets["providers/approved.json"]) {
		t.Fatal("provider not semantic JSON")
	}
}
func TestTunAndGeoPolicy(t *testing.T) {
	b := baseBundle(t)
	b.Config["tun"] = map[string]any{"enable": true, "stack": "mixed", "auto-route": true}
	b.Config["dns"] = map[string]any{"enable": true, "nameserver": []any{"https://dns.google/dns-query"}}
	p, err := prepareBundle(b, "127.0.0.1:1", "secret")
	if err != nil || !p.Tun {
		t.Fatalf("valid TUN policy rejected: %v", err)
	}
	b.Config["rules"] = []any{"GEOIP,CN,DIRECT", "GEOSITE,cn,DIRECT", "MATCH,DIRECT"}
	if _, err = prepareBundle(b, "127.0.0.1:1", "secret"); err == nil {
		t.Fatal("implicit geo downloads allowed")
	}
	b.Assets = []asset{{"country.mmdb", "eA=="}, {"geosite.dat", "eA=="}}
	if _, err = prepareBundle(b, "127.0.0.1:1", "secret"); err != nil {
		t.Fatal(err)
	}
}

func TestServiceReferenceProfilePolicy(t *testing.T) {
	b := testBundle(t, `{"udp":true,"sniffer":{"enable":true,"parse-pure-ip":true,"sniff":{"TLS":{"ports":[443,8443]},"HTTP":{"ports":[80,"8080-8880"],"override-destination":true},"QUIC":{"ports":[443,8443]}},"skip-domain":["+.example.org"]},"tun":{"enable":true,"stack":"mixed","strict-route":true},"dns":{"enable":true,"enhanced-mode":"fake-ip","respect-rules":true,"proxy-server-nameserver":["1.1.1.1"],"fallback":["8.8.8.8"],"fallback-filter":{"geoip":true,"geosite":["reserved"]}},"proxies":[{"name":"fixture","type":"direct","udp":true}],"rules":["MATCH,DIRECT"]}`)
	b.Assets = []asset{{"country.mmdb", "eA=="}, {"geosite.dat", "eA=="}}
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err != nil {
		t.Fatal(err)
	}
}
func TestSnifferMalformedPolicy(t *testing.T) {
	for _, raw := range []string{`{"udp":"true"}`, `{"sniffer":{"path":"C:/secret"}}`, `{"sniffer":{"sniff":{"FTP":{}}}}`, `{"sniffer":{"enable":1}}`, `{"sniffer":{"sniff":{"TLS":{"ports":[0]}}}}`, `{"sniffer":{"sniff":{"HTTP":{"ports":["9000-8000"]}}}}`, `{"sniffer":{"sniff":{"HTTP":{"ports":["1-65536"]}}}}`, `{"sniffer":{"sniff":{"TLS":{"certificate":"C:/secret"}}}}`} {
		if _, err := prepareBundle(testBundle(t, raw), "127.0.0.1:1", "private"); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestGeoDetectionIgnoresDisabledFilterAndProxyNames(t *testing.T) {
	b := testBundle(t, `{"dns":{"fallback":["8.8.8.8"],"fallback-filter":{"geoip":false,"geoip-code":"CN"}},"proxies":[{"type":"direct","name":"GEOIP"}]}`)
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"dns":{"fallback":["8.8.8.8"]}}`, `{"rules":["AND,((GEOIP,CN),(NETWORK,UDP)),DIRECT"]}`, `{"dns":{"nameserver-policy":{"geosite:cn":"8.8.8.8"}}}`} {
		if _, err := prepareBundle(testBundle(t, raw), "127.0.0.1:1", "private"); err == nil {
			t.Fatalf("implicit geodata allowed: %s", raw)
		}
	}
}
func TestBundleCaps(t *testing.T) {
	if maxRequest != 176<<20 || maxConfig != 8<<20 {
		t.Fatal("wire caps diverged")
	}
	b := baseBundle(t)
	b.Assets = []asset{{"country.mmdb", strings.Repeat("A", base64.StdEncoding.EncodedLen(64<<20)+4)}}
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
		t.Fatal("oversized geodata accepted")
	}
	b = testBundle(t, `{"rule-providers":{"x":{"type":"file","path":"providers/x","format":"text","behavior":"domain"}}}`)
	b.Assets = []asset{{"providers/x", strings.Repeat("A", base64.StdEncoding.EncodedLen(8<<20)+4)}}
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
		t.Fatal("oversized provider accepted")
	}
}

func TestRuleProviderSemanticGeoPolicy(t *testing.T) {
	for _, doc := range []string{`{"payload":["GEO\u0049P,CN"]}`, `{"payload":["GEOS\u0049TE,cn"]}`, `{"payload":["IP-\u0041SN,13335"]}`} {
		b := testBundle(t, `{"rule-providers":{"x":{"type":"file","path":"providers/x.yaml","format":"yaml","behavior":"classical"}}}`)
		b.Assets = []asset{{"providers/x.yaml", base64.StdEncoding.EncodeToString([]byte(doc))}}
		before, _ := json.Marshal(b)
		if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
			t.Fatalf("escaped geo accepted: %s", doc)
		}
		b.Assets = append(b.Assets, asset{"country.mmdb", "eA=="}, asset{"geosite.dat", "eA=="}, asset{"ASN.mmdb", "eA=="})
		p, err := prepareBundle(b, "127.0.0.1:1", "private")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(p.Assets["providers/x.yaml"]), `\u004`) {
			t.Fatal("rule was not normalized")
		}
		b.Assets = b.Assets[:1]
		after, _ := json.Marshal(b)
		if string(before) != string(after) {
			t.Fatal("source bundle mutated")
		}
	}
	for _, doc := range []string{`payload: ["GEO\u0049P,CN"]`, `{"payload":null}`, `{"payload":[1]}`, `{"payload":[],"payload":[]}`, `{"payload":[],"other":true}`, `{"payload":["` + strings.Repeat("x", 8193) + `"]}`} {
		b := testBundle(t, `{"rule-providers":{"x":{"type":"file","path":"providers/x"}}}`)
		b.Assets = []asset{{"providers/x", base64.StdEncoding.EncodeToString([]byte(doc))}}
		if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
			t.Fatal("unchecked payload accepted")
		}
	}
	b := testBundle(t, `{"rule-providers":{"x":{"type":"inline","behavior":"classical","payload":["GEO\u0049P,CN"]}}}`)
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
		t.Fatal("escaped inline geo accepted")
	}
}
func TestRuleTextNormalizationAndMRSBehavior(t *testing.T) {
	b := testBundle(t, `{"rule-providers":{"x":{"type":"file","path":"providers/x","format":"text","behavior":"classical"}}}`)
	b.Assets = []asset{{"providers/x", base64.StdEncoding.EncodeToString([]byte("\ufeff# comment\r\n  GEOIP,CN \r\n"))}}
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
		t.Fatal("text geo accepted")
	}
	b.Assets = append(b.Assets, asset{"country.mmdb", "eA=="})
	p, err := prepareBundle(b, "127.0.0.1:1", "private")
	if err != nil || string(p.Assets["providers/x"]) != "GEOIP,CN\n" {
		t.Fatalf("text not normalized: %v", err)
	}
	b.Assets[0].Data = base64.StdEncoding.EncodeToString([]byte(`"GEO\u0049P,CN"`))
	if _, err := prepareBundle(b, "127.0.0.1:1", "private"); err == nil {
		t.Fatal("escaped text accepted")
	}
	for _, behavior := range []string{"classical", "domain", "ipcidr"} {
		b = testBundle(t, `{"rule-providers":{"x":{"type":"file","path":"providers/x","format":"mrs","behavior":"`+behavior+`"}}}`)
		b.Assets = []asset{{"providers/x", base64.StdEncoding.EncodeToString([]byte("\x00GEOIP\xff"))}}
		_, err := prepareBundle(b, "127.0.0.1:1", "private")
		if (err != nil) != (behavior == "classical") {
			t.Fatalf("MRS behavior %s: %v", behavior, err)
		}
	}
}
