// SPDX-License-Identifier: MIT
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

// This is an allowlist, not a list of currently known dangerous options. New
// Core features remain unavailable until their filesystem semantics are audited.
var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$`)
var reservedWindows = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)`)

func relativeAsset(p string) bool {
	if len(p) > 220 || strings.ContainsAny(p, `\:%`) || path.Clean(p) != p || strings.HasPrefix(p, "/") {
		return false
	}
	parts := strings.Split(p, "/")
	if len(parts) > 3 {
		return false
	}
	for _, s := range parts {
		if !segmentPattern.MatchString(s) || strings.HasSuffix(s, ".") || reservedWindows.MatchString(s) {
			return false
		}
	}
	return true
}
func unsafeConfig(s string) error { return failure("UNSAFE_CONFIG", s) }
func keys(m map[string]any, allowed string, where string) error {
	set := map[string]bool{}
	for _, k := range strings.Fields(allowed) {
		set[k] = true
	}
	for k := range m {
		if !set[k] {
			return unsafeConfig(fmt.Sprintf("Unsupported option %s.%s", where, k))
		}
	}
	return nil
}
func object(v any, where string) (map[string]any, error) {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil, unsafeConfig(where + " must be an object")
	}
	return m, nil
}
func scalarOptions(m map[string]any, bools, numbers, texts string) error {
	for _, k := range strings.Fields(bools) {
		if v, ok := m[k]; ok {
			if _, ok := v.(bool); !ok {
				return unsafeConfig(k + " must be boolean")
			}
		}
	}
	for _, k := range strings.Fields(numbers) {
		if v, ok := m[k]; ok {
			n, ok := v.(json.Number)
			if !ok {
				return unsafeConfig(k + " must be numeric")
			}
			f, err := n.Int64()
			if err != nil || f < 0 || f > 2147483647 {
				return unsafeConfig(k + " is out of range")
			}
		}
	}
	for _, k := range strings.Fields(texts) {
		if v, ok := m[k]; ok {
			s, ok := v.(string)
			if !ok || len(s) > 65536 || strings.ContainsRune(s, 0) {
				return unsafeConfig(k + " must be a bounded string")
			}
		}
	}
	return nil
}
func stringList(v any, where string) error {
	a, ok := v.([]any)
	if !ok || len(a) > 10000 {
		return unsafeConfig(where + " must be a bounded string array")
	}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || len(s) > 8192 || strings.ContainsRune(s, 0) {
			return unsafeConfig(where + " has an invalid item")
		}
	}
	return nil
}
func enum(m map[string]any, k, values string) error {
	if v, ok := m[k]; ok {
		s, ok := v.(string)
		if !ok || !strings.Contains(" "+values+" ", " "+s+" ") || s == "" {
			return unsafeConfig("Invalid " + k)
		}
	}
	return nil
}
func inlinePEM(v any, kind string) bool {
	s, ok := v.(string)
	return ok && strings.HasPrefix(s, "-----BEGIN ") && strings.Contains(s, kind+"-----") && strings.Contains(s, "-----END ") && len(s) <= 65536
}

func checkProxy(m map[string]any) error {
	if err := keys(m, "name type server port cipher password uuid alterId security udp tls skip-cert-verify servername sni network client-fingerprint fingerprint alpn flow packet-encoding username tfo fast-open udp-over-tcp dialer-proxy ip-version ws-opts grpc-opts reality-opts certificate private-key public-key preshared-key ip ipv6 mtu reserved remote-dns-resolve dns up down obfs obfs-password ports hop-interval reduce-rtt disable-sni", "proxy"); err != nil {
		return err
	}
	if err := enum(m, "type", "direct ss socks5 http vmess vless trojan hysteria2 wireguard"); err != nil {
		return err
	}
	if _, ok := m["type"]; !ok {
		return unsafeConfig("Proxy type is required")
	}
	if err := scalarOptions(m, "udp tls skip-cert-verify tfo fast-open udp-over-tcp remote-dns-resolve reduce-rtt disable-sni", "port alterId mtu hop-interval", "name server cipher password uuid security servername sni network client-fingerprint fingerprint flow packet-encoding username dialer-proxy ip-version public-key preshared-key ip ipv6 up down obfs obfs-password ports"); err != nil {
		return err
	}
	if err := enum(m, "network", "tcp ws grpc"); err != nil {
		return err
	}
	for _, k := range []string{"alpn", "dns"} {
		if v, ok := m[k]; ok {
			if err := stringList(v, k); err != nil {
				return err
			}
		}
	}
	if v, ok := m["certificate"]; ok && !inlinePEM(v, "CERTIFICATE") {
		return unsafeConfig("Only inline PEM certificates are permitted")
	}
	if v, ok := m["private-key"]; ok {
		if m["type"] == "wireguard" {
			s, ok := v.(string)
			b, err := base64.StdEncoding.Strict().DecodeString(s)
			if !ok || err != nil || len(b) != 32 {
				return unsafeConfig("Invalid inline WireGuard private key")
			}
		} else if !inlinePEM(v, "PRIVATE KEY") {
			return unsafeConfig("Only inline PEM private keys are permitted")
		}
	}
	if v, ok := m["reserved"]; ok {
		a, ok := v.([]any)
		if !ok || len(a) != 3 {
			return unsafeConfig("Invalid WireGuard reserved bytes")
		}
		for _, v := range a {
			n, ok := v.(json.Number)
			if !ok {
				return unsafeConfig("Invalid reserved byte")
			}
			i, err := n.Int64()
			if err != nil || i < 0 || i > 255 {
				return unsafeConfig("Invalid reserved byte")
			}
		}
	}
	for _, spec := range []struct{ k, allowed string }{{"ws-opts", "path headers max-early-data early-data-header-name"}, {"grpc-opts", "grpc-service-name"}, {"reality-opts", "public-key short-id"}} {
		if v, ok := m[spec.k]; ok {
			o, err := object(v, spec.k)
			if err != nil {
				return err
			}
			if err = keys(o, spec.allowed, spec.k); err != nil {
				return err
			}
			if err = scalarOptions(o, "", "max-early-data", "path early-data-header-name grpc-service-name public-key short-id"); err != nil {
				return err
			}
			if v, ok := o["headers"]; ok {
				h, err := object(v, "ws headers")
				if err != nil {
					return err
				}
				for k, v := range h {
					s, ok := v.(string)
					if !ok || len(k) > 256 || len(s) > 8192 || strings.ContainsAny(k+s, "\r\n\x00") {
						return unsafeConfig("Invalid websocket header")
					}
				}
			}
		}
	}
	return nil
}
func checkProxyList(v any) error {
	a, ok := v.([]any)
	if !ok || len(a) > 20000 {
		return unsafeConfig("proxies must be a bounded array")
	}
	for _, v := range a {
		m, err := object(v, "proxy")
		if err != nil {
			return err
		}
		if err = checkProxy(m); err != nil {
			return err
		}
	}
	return nil
}

type preparedBundle struct {
	Config    map[string]any
	Assets    map[string][]byte
	Providers map[string]bool
	Tun       bool
}

func prepareBundle(b *bundle, controller, secret string) (*preparedBundle, error) {
	if b == nil || b.Config == nil {
		return nil, unsafeConfig("A parsed config object is required")
	}
	raw, err := json.Marshal(b.Config)
	if err != nil || len(raw) > maxConfig {
		return nil, unsafeConfig("Config exceeds size limit")
	}
	// Make a semantic copy; validation never mutates the caller's bundle.
	var m map[string]any
	if err := decodeJSON(raw, &m); err != nil {
		return nil, err
	}
	if err := keys(m, "mixed-port port socks-port allow-lan bind-address external-controller secret mode log-level ipv6 unified-delay tcp-concurrent find-process-mode interface-name routing-mark proxies proxy-groups rules proxy-providers rule-providers dns tun hosts profile geodata-mode geodata-loader geo-auto-update geo-update-interval global-client-fingerprint keep-alive-interval keep-alive-idle disable-keep-alive udp sniffer", "config"); err != nil {
		return nil, err
	}
	if err := scalarOptions(m, "allow-lan ipv6 unified-delay tcp-concurrent geodata-mode geo-auto-update disable-keep-alive udp", "mixed-port port socks-port routing-mark geo-update-interval keep-alive-interval keep-alive-idle", "bind-address external-controller secret mode log-level find-process-mode interface-name geodata-loader global-client-fingerprint"); err != nil {
		return nil, err
	}
	if err := enum(m, "mode", "rule global direct"); err != nil {
		return nil, err
	}
	if err := enum(m, "log-level", "silent error warning info debug"); err != nil {
		return nil, err
	}
	for _, k := range []string{"mixed-port", "port", "socks-port"} {
		if v, ok := m[k]; ok {
			n, _ := v.(json.Number).Int64()
			if n > 65535 {
				return nil, unsafeConfig("Invalid listener port")
			}
		}
	}
	if v, ok := m["external-controller"]; ok {
		s := v.(string)
		h, p, err := net.SplitHostPort(s)
		if err != nil || h != "127.0.0.1" || p == "" {
			return nil, unsafeConfig("Controller must be IPv4 loopback")
		}
	}
	if m["geo-auto-update"] == true {
		return nil, unsafeConfig("Automatic privileged geo downloads are disabled; supply approved assets")
	}
	m["geo-auto-update"] = false
	m["external-controller"] = controller
	m["secret"] = secret
	if v, ok := m["proxies"]; ok {
		if err := checkProxyList(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["rules"]; ok {
		if err := stringList(v, "rules"); err != nil {
			return nil, err
		}
	}
	if v, ok := m["proxy-groups"]; ok {
		a, ok := v.([]any)
		if !ok || len(a) > 10000 {
			return nil, unsafeConfig("Invalid proxy groups")
		}
		for _, v := range a {
			g, err := object(v, "proxy group")
			if err != nil {
				return nil, err
			}
			if err = keys(g, "name type proxies use url interval lazy timeout max-failed-times tolerance strategy disable-udp hidden icon include-all include-all-proxies include-all-providers filter exclude-filter exclude-type", "proxy group"); err != nil {
				return nil, err
			}
			if err = enum(g, "type", "select url-test fallback load-balance relay"); err != nil {
				return nil, err
			}
			if err = scalarOptions(g, "lazy disable-udp hidden include-all include-all-proxies include-all-providers", "interval timeout max-failed-times tolerance", "name type url strategy icon filter exclude-filter exclude-type"); err != nil {
				return nil, err
			}
			for _, k := range []string{"proxies", "use"} {
				if v, ok := g[k]; ok {
					if err = stringList(v, k); err != nil {
						return nil, err
					}
				}
			}
			if v, ok := g["url"]; ok {
				if !httpURL(v) {
					return nil, unsafeConfig("Invalid probe URL")
				}
			}
		}
	}
	out := &preparedBundle{Config: m, Assets: map[string][]byte{}, Providers: map[string]bool{}}
	roles := map[string]string{}
	ruleFormats := map[string]string{}
	var ruleStrings []string
	for _, k := range []string{"proxy-providers", "rule-providers"} {
		if v, ok := m[k]; ok {
			ps, err := object(v, k)
			if err != nil {
				return nil, err
			}
			if len(ps) > 512 {
				return nil, unsafeConfig("Too many providers")
			}
			for name, v := range ps {
				if name == "" || len(name) > 128 || strings.ContainsAny(name, "/\\%\x00") {
					return nil, unsafeConfig("Invalid provider name")
				}
				p, err := object(v, k)
				if err != nil {
					return nil, err
				}
				if err = keys(p, "type path payload behavior format health-check", k); err != nil {
					return nil, err
				}
				if err = enum(p, "type", "file inline"); err != nil {
					return nil, err
				}
				// Remote proxy-provider documents could introduce unvalidated certificate
				// paths on refresh. Only already-validated local/inline providers are safe.
				typ, _ := p["type"].(string)
				if typ != "file" && typ != "inline" {
					return nil, unsafeConfig("Provider type must be file or inline")
				}
				if err = enum(p, "behavior", "domain ipcidr classical"); err != nil {
					return nil, err
				}
				if err = enum(p, "format", "yaml text mrs"); err != nil {
					return nil, err
				}
				if k == "rule-providers" && p["format"] == "mrs" && p["behavior"] != "domain" && p["behavior"] != "ipcidr" {
					return nil, unsafeConfig("MRS requires domain or ipcidr behavior")
				}
				if typ == "file" {
					dest, ok := p["path"].(string)
					if !ok || !relativeAsset(dest) || !strings.HasPrefix(dest, "providers/") {
						return nil, unsafeConfig("Provider paths must be bounded relative providers/ paths")
					}
					folded := strings.ToLower(dest)
					if _, ok := roles[folded]; ok {
						return nil, unsafeConfig("Aliased provider paths")
					}
					roles[folded] = k
					if k == "rule-providers" {
						format, _ := p["format"].(string)
						if format == "" {
							format = "yaml"
						}
						ruleFormats[folded] = format
					}
					if _, ok := p["payload"]; ok {
						return nil, unsafeConfig("File provider cannot contain payload")
					}
				} else {
					if _, ok := p["path"]; ok {
						return nil, unsafeConfig("Inline provider cannot specify path")
					}
					if k == "proxy-providers" {
						if err = checkProxyList(p["payload"]); err != nil {
							return nil, err
						}
					} else if err = stringList(p["payload"], "rule payload"); err != nil {
						return nil, err
					}
				}
				if v, ok := p["health-check"]; ok {
					h, err := object(v, "health-check")
					if err != nil {
						return nil, err
					}
					if err = keys(h, "enable url interval timeout lazy expected-status", "health-check"); err != nil {
						return nil, err
					}
					if err = scalarOptions(h, "enable lazy", "interval timeout", "url expected-status"); err != nil {
						return nil, err
					}
					if v, ok := h["url"]; ok && !httpURL(v) {
						return nil, unsafeConfig("Invalid provider probe URL")
					}
				}
				out.Providers[strings.TrimSuffix(k, "-providers")+"/"+name] = true
			}
		}
	}
	for _, k := range []string{"hosts"} {
		if v, ok := m[k]; ok {
			h, err := object(v, k)
			if err != nil {
				return nil, err
			}
			for _, v := range h {
				if _, ok := v.(string); !ok {
					if err = stringList(v, k); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	if v, ok := m["profile"]; ok {
		p, err := object(v, "profile")
		if err != nil {
			return nil, err
		}
		if err = keys(p, "store-selected store-fake-ip", "profile"); err != nil {
			return nil, err
		}
		if err = scalarOptions(p, "store-selected store-fake-ip", "", ""); err != nil {
			return nil, err
		}
	}
	if v, ok := m["sniffer"]; ok {
		if err := checkSniffer(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["dns"]; ok {
		if err := checkDNS(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["tun"]; ok {
		t, err := object(v, "tun")
		if err != nil {
			return nil, err
		}
		if err = keys(t, "enable stack device auto-route auto-detect-interface strict-route mtu dns-hijack", "tun"); err != nil {
			return nil, err
		}
		if err = scalarOptions(t, "enable auto-route auto-detect-interface strict-route", "mtu", "stack device"); err != nil {
			return nil, err
		}
		if err = enum(t, "stack", "mixed system gvisor"); err != nil {
			return nil, err
		}
		if v, ok := t["device"]; ok && !segmentPattern.MatchString(v.(string)) {
			return nil, unsafeConfig("Invalid TUN device")
		}
		if v, ok := t["dns-hijack"]; ok {
			if err = stringList(v, "dns-hijack"); err != nil {
				return nil, err
			}
		}
		out.Tun = t["enable"] == true
	}
	if out.Tun {
		d, ok := m["dns"].(map[string]any)
		if !ok || d["enable"] != true {
			return nil, unsafeConfig("TUN requires enabled DNS")
		}
	}
	if len(b.Assets) > 512 {
		return nil, unsafeConfig("Too many assets")
	}
	total := len(raw)
	seen := map[string]bool{}
	for _, a := range b.Assets {
		folded := strings.ToLower(a.Path)
		if !relativeAsset(a.Path) || seen[folded] {
			return nil, unsafeConfig("Invalid or aliased asset path")
		}
		seen[folded] = true
		role, declared := roles[folded]
		if !declared && a.Path != "geoip.dat" && a.Path != "geosite.dat" && a.Path != "country.mmdb" && a.Path != "ASN.mmdb" {
			return nil, unsafeConfig("Asset has no declared provider or known geo role")
		}
		limit := 8 << 20
		if !declared {
			limit = 64 << 20
		}
		if len(a.Data) > base64.StdEncoding.EncodedLen(limit) {
			return nil, unsafeConfig("Oversized encoded asset")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(a.Data)
		if err != nil || len(data) == 0 || len(data) > limit {
			return nil, unsafeConfig("Invalid or oversized asset")
		}
		originalSize := len(data)
		total += len(data)
		if total > 128<<20 {
			return nil, unsafeConfig("Asset total exceeds limit")
		}
		if role == "proxy-providers" {
			var doc struct {
				Proxies []any `json:"proxies"`
			}
			if err = decodeJSON(data, &doc); err != nil {
				return nil, unsafeConfig("Privileged proxy-provider assets must be parsed JSON, not unchecked YAML")
			}
			if err = checkProxyList(doc.Proxies); err != nil {
				return nil, err
			}
			data, err = json.Marshal(doc)
			if err != nil {
				return nil, err
			}
		}
		if role == "rule-providers" && ruleFormats[folded] != "mrs" {
			var payload []any
			if ruleFormats[folded] == "yaml" {
				var doc struct {
					Payload []any `json:"payload"`
				}
				if err = decodeJSON(data, &doc); err != nil {
					return nil, unsafeConfig("Rule YAML assets must be strict parsed JSON payloads")
				}
				payload = doc.Payload
				if payload == nil {
					return nil, unsafeConfig("Rule payload must be a string array")
				}
			} else {
				if !utf8.Valid(data) {
					return nil, unsafeConfig("Rule text must be UTF-8")
				}
				text := strings.TrimPrefix(string(data), "\ufeff")
				text = strings.ReplaceAll(text, "\r\n", "\n")
				payload = []any{}
				for _, line := range strings.Split(text, "\n") {
					line = strings.TrimSpace(line)
					if line == "" || strings.HasPrefix(line, "#") {
						continue
					}
					if strings.ContainsAny(line, "\\\"'\r\ufeff\x00") {
						return nil, unsafeConfig("Ambiguous rule text")
					}
					payload = append(payload, line)
				}
			}
			if err = stringList(payload, "rule payload"); err != nil {
				return nil, err
			}
			for _, item := range payload {
				ruleStrings = append(ruleStrings, item.(string))
			}
			if ruleFormats[folded] == "yaml" {
				data, err = json.Marshal(struct {
					Payload []any `json:"payload"`
				}{payload})
				if err != nil {
					return nil, err
				}
			} else {
				lines := make([]string, len(payload))
				for i, item := range payload {
					lines[i] = item.(string)
				}
				data = []byte(strings.Join(lines, "\n") + "\n")
			}
		}
		total += len(data) - originalSize
		if len(data) > limit || total > 128<<20 {
			return nil, unsafeConfig("Normalized assets exceed size limit")
		}
		out.Assets[a.Path] = data
	}
	for p := range roles {
		if !seen[p] {
			return nil, unsafeConfig("Missing declared provider asset")
		}
	}
	// The Core otherwise fetches missing geo databases while parsing rules.
	// Require supplied geo assets instead of giving untrusted config an implicit
	// privileged download path. Conservative matches can reject a harmless name.
	geoFields, _ := json.Marshal(map[string]any{"rules": m["rules"], "dns": m["dns"], "rule-providers": m["rule-providers"]})
	text := strings.ToUpper(string(geoFields))
	text = strings.ReplaceAll(strings.ReplaceAll(text, `"GEOIP":FALSE`, ""), `"GEOIP":TRUE`, "")
	text = strings.ReplaceAll(text, `"GEOIP-CODE":`, "")
	geoIP := strings.Contains(text, "GEOIP")
	geoSite := strings.Contains(text, "GEOSITE")
	geoASN := strings.Contains(text, "IP-ASN")
	if d, ok := m["dns"].(map[string]any); ok {
		if _, fallback := d["fallback"]; fallback {
			filter, _ := d["fallback-filter"].(map[string]any)
			geoIP = geoIP || filter["geoip"] != false
		}
	}
	// Scan decoded rules, never escaped JSON/YAML or opaque binary bytes.
	for _, rule := range ruleStrings {
		upper := strings.ToUpper(rule)
		geoIP = geoIP || strings.Contains(upper, "GEOIP")
		geoSite = geoSite || strings.Contains(upper, "GEOSITE")
		geoASN = geoASN || strings.Contains(upper, "IP-ASN")
	}
	geoIPFile := "country.mmdb"
	if m["geodata-mode"] == true {
		geoIPFile = "geoip.dat"
	}
	if geoIP && !seen[geoIPFile] || geoSite && !seen["geosite.dat"] || geoASN && !seen["asn.mmdb"] {
		return nil, unsafeConfig("Referenced geo databases must be supplied as bundle assets; implicit downloads are forbidden")
	}
	return out, nil
}
func httpURL(v any) bool {
	s, ok := v.(string)
	if !ok || len(s) > 8192 {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil
}
func checkDNS(v any) error {
	d, err := object(v, "dns")
	if err != nil {
		return err
	}
	if err = keys(d, "enable ipv6 listen enhanced-mode fake-ip-range fake-ip-range6 fake-ip-filter fake-ip-filter-mode use-hosts use-system-hosts respect-rules nameserver default-nameserver fallback proxy-server-nameserver direct-nameserver direct-nameserver-follow-policy nameserver-policy fallback-filter prefer-h3 cache-algorithm", "dns"); err != nil {
		return err
	}
	if err = scalarOptions(d, "enable ipv6 use-hosts use-system-hosts respect-rules direct-nameserver-follow-policy prefer-h3", "", "listen enhanced-mode fake-ip-range fake-ip-range6 fake-ip-filter-mode cache-algorithm"); err != nil {
		return err
	}
	if v, ok := d["listen"]; ok {
		h, _, err := net.SplitHostPort(v.(string))
		if err != nil || (h != "127.0.0.1" && h != "::1") {
			return unsafeConfig("DNS listener must be loopback")
		}
	}
	if err = enum(d, "enhanced-mode", "redir-host fake-ip"); err != nil {
		return err
	}
	for _, k := range []string{"nameserver", "default-nameserver", "fallback", "proxy-server-nameserver", "direct-nameserver", "fake-ip-filter"} {
		if v, ok := d[k]; ok {
			if err = stringList(v, k); err != nil {
				return err
			}
			if k != "fake-ip-filter" {
				for _, v := range v.([]any) {
					if err = safeDNSAddress(v.(string)); err != nil {
						return err
					}
				}
			}
		}
	}
	if v, ok := d["nameserver-policy"]; ok {
		p, err := object(v, "nameserver-policy")
		if err != nil {
			return err
		}
		for _, v := range p {
			if s, ok := v.(string); ok {
				if err = safeDNSAddress(s); err != nil {
					return err
				}
			} else {
				if err = stringList(v, "nameserver-policy"); err != nil {
					return err
				}
				for _, v := range v.([]any) {
					if err = safeDNSAddress(v.(string)); err != nil {
						return err
					}
				}
			}
		}
	}
	if v, ok := d["fallback-filter"]; ok {
		f, err := object(v, "fallback-filter")
		if err != nil {
			return err
		}
		if err = keys(f, "geoip geoip-code geosite ipcidr domain", "fallback-filter"); err != nil {
			return err
		}
		if err = scalarOptions(f, "geoip", "", "geoip-code"); err != nil {
			return err
		}
		for _, k := range []string{"geosite", "ipcidr", "domain"} {
			if v, ok := f[k]; ok {
				if err = stringList(v, k); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func safeDNSAddress(s string) error {
	// Disallow DHCP interface/file/system resolver extensions and URL parameters
	// that can select filesystem-backed TLS credentials.
	if strings.ContainsAny(s, "\\\x00") || strings.Contains(s, "?") {
		return unsafeConfig("Unsupported DNS address")
	}
	base := strings.Split(s, "#")[0]
	if strings.Contains(base, "://") {
		u, err := url.Parse(base)
		if err != nil || u.Hostname() == "" || u.User != nil {
			return unsafeConfig("Invalid DNS URL")
		}
		switch u.Scheme {
		case "https", "tls", "quic", "tcp", "udp", "h3":
		default:
			return unsafeConfig("Unsupported DNS URL scheme")
		}
	} else {
		host := base
		if h, _, err := net.SplitHostPort(base); err == nil {
			host = h
		}
		if net.ParseIP(host) == nil {
			return unsafeConfig("Plain DNS addresses must be IP literals")
		}
	}
	return nil
}

// Sniffer fields are pure packet classification options, never filesystem paths.
func checkSniffer(v any) error {
	s, err := object(v, "sniffer")
	if err != nil {
		return err
	}
	if err = keys(s, "enable force-dns-mapping parse-pure-ip override-destination sniff force-domain skip-domain skip-src-address skip-dst-address", "sniffer"); err != nil {
		return err
	}
	if err = scalarOptions(s, "enable force-dns-mapping parse-pure-ip override-destination", "", ""); err != nil {
		return err
	}
	for _, k := range []string{"force-domain", "skip-domain", "skip-src-address", "skip-dst-address"} {
		if v, ok := s[k]; ok {
			if err = stringList(v, k); err != nil {
				return err
			}
		}
	}
	if v, ok := s["sniff"]; ok {
		protocols, err := object(v, "sniff")
		if err != nil {
			return err
		}
		if err = keys(protocols, "TLS HTTP QUIC", "sniff"); err != nil {
			return err
		}
		for _, v := range protocols {
			p, err := object(v, "sniff protocol")
			if err != nil {
				return err
			}
			if err = keys(p, "ports override-destination", "sniff protocol"); err != nil {
				return err
			}
			if err = scalarOptions(p, "override-destination", "", ""); err != nil {
				return err
			}
			if v, ok := p["ports"]; ok {
				ports, ok := v.([]any)
				if !ok || len(ports) > 1024 {
					return unsafeConfig("Sniff ports must be a bounded array")
				}
				for _, v := range ports {
					var raw string
					switch n := v.(type) {
					case json.Number:
						raw = n.String()
					case string:
						raw = n
					default:
						return unsafeConfig("Invalid sniff port")
					}
					parts := strings.Split(raw, "-")
					if len(parts) > 2 {
						return unsafeConfig("Invalid sniff port range")
					}
					previous := int64(0)
					for _, part := range parts {
						n, err := json.Number(part).Int64()
						if err != nil || n < 1 || n > 65535 || n < previous || fmt.Sprint(n) != part {
							return unsafeConfig("Invalid sniff port range")
						}
						previous = n
					}
				}
			}
		}
	}
	return nil
}
