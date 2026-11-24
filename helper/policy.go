package main

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type action int

const (
	proxyAction action = iota
	patchAction
	selectAction
	restartAction
)

type controllerRoute struct {
	path   string
	action action
}

var forbiddenQuery = regexp.MustCompile("(?i)path|file|directory|payload")

func controllerTarget(method, raw string) (controllerRoute, bool) {
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || len(raw) > 8192 || strings.ContainsAny(raw, "#\\") || strings.ContainsFunc(raw, unicode.IsControl) {
		return controllerRoute{}, false
	}
	pathname, query, _ := strings.Cut(raw, "?")
	trimmed := strings.TrimSuffix(pathname[1:], "/")
	var parts []string
	if trimmed != "" {
		for _, p := range strings.Split(trimmed, "/") {
			s, e := url.PathUnescape(p)
			if e != nil || !utf8.ValidString(s) || s == "" || s == "." || s == ".." || strings.ContainsAny(s, "/%\\") || strings.ContainsFunc(s, unicode.IsControl) {
				return controllerRoute{}, false
			}
			parts = append(parts, s)
		}
	}
	var first, second string
	if len(parts) > 0 {
		first = parts[0]
	}
	if len(parts) > 1 {
		second = parts[1]
	}
	configs := first == "configs" && len(parts) == 1
	if strings.HasPrefix(first, "upgrade") || strings.HasPrefix(first, "debug") ||
		configs && method == "PUT" || first == "configs" && second == "geo" && method == "POST" {
		return controllerRoute{}, false
	}
	q, err := url.ParseQuery(query)
	if err != nil {
		return controllerRoute{}, false
	}
	for k, vs := range q {
		if forbiddenQuery.MatchString(k) {
			return controllerRoute{}, false
		}
		if k == "url" {
			for _, v := range vs {
				v = strings.ToLower(v)
				if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
					return controllerRoute{}, false
				}
			}
		}
	}
	q.Del("token")
	a := proxyAction
	switch {
	case first == "restart":
		if method != "POST" || len(parts) != 1 || len(q) != 0 {
			return controllerRoute{}, false
		}
		a = restartAction
	case configs && method == "PATCH":
		a = patchAction
	case first == "proxies" && len(parts) == 2 && method == "PUT":
		a = selectAction
	}
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	canonical := "/" + strings.Join(parts, "/")
	if len(q) != 0 {
		canonical += "?" + q.Encode()
	}
	return controllerRoute{canonical, a}, true
}

var limitedString = stringTest(func(s string) bool { return len([]rune(s)) <= 255 })
var patchSchema = object(map[string]schema{
	"mode": mode, "log-level": logLevel, "ipv6": flag, "allow-lan": flag, "sniffing": flag, "tcp-concurrent": flag,
	"find-process-mode": findProcess, "bind-address": limitedString, "interface-name": limitedString, "port": ports,
	"mixed-port": ports, "socks-port": ports, "redir-port": ports, "tproxy-port": ports,
	"tun": shape([]string{"enable"}, map[string]schema{"enable": enabled}),
})
var proxyName = stringTest(func(s string) bool {
	return strings.TrimSpace(s) != "" && s != "." && s != ".." && len([]rune(s)) <= 512 && !strings.ContainsFunc(s, unicode.IsControl) && !strings.ContainsRune(s, utf8.RuneError)
})
var selectSchema = shape([]string{"name"}, map[string]schema{"name": proxyName})

func controllerBody(b []byte, a action, storage bool) ([]byte, error) {
	if a == proxyAction {
		if storage && json.Valid(b) {
			return b, nil
		}
		if !storage && len(b) == 0 {
			return nil, nil
		}
		return nil, errors.New("invalid controller body")
	}
	m, err := uniqueJSONObject(b)
	if err != nil {
		return nil, err
	}
	decoded := map[string]any{}
	for k, v := range m {
		if k == "tun" {
			if _, err = uniqueJSONObject(v); err != nil {
				return nil, err
			}
		}
		var x any
		if err = json.Unmarshal(v, &x); err != nil {
			return nil, err
		}
		decoded[k] = x
	}
	validator := patchSchema
	if a == selectAction {
		validator = selectSchema
	}
	if err = validator(decoded, "request"); err != nil {
		return nil, err
	}
	return json.Marshal(decoded)
}
