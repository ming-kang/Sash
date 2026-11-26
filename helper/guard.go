//go:build windows

package main

import (
	"errors"
	"fmt"
	"math"
	"net"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

const defaultTunDevice = "Meta"

// The key namespace embeds ASCII markers so a collision with another WFP
// provider is implausible; filter keys share it with the object ordinal in
// Data1, which makes reinstall a fixed-key replace.
var guardSublayerKey = windows.GUID{
	Data1: 0x53415348, Data2: 0x0001, Data3: 0x0001,
	Data4: [8]byte{0x54, 0x75, 0x6e, 0x47, 0x75, 0x61, 0x72, 0x64},
}

func guardFilterKey(ordinal uint32) windows.GUID {
	return windows.GUID{
		Data1: ordinal, Data2: 0x0001, Data3: 0x0001,
		Data4: [8]byte{0x54, 0x75, 0x6e, 0x47, 0x75, 0x61, 0x72, 0x64},
	}
}

const (
	filterPermitCoreV4 uint32 = iota + 1
	filterPermitCoreV6
	filterPermitInterfaceV4
	filterPermitInterfaceV6
	filterPermitLoopbackV4
	filterPermitLoopbackV6
	filterPermitLanV4Private10
	filterPermitLanV4Private172
	filterPermitLanV4Private192
	filterPermitLanV4LinkLocal
	filterPermitLanV4Multicast
	filterPermitLanV6LinkLocal
	filterPermitLanV6Multicast
	filterPermitNdpRouterSolicitation
	filterPermitNdpNeighborSolicitation
	filterPermitNdpNeighborAdvertisement
	filterBlockV4
	filterBlockV6
	filterOrdinalMax
)

const (
	weightPermit uint8 = 13
	weightBlock  uint8 = 12
)

type v4Network struct {
	network uint32
	mask    uint32
}

type v6Network struct {
	network [16]byte
	prefix  uint8
}

type conditionValueSpec struct {
	dataType uint32
	scalar   uint64
	bytes    []byte
	addr4    v4Network
	addr6    v6Network
	array16  [16]byte
}

type conditionSpec struct {
	field windows.GUID
	match uint32
	value conditionValueSpec
}

type sublayerSpec struct {
	key         windows.GUID
	weight      uint16
	name        string
	description string
}

type filterSpec struct {
	key              windows.GUID
	layer            windows.GUID
	sublayer         windows.GUID
	weight           uint8
	action           uint32
	clearActionRight bool
	conditions       []conditionSpec
	name             string
	description      string
}

type guardPlan struct {
	sublayer sublayerSpec
	filters  []filterSpec
}

func scalarCondition(field windows.GUID, dataType uint32, scalar uint64) conditionSpec {
	return conditionSpec{
		field: field,
		match: fwpMatchEqual,
		value: conditionValueSpec{dataType: dataType, scalar: scalar},
	}
}

func v4NetworkCondition(network, mask uint32) conditionSpec {
	return conditionSpec{
		field: fwpmConditionIPRemoteAddress,
		match: fwpMatchEqual,
		value: conditionValueSpec{dataType: fwpV4AddrMask, addr4: v4Network{network: network, mask: mask}},
	}
}

func v6NetworkCondition(network [16]byte, prefix uint8) conditionSpec {
	return conditionSpec{
		field: fwpmConditionIPRemoteAddress,
		match: fwpMatchEqual,
		value: conditionValueSpec{dataType: fwpV6AddrMask, addr6: v6Network{network: network, prefix: prefix}},
	}
}

func permitFilter(ordinal uint32, layer windows.GUID, name string, conditions []conditionSpec) filterSpec {
	return filterSpec{
		key:         guardFilterKey(ordinal),
		layer:       layer,
		sublayer:    guardSublayerKey,
		weight:      weightPermit,
		action:      fwpActionPermit,
		conditions:  conditions,
		name:        name,
		description: "Sash TUN kill switch",
	}
}

// buildGuardPlan assembles the filter set that fails the machine closed while
// the Core is down: the Core itself, loopback, traffic entering the tunnel,
// LAN and IPv6 neighbor discovery pass; everything else is blocked at connect
// time.
func buildGuardPlan(appID []byte, interfaceIndex uint32) guardPlan {
	plan := guardPlan{
		sublayer: sublayerSpec{
			key:         guardSublayerKey,
			weight:      math.MaxUint16,
			name:        "Sash TUN Guard",
			description: "Sash TUN kill switch filters",
		},
	}

	coreCondition := []conditionSpec{{
		field: fwpmConditionAleAppID,
		match: fwpMatchEqual,
		value: conditionValueSpec{dataType: fwpByteBlobType, bytes: appID},
	}}
	for _, layer := range []struct {
		ordinal uint32
		guid    windows.GUID
		family  string
	}{
		{filterPermitCoreV4, fwpmLayerAleAuthConnectV4, "v4"},
		{filterPermitCoreV6, fwpmLayerAleAuthConnectV6, "v6"},
	} {
		filter := permitFilter(layer.ordinal, layer.guid, "permit core "+layer.family, coreCondition)
		filter.clearActionRight = true
		plan.filters = append(plan.filters, filter)
	}

	if interfaceIndex != 0 {
		interfaceCondition := []conditionSpec{
			scalarCondition(fwpmConditionLocalInterfaceIndex, fwpUint32, uint64(interfaceIndex)),
		}
		plan.filters = append(plan.filters,
			permitFilter(filterPermitInterfaceV4, fwpmLayerAleAuthConnectV4, "permit tunnel v4", interfaceCondition),
			permitFilter(filterPermitInterfaceV6, fwpmLayerAleAuthConnectV6, "permit tunnel v6", interfaceCondition),
		)
	}

	// Loopback connects traverse the connect layers like any other, and the
	// whole of 127/8 is local, so a remote-address permit cannot leak.
	plan.filters = append(plan.filters,
		permitFilter(filterPermitLoopbackV4, fwpmLayerAleAuthConnectV4, "permit loopback v4",
			[]conditionSpec{v4NetworkCondition(0x7F000000, 0xFF000000)}),
		permitFilter(filterPermitLoopbackV6, fwpmLayerAleAuthConnectV6, "permit loopback v6",
			[]conditionSpec{v6NetworkCondition([16]byte{15: 1}, 128)}),
	)

	// Host-order values, as FWP_V4_ADDR_AND_MASK expects them.
	for _, lan := range []struct {
		ordinal uint32
		name    string
		network uint32
		mask    uint32
	}{
		{filterPermitLanV4Private10, "permit lan 10/8", 0x0A000000, 0xFF000000},
		{filterPermitLanV4Private172, "permit lan 172.16/12", 0xAC100000, 0xFFF00000},
		{filterPermitLanV4Private192, "permit lan 192.168/16", 0xC0A80000, 0xFFFF0000},
		{filterPermitLanV4LinkLocal, "permit link-local v4", 0xA9FE0000, 0xFFFF0000},
		{filterPermitLanV4Multicast, "permit multicast v4", 0xE0000000, 0xF0000000},
	} {
		plan.filters = append(plan.filters, permitFilter(
			lan.ordinal, fwpmLayerAleAuthConnectV4, lan.name,
			[]conditionSpec{v4NetworkCondition(lan.network, lan.mask)},
		))
	}

	fe80 := [16]byte{0xfe, 0x80}
	ff00 := [16]byte{0xff}
	plan.filters = append(plan.filters,
		permitFilter(filterPermitLanV6LinkLocal, fwpmLayerAleAuthConnectV6, "permit link-local v6",
			[]conditionSpec{v6NetworkCondition(fe80, 10)}),
		permitFilter(filterPermitLanV6Multicast, fwpmLayerAleAuthConnectV6, "permit multicast v6",
			[]conditionSpec{v6NetworkCondition(ff00, 8)}),
	)

	allRoutersMulticast := [16]byte{0xff, 0x02, 15: 0x02}
	for _, ndp := range []struct {
		ordinal   uint32
		name      string
		icmpType  uint64
		multicast bool
	}{
		{filterPermitNdpRouterSolicitation, "permit ndp router solicitation", 133, true},
		{filterPermitNdpNeighborSolicitation, "permit ndp neighbor solicitation", 135, false},
		{filterPermitNdpNeighborAdvertisement, "permit ndp neighbor advertisement", 136, false},
	} {
		conditions := []conditionSpec{
			scalarCondition(fwpmConditionIPProtocol, fwpUint8, uint64(ipprotoICMPv6)),
			scalarCondition(fwpmConditionICMPType, fwpUint16, ndp.icmpType),
			scalarCondition(fwpmConditionICMPCode, fwpUint16, 0),
		}
		if ndp.multicast {
			conditions = append(conditions, conditionSpec{
				field: fwpmConditionIPRemoteAddress,
				match: fwpMatchEqual,
				value: conditionValueSpec{dataType: fwpByteArray16Type, array16: allRoutersMulticast},
			})
		}
		plan.filters = append(plan.filters, permitFilter(ndp.ordinal, fwpmLayerAleAuthConnectV6, ndp.name, conditions))
	}

	for _, block := range []struct {
		ordinal uint32
		guid    windows.GUID
		family  string
	}{
		{filterBlockV4, fwpmLayerAleAuthConnectV4, "v4"},
		{filterBlockV6, fwpmLayerAleAuthConnectV6, "v6"},
	} {
		plan.filters = append(plan.filters, filterSpec{
			key:         guardFilterKey(block.ordinal),
			layer:       block.guid,
			sublayer:    guardSublayerKey,
			weight:      weightBlock,
			action:      fwpActionBlock,
			name:        "block other " + block.family,
			description: "Sash TUN kill switch",
		})
	}
	return plan
}

func allGuardFilterKeys() []windows.GUID {
	keys := make([]windows.GUID, 0, filterOrdinalMax-1)
	for ordinal := uint32(1); ordinal < filterOrdinalMax; ordinal++ {
		keys = append(keys, guardFilterKey(ordinal))
	}
	return keys
}

type filterEngine interface {
	begin() error
	commit() error
	abort()
	addSubLayer(sublayerSpec) error
	deleteSubLayer(windows.GUID) error
	addFilter(filterSpec) error
	deleteFilter(windows.GUID) error
}

func deleteGuardObjects(engine filterEngine) error {
	for _, key := range allGuardFilterKeys() {
		if err := engine.deleteFilter(key); err != nil && !errors.Is(err, fwpEFilterNotFound) {
			return err
		}
	}
	if err := engine.deleteSubLayer(guardSublayerKey); err != nil && !errors.Is(err, fwpESublayerNotFound) {
		return err
	}
	return nil
}

func installGuardPlan(engine filterEngine, plan guardPlan) error {
	if err := engine.begin(); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			engine.abort()
		}
	}()
	if err := deleteGuardObjects(engine); err != nil {
		return err
	}
	if err := engine.addSubLayer(plan.sublayer); err != nil {
		return err
	}
	for _, filter := range plan.filters {
		if err := engine.addFilter(filter); err != nil {
			return err
		}
	}
	if err := engine.commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

func removeGuardObjects(engine filterEngine) error {
	if err := engine.begin(); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			engine.abort()
		}
	}()
	if err := deleteGuardObjects(engine); err != nil {
		return err
	}
	if err := engine.commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

type guardState struct {
	Active         bool   `json:"active"`
	Device         string `json:"device,omitempty"`
	InterfaceIndex uint32 `json:"interfaceIndex,omitempty"`
}

type tunGuard struct {
	mu           sync.Mutex
	engine       filterEngine
	engineErr    error
	openEngine   func() (filterEngine, error)
	appID        func(path string) ([]byte, error)
	resolveIndex func(name string) (uint32, error)

	resolveInterval time.Duration
	resolveAttempts int

	active          bool
	device          string
	corePath        string
	coreAppID       []byte
	interfaceIndex  uint32
	generation      uint64
	resolveLaunched uint64
}

func newTunGuard(engine filterEngine, engineErr error) *tunGuard {
	return &tunGuard{
		engine:          engine,
		engineErr:       engineErr,
		openEngine:      func() (filterEngine, error) { return openWfpEngine() },
		appID:           fwpmGetAppIdFromFileName0,
		resolveIndex:    resolveInterfaceIndex,
		resolveInterval: 500 * time.Millisecond,
		resolveAttempts: 240,
	}
}

// ensureEngine retries the engine open on demand: at boot the service can
// win the race against the Base Filtering Engine, and a startup failure must
// not disable the kill switch for the helper's whole lifetime.
func (g *tunGuard) ensureEngine() (filterEngine, error) {
	if g.engine != nil {
		return g.engine, nil
	}
	engine, err := g.openEngine()
	if err != nil {
		return nil, fmt.Errorf("the Windows filtering engine is unavailable: %w", err)
	}
	g.engine = engine
	g.engineErr = nil
	return engine, nil
}

func resolveInterfaceIndex(name string) (uint32, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return 0, err
	}
	if iface.Index <= 0 {
		return 0, fmt.Errorf("interface %s has no valid index", name)
	}
	return uint32(iface.Index), nil
}

func (g *tunGuard) install(device, corePath string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	engine, err := g.ensureEngine()
	if err != nil {
		return err
	}
	appID, err := g.appID(corePath)
	if err != nil {
		return fmt.Errorf("resolve the Core application id: %w", err)
	}
	interfaceIndex, _ := g.resolveIndex(device)
	if err := installGuardPlan(engine, buildGuardPlan(appID, interfaceIndex)); err != nil {
		return err
	}
	g.active = true
	g.device = device
	g.corePath = corePath
	g.coreAppID = appID
	g.interfaceIndex = interfaceIndex
	g.generation++
	return nil
}

func (g *tunGuard) uninstall() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	engine, err := g.ensureEngine()
	if err != nil {
		return err
	}
	if err := removeGuardObjects(engine); err != nil {
		return err
	}
	g.active = false
	g.interfaceIndex = 0
	g.generation++
	return nil
}

func (g *tunGuard) state() guardState {
	g.mu.Lock()
	defer g.mu.Unlock()
	return guardState{
		Active:         g.active,
		Device:         g.device,
		InterfaceIndex: g.interfaceIndex,
	}
}

func (g *tunGuard) closeEngine() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if closer, ok := g.engine.(interface{ close() }); ok {
		closer.close()
	}
}

// resolveLater re-resolves the tunnel interface after the Core has created
// it; the reinstall is a fixed-key replace, so a stale resolution can never
// duplicate objects. The goroutine exits when the install generation moves
// on, the interface resolves, or the Core clearly is not going to create it.
func (g *tunGuard) resolveLater() {
	g.mu.Lock()
	if !g.active || g.interfaceIndex != 0 || g.resolveLaunched == g.generation {
		g.mu.Unlock()
		return
	}
	g.resolveLaunched = g.generation
	generation := g.generation
	interval := g.resolveInterval
	attempts := g.resolveAttempts
	g.mu.Unlock()
	go func() {
		for attempt := 0; attempt < attempts; attempt++ {
			time.Sleep(interval)
			g.mu.Lock()
			if !g.active || g.generation != generation {
				g.mu.Unlock()
				return
			}
			device := g.device
			g.mu.Unlock()

			index, err := g.resolveIndex(device)
			if err != nil {
				continue
			}
			g.mu.Lock()
			if !g.active || g.generation != generation || g.interfaceIndex != 0 {
				g.mu.Unlock()
				return
			}
			installErr := installGuardPlan(g.engine, buildGuardPlan(g.coreAppID, index))
			if installErr == nil {
				g.interfaceIndex = index
			}
			g.mu.Unlock()
			if installErr == nil {
				return
			}
		}
	}()
}

type coreControl interface {
	start() error
	stop() error
	status() (bool, int)
	close()
}

// guardedCore composes the Core host with the guard lifecycle: the kill
// switch goes in before the Core starts and stays across restarts and crashes
// until the daemon explicitly converges it away.
type guardedCore struct {
	host     coreControl
	corePath string
	guard    *tunGuard
}

func newGuardedCore(host *coreHost, guard *tunGuard) *guardedCore {
	return &guardedCore{host: host, corePath: host.cfg.core, guard: guard}
}

type startOptions struct {
	guard  bool
	device string
}

func (c *guardedCore) start(options startOptions) error {
	if !options.guard {
		return c.host.start()
	}
	device := options.device
	if device == "" {
		device = defaultTunDevice
	}
	if err := c.guard.install(device, c.corePath); err != nil {
		return fmt.Errorf("install the TUN guard: %w", err)
	}
	if err := c.host.start(); err != nil {
		// The guard unwinds only when no Core ended up running; otherwise it
		// still protects the Core this start raced with or found running.
		if running, _ := c.host.status(); !running {
			_ = c.guard.uninstall()
		}
		return err
	}
	c.guard.resolveLater()
	return nil
}

func (c *guardedCore) stop() error {
	return c.host.stop()
}

func (c *guardedCore) unguard() error {
	return c.guard.uninstall()
}

func (c *guardedCore) status() (bool, int) {
	return c.host.status()
}

func (c *guardedCore) guardState() guardState {
	return c.guard.state()
}

func (c *guardedCore) shutdown() error {
	stopErr := c.host.stop()
	guardErr := c.guard.uninstall()
	if stopErr != nil {
		return stopErr
	}
	return guardErr
}

func (c *guardedCore) close() {
	c.guard.closeEngine()
	c.host.close()
}
