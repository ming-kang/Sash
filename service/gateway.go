// SPDX-License-Identifier: MIT
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// gatewayRequest accepts exact route shapes. Path decoding, query parameters,
// and JSON mutations are checked before the privileged bearer is attached.
func gatewayRequest(r *http.Request, providers map[string]bool) error {
	p := r.URL.Path
	if strings.ContainsAny(p, "\\%\x00") || strings.Contains(p, "//") || strings.Contains(p, "/./") || strings.Contains(p, "/../") || strings.HasSuffix(p, "/") || strings.HasSuffix(p, "/.") || strings.HasSuffix(p, "/..") {
		return failure("FORBIDDEN", "Controller route is not allowed")
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	// Browsers percent-encode punctuation in node/group names more aggressively
	// than Go's path encoder. Permit it only in a resource-name segment, never
	// in fixed routing words or across a slash/dot-segment boundary.
	if r.URL.RawPath != "" {
		raw := strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/")
		if len(raw) != len(parts) {
			return failure("FORBIDDEN", "Encoded path boundaries are forbidden")
		}
		for i, segment := range raw {
			if segment == parts[i] {
				continue
			}
			name := i == 1 && (parts[0] == "proxies" || parts[0] == "connections") || i == 2 && parts[0] == "providers"
			if !name {
				return failure("FORBIDDEN", "Encoded controller route is not allowed")
			}
		}
	}
	read := r.Method == http.MethodGet
	allowed := false
	queryKeys := ""
	if read {
		switch p {
		case "/version", "/configs", "/proxies", "/rules", "/connections", "/traffic", "/memory", "/providers/proxies", "/providers/rules":
			allowed = true
		case "/logs":
			allowed = true
			queryKeys = "level"
		}
		if len(parts) == 2 && parts[0] == "proxies" && parts[1] != "" {
			allowed = true
		}
		if len(parts) == 3 && parts[0] == "proxies" && parts[1] != "" && parts[2] == "delay" {
			allowed = true
			queryKeys = "url timeout expected"
		}
		if len(parts) == 3 && parts[0] == "providers" && (parts[1] == "proxies" || parts[1] == "rules") && parts[2] != "" {
			allowed = true
		}
		if len(parts) == 4 && parts[0] == "providers" && parts[1] == "proxies" && parts[2] != "" && parts[3] == "healthcheck" && providers["proxy/"+parts[2]] {
			allowed = true
		}
	}
	if r.Method == http.MethodDelete && (p == "/connections" || len(parts) == 2 && parts[0] == "connections" && parts[1] != "") {
		allowed = true
	}
	var body map[string]any
	if r.Method == http.MethodPatch && p == "/configs" || r.Method == http.MethodPut && len(parts) == 2 && parts[0] == "proxies" {
		b, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(b) > 8192 {
			return failure("INVALID_REQUEST", "Invalid controller mutation body")
		}
		if err = decodeJSON(b, &body); err != nil {
			return err
		}
		if len(body) == 0 {
			return failure("INVALID_REQUEST", "Empty mutation")
		}
		if p == "/configs" {
			if err = keys(body, "mode log-level", "controller patch"); err != nil {
				return err
			}
			if err = enum(body, "mode", "rule global direct"); err != nil {
				return err
			}
			if err = enum(body, "log-level", "silent error warning info debug"); err != nil {
				return err
			}
		} else {
			if err = keys(body, "name", "proxy selection"); err != nil {
				return err
			}
			s, ok := body["name"].(string)
			if !ok || s == "" || len(s) > 512 || strings.ContainsRune(s, 0) {
				return failure("INVALID_REQUEST", "Invalid proxy selection")
			}
		}
		b, err = json.Marshal(body)
		if err != nil {
			return err
		}
		r.Body = io.NopCloser(bytes.NewReader(b))
		r.ContentLength = int64(len(b))
		allowed = true
	}
	if r.Method == http.MethodPut && len(parts) == 3 && parts[0] == "providers" && (parts[1] == "proxies" || parts[1] == "rules") {
		role := "proxy/"
		if parts[1] == "rules" {
			role = "rule/"
		}
		allowed = providers[role+parts[2]]
	}
	if !allowed {
		return failure("FORBIDDEN", "Controller route is not allowed")
	}
	if body == nil {
		b, err := io.ReadAll(io.LimitReader(r.Body, 1))
		if err != nil || len(b) != 0 {
			return failure("INVALID_REQUEST", "This controller route does not accept a body")
		}
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return failure("INVALID_REQUEST", "Invalid query")
	}
	for k, vs := range q {
		if !strings.Contains(" "+queryKeys+" ", " "+k+" ") || k == "" || len(vs) != 1 || len(vs[0]) > 8192 {
			return failure("FORBIDDEN", "Controller query is not allowed")
		}
		if k == "url" && !httpURL(vs[0]) {
			return failure("INVALID_REQUEST", "Invalid latency URL")
		}
	}
	if r.Header.Get("Upgrade") != "" {
		if !read || (p != "/connections" && p != "/traffic" && p != "/memory" && p != "/logs") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			return failure("FORBIDDEN", "Upgrade is not allowed")
		}
	}
	return nil
}

// The private bearer must never enter any user-visible configs response, even
// if a future Core release adds another credential field. Return known public
// fields rather than blacklisting just today's secret field.
func publicConfigs(data []byte) ([]byte, error) {
	var m map[string]any
	if err := decodeJSON(data, &m); err != nil {
		return nil, err
	}
	public := map[string]any{}
	for _, k := range strings.Fields("port socks-port redir-port tproxy-port mixed-port allow-lan bind-address mode log-level ipv6 tcp-concurrent unified-delay interface-name routing-mark tun") {
		if v, ok := m[k]; ok {
			public[k] = v
		}
	}
	if v, ok := public["tun"].(map[string]any); ok {
		t := map[string]any{}
		for _, k := range strings.Fields("enable stack device auto-route auto-detect-interface strict-route mtu dns-hijack") {
			if v, ok := v[k]; ok {
				t[k] = v
			}
		}
		public["tun"] = t
	}
	return json.Marshal(public)
}
