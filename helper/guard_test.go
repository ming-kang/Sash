//go:build windows

package main

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The engine marshals these structs by their C layout; a size drift means
// every field after it lands in the wrong place.
func TestWfpStructLayoutsMatchC(t *testing.T) {
	sizes := map[string][2]uintptr{
		"FWPM_FILTER0":           {unsafe.Sizeof(fwpmFilter0{}), 192},
		"FWPM_SESSION0":          {unsafe.Sizeof(fwpmSession0{}), 72},
		"FWPM_SUBLAYER0":         {unsafe.Sizeof(fwpmSublayer0{}), 72},
		"FWPM_FILTER_CONDITION0": {unsafe.Sizeof(fwpmFilterCondition0{}), 40},
		"FWP_VALUE0":             {unsafe.Sizeof(fwpValue0{}), 16},
		"FWP_BYTE_BLOB":          {unsafe.Sizeof(fwpByteBlob{}), 16},
		"FWPM_ACTION0":           {unsafe.Sizeof(fwpmAction0{}), 20},
		"FWP_V4_ADDR_AND_MASK":   {unsafe.Sizeof(fwpV4AddrAndMask{}), 8},
		"FWP_V6_ADDR_AND_MASK":   {unsafe.Sizeof(fwpV6AddrAndMask{}), 17},
	}
	for name, size := range sizes {
		if size[0] != size[1] {
			t.Errorf("%s is %d bytes, C layout is %d", name, size[0], size[1])
		}
	}
	if unsafe.Offsetof(fwpmFilter0{}.filterCondition)%8 != 0 {
		t.Error("filterCondition must be pointer-aligned")
	}
}

type fakeEngine struct {
	mu       sync.Mutex
	ops      []string
	filters  map[windows.GUID]filterSpec
	sublayer *sublayerSpec
	addErr   error
	beginErr error
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{filters: map[windows.GUID]filterSpec{}}
}

func (f *fakeEngine) record(op string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, op)
}

func (f *fakeEngine) begin() error {
	f.record("begin")
	return f.beginErr
}
func (f *fakeEngine) commit() error {
	f.record("commit")
	return nil
}
func (f *fakeEngine) abort() { f.record("abort") }

func (f *fakeEngine) addSubLayer(spec sublayerSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "sublayer+")
	copy := spec
	f.sublayer = &copy
	return nil
}

func (f *fakeEngine) deleteSubLayer(key windows.GUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "sublayer-")
	if f.sublayer == nil {
		return fmt.Errorf("FwpmSubLayerDelete0: %w", fwpESublayerNotFound)
	}
	f.sublayer = nil
	return nil
}

func (f *fakeEngine) addFilter(spec filterSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, fmt.Sprintf("filter+%d", spec.key.Data1))
	if f.addErr != nil {
		return f.addErr
	}
	f.filters[spec.key] = spec
	return nil
}

func (f *fakeEngine) deleteFilter(key windows.GUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, fmt.Sprintf("filter-%d", key.Data1))
	if _, ok := f.filters[key]; !ok {
		return fmt.Errorf("FwpmFilterDelete0: %w", fwpEFilterNotFound)
	}
	delete(f.filters, key)
	return nil
}

func (f *fakeEngine) snapshot() (string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.ops, " "), len(f.filters)
}

func testAppID(path string) ([]byte, error) {
	return []byte(`\device\harddiskvolume2\sash\mihomo.exe`), nil
}

func TestGuardPlanAssembly(t *testing.T) {
	plan := buildGuardPlan([]byte("appid"), 0)
	if plan.sublayer.weight != math.MaxUint16 {
		t.Fatalf("sublayer weight %d", plan.sublayer.weight)
	}
	if len(plan.filters) != 14 {
		t.Fatalf("filter count without interface: %d", len(plan.filters))
	}

	keys := map[windows.GUID]bool{}
	for _, filter := range plan.filters {
		if keys[filter.key] {
			t.Fatalf("duplicate filter key in plan: %v", filter.key)
		}
		keys[filter.key] = true
		if filter.sublayer != guardSublayerKey {
			t.Fatalf("%s: wrong sublayer", filter.name)
		}
	}
	if keys[guardSublayerKey] {
		t.Fatal("filter key collides with the sublayer key")
	}

	var coreV4, coreV6, blockV4, blockV6 *filterSpec
	var lanV4, lanV6, ndp int
	for i := range plan.filters {
		filter := &plan.filters[i]
		switch filter.key.Data1 {
		case filterPermitCoreV4:
			coreV4 = filter
		case filterPermitCoreV6:
			coreV6 = filter
		case filterBlockV4:
			blockV4 = filter
		case filterBlockV6:
			blockV6 = filter
		}
		switch filter.layer {
		case fwpmLayerAleAuthConnectV4:
			if filter.weight == weightPermit && filter.key.Data1 >= filterPermitLanV4Private10 && filter.key.Data1 <= filterPermitLanV4Multicast {
				lanV4++
			}
		case fwpmLayerAleAuthConnectV6:
			if filter.key.Data1 == filterPermitLanV6LinkLocal || filter.key.Data1 == filterPermitLanV6Multicast {
				lanV6++
			}
			if filter.key.Data1 >= filterPermitNdpRouterSolicitation && filter.key.Data1 <= filterPermitNdpNeighborAdvertisement {
				ndp++
			}
		}
	}
	for name, filter := range map[string]*filterSpec{"core v4": coreV4, "core v6": coreV6} {
		if filter == nil {
			t.Fatalf("%s permit missing", name)
		}
		if !filter.clearActionRight || filter.weight != weightPermit || filter.action != fwpActionPermit {
			t.Fatalf("%s: weight %d clear %v action %x", name, filter.weight, filter.clearActionRight, filter.action)
		}
		if len(filter.conditions) != 1 || filter.conditions[0].field != fwpmConditionAleAppID {
			t.Fatalf("%s: conditions %+v", name, filter.conditions)
		}
		if string(filter.conditions[0].value.bytes) != "appid" || filter.conditions[0].value.dataType != fwpByteBlobType {
			t.Fatalf("%s: app id condition %+v", name, filter.conditions[0].value)
		}
	}
	for name, filter := range map[string]*filterSpec{"block v4": blockV4, "block v6": blockV6} {
		if filter == nil {
			t.Fatalf("%s missing", name)
		}
		if filter.action != fwpActionBlock || filter.weight != weightBlock || len(filter.conditions) != 0 {
			t.Fatalf("%s: weight %d conditions %d", name, filter.weight, len(filter.conditions))
		}
		if filter.clearActionRight {
			t.Fatalf("%s must not clear action rights", name)
		}
	}
	if lanV4 != 5 || lanV6 != 2 || ndp != 3 {
		t.Fatalf("lan v4 %d lan v6 %d ndp %d", lanV4, lanV6, ndp)
	}
}

func TestGuardPlanLanAddresses(t *testing.T) {
	plan := buildGuardPlan([]byte("appid"), 0)
	want := map[uint32][2]uint32{
		filterPermitLanV4Private10:  {0x0A000000, 0xFF000000},
		filterPermitLanV4Private172: {0xAC100000, 0xFFF00000},
		filterPermitLanV4Private192: {0xC0A80000, 0xFFFF0000},
		filterPermitLanV4LinkLocal:  {0xA9FE0000, 0xFFFF0000},
		filterPermitLanV4Multicast:  {0xE0000000, 0xF0000000},
	}
	for ordinal, network := range want {
		var found *filterSpec
		for i := range plan.filters {
			if plan.filters[i].key.Data1 == ordinal {
				found = &plan.filters[i]
			}
		}
		if found == nil || len(found.conditions) != 1 {
			t.Fatalf("ordinal %d missing", ordinal)
		}
		value := found.conditions[0].value
		if value.dataType != fwpV4AddrMask || value.addr4.network != network[0] || value.addr4.mask != network[1] {
			t.Fatalf("ordinal %d: %+v", ordinal, value.addr4)
		}
		if found.conditions[0].field != fwpmConditionIPRemoteAddress {
			t.Fatalf("ordinal %d: wrong condition field", ordinal)
		}
	}

	var linkLocal, multicast *filterSpec
	for i := range plan.filters {
		switch plan.filters[i].key.Data1 {
		case filterPermitLanV6LinkLocal:
			linkLocal = &plan.filters[i]
		case filterPermitLanV6Multicast:
			multicast = &plan.filters[i]
		}
	}
	if linkLocal == nil || linkLocal.conditions[0].value.addr6.prefix != 10 ||
		linkLocal.conditions[0].value.addr6.network[0] != 0xfe || linkLocal.conditions[0].value.addr6.network[1] != 0x80 {
		t.Fatalf("fe80::/10: %+v", linkLocal)
	}
	if multicast == nil || multicast.conditions[0].value.addr6.prefix != 8 ||
		multicast.conditions[0].value.addr6.network[0] != 0xff {
		t.Fatalf("ff00::/8: %+v", multicast)
	}
}

func TestGuardPlanNdp(t *testing.T) {
	plan := buildGuardPlan([]byte("appid"), 0)
	solicitation := 0
	for _, filter := range plan.filters {
		if filter.key.Data1 < filterPermitNdpRouterSolicitation || filter.key.Data1 > filterPermitNdpNeighborAdvertisement {
			continue
		}
		solicitation++
		if filter.layer != fwpmLayerAleAuthConnectV6 || filter.weight != weightPermit {
			t.Fatalf("%s: layer or weight wrong", filter.name)
		}
		byField := map[windows.GUID]conditionSpec{}
		for _, condition := range filter.conditions {
			if condition.value.dataType == fwpUint8 || condition.value.dataType == fwpUint16 {
				byField[condition.field] = condition
			}
		}
		if byField[fwpmConditionIPProtocol].value.scalar != uint64(ipprotoICMPv6) {
			t.Fatalf("%s: protocol condition missing", filter.name)
		}
		if byField[fwpmConditionICMPCode].value.scalar != 0 {
			t.Fatalf("%s: icmp code must be 0", filter.name)
		}
		wantType := map[uint32]uint64{
			filterPermitNdpRouterSolicitation:    133,
			filterPermitNdpNeighborSolicitation:  135,
			filterPermitNdpNeighborAdvertisement: 136,
		}[filter.key.Data1]
		if byField[fwpmConditionICMPType].value.scalar != wantType {
			t.Fatalf("%s: icmp type %d, want %d", filter.name, byField[fwpmConditionICMPType].value.scalar, wantType)
		}
		wantConditions := 3
		if filter.key.Data1 == filterPermitNdpRouterSolicitation {
			wantConditions = 4
			var multicast *conditionSpec
			for i := range filter.conditions {
				if filter.conditions[i].value.dataType == fwpByteArray16Type {
					multicast = &filter.conditions[i]
				}
			}
			if multicast == nil || multicast.value.array16 != [16]byte{0xff, 0x02, 15: 0x02} {
				t.Fatalf("router solicitation must target ff02::2: %+v", filter.conditions)
			}
		}
		if len(filter.conditions) != wantConditions {
			t.Fatalf("%s: %d conditions, want %d", filter.name, len(filter.conditions), wantConditions)
		}
	}
	if solicitation != 3 {
		t.Fatalf("ndp filter count %d", solicitation)
	}
}

func TestGuardPlanInterfacePermits(t *testing.T) {
	plan := buildGuardPlan([]byte("appid"), 42)
	if len(plan.filters) != 16 {
		t.Fatalf("filter count with interface: %d", len(plan.filters))
	}
	seen := 0
	for _, filter := range plan.filters {
		if filter.key.Data1 != filterPermitInterfaceV4 && filter.key.Data1 != filterPermitInterfaceV6 {
			continue
		}
		seen++
		if len(filter.conditions) != 1 ||
			filter.conditions[0].field != fwpmConditionLocalInterfaceIndex ||
			filter.conditions[0].value.scalar != 42 ||
			filter.conditions[0].value.dataType != fwpUint32 {
			t.Fatalf("%s: %+v", filter.name, filter.conditions)
		}
		if filter.weight != weightPermit {
			t.Fatalf("%s must outweigh the block at %d", filter.name, weightBlock)
		}
	}
	if seen != 2 {
		t.Fatalf("interface permit count %d", seen)
	}

	again := buildGuardPlan([]byte("appid"), 42)
	if len(again.filters) != len(plan.filters) {
		t.Fatal("plan construction is not deterministic")
	}
	for i := range plan.filters {
		if plan.filters[i].key != again.filters[i].key {
			t.Fatalf("filter %d key unstable", i)
		}
	}
}

func TestInstallGuardPlanReplacesInOneTransaction(t *testing.T) {
	engine := newFakeEngine()
	plan := buildGuardPlan([]byte("appid"), 1)
	if err := installGuardPlan(engine, plan); err != nil {
		t.Fatal(err)
	}
	_, count := engine.snapshot()
	if count != len(plan.filters) {
		t.Fatalf("installed %d of %d filters", count, len(plan.filters))
	}
	if err := installGuardPlan(engine, plan); err != nil {
		t.Fatal(err)
	}
	ops, count := engine.snapshot()
	if count != len(plan.filters) {
		t.Fatalf("after reinstall %d filters", count)
	}
	if strings.Count(ops, "commit") != 2 || strings.Contains(ops, "abort") {
		t.Fatalf("transactions: %s", ops)
	}
	second := strings.Split(ops, "begin")[2]
	firstAdd := strings.Index(second, "filter+")
	firstDelete := strings.Index(second, "filter-")
	if firstDelete == -1 || (firstAdd != -1 && firstAdd < firstDelete) {
		t.Fatalf("reinstall must delete before it adds: %s", second)
	}
}

func TestInstallGuardPlanAbortsOnFailure(t *testing.T) {
	engine := newFakeEngine()
	engine.addErr = errors.New("engine full")
	err := installGuardPlan(engine, buildGuardPlan([]byte("appid"), 1))
	if err == nil {
		t.Fatal("expected failure")
	}
	ops, _ := engine.snapshot()
	if !strings.HasSuffix(ops, "abort") || strings.Contains(ops, "commit") {
		t.Fatalf("must abort without commit: %s", ops)
	}
}

func TestRemoveGuardObjectsToleratesAbsence(t *testing.T) {
	engine := newFakeEngine()
	if err := removeGuardObjects(engine); err != nil {
		t.Fatalf("removing nothing: %v", err)
	}
	ops, _ := engine.snapshot()
	if strings.Count(ops, "filter-") != int(filterOrdinalMax-1) || !strings.Contains(ops, "sublayer-") {
		t.Fatalf("must delete every ordinal: %s", ops)
	}
	if err := installGuardPlan(engine, buildGuardPlan([]byte("appid"), 1)); err != nil {
		t.Fatal(err)
	}
	if err := removeGuardObjects(engine); err != nil {
		t.Fatal(err)
	}
	_, count := engine.snapshot()
	if count != 0 {
		t.Fatalf("%d filters left", count)
	}
	if engine.sublayer != nil {
		t.Fatal("sublayer left")
	}
}

type fakeHost struct {
	running   bool
	startErr  error
	stopErr   error
	closeCall bool
}

func (f *fakeHost) start() error {
	if f.startErr != nil {
		return f.startErr
	}
	f.running = true
	return nil
}
func (f *fakeHost) stop() error {
	if f.stopErr != nil {
		return f.stopErr
	}
	f.running = false
	return nil
}
func (f *fakeHost) status() (bool, int) {
	if f.running {
		return true, 99
	}
	return false, 0
}
func (f *fakeHost) close() { f.closeCall = true }

func testGuardedCore(engine *fakeEngine) (*guardedCore, *tunGuard, *fakeHost) {
	guard := newTunGuard(engine, nil)
	guard.appID = testAppID
	guard.resolveIndex = func(name string) (uint32, error) { return 0, errors.New("no such interface") }
	host := &fakeHost{}
	return &guardedCore{host: host, corePath: `C:\Sash\mihomo.exe`, guard: guard}, guard, host
}

func TestGuardedStartInstallsBeforeCoreStarts(t *testing.T) {
	core, guard, host := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{guard: true}); err != nil {
		t.Fatal(err)
	}
	if !host.running {
		t.Fatal("Core was not started")
	}
	state := guard.state()
	if !state.Active || state.Device != defaultTunDevice {
		t.Fatalf("guard state %+v", state)
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 14 {
		t.Fatalf("filters without interface: %d", count)
	}
}

func TestGuardedStartFailureUninstalls(t *testing.T) {
	core, guard, host := testGuardedCore(newFakeEngine())
	host.startErr = errors.New("cannot spawn")
	if err := core.start(startOptions{guard: true}); err == nil {
		t.Fatal("expected start failure")
	}
	if guard.state().Active {
		t.Fatal("guard must unwind when the Core does not start")
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 0 {
		t.Fatalf("%d filters left after unwind", count)
	}
}

func TestDuplicateStartKeepsGuardOfRunningCore(t *testing.T) {
	core, guard, host := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{guard: true}); err != nil {
		t.Fatal(err)
	}
	host.startErr = errors.New("Core is already running (PID 99)")
	if err := core.start(startOptions{guard: true}); err == nil {
		t.Fatal("expected duplicate start failure")
	}
	if !guard.state().Active {
		t.Fatal("the running Core lost its guard to a duplicate start")
	}
}

func TestUnguardedStartDoesNotTouchGuard(t *testing.T) {
	core, _, host := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{}); err != nil {
		t.Fatal(err)
	}
	if !host.running {
		t.Fatal("Core was not started")
	}
	ops, _ := core.guard.engine.(*fakeEngine).snapshot()
	if ops != "" {
		t.Fatalf("unguarded start touched the engine: %s", ops)
	}
}

func TestGuardedStopRemovesObjects(t *testing.T) {
	core, guard, _ := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{guard: true, device: "Meta"}); err != nil {
		t.Fatal(err)
	}
	if err := core.stop(); err != nil {
		t.Fatal(err)
	}
	if guard.state().Active {
		t.Fatal("guard still active after stop")
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 0 {
		t.Fatalf("%d filters left after stop", count)
	}
}

func TestStopWithoutCoreStillRemovesObjects(t *testing.T) {
	core, _, _ := testGuardedCore(newFakeEngine())
	if err := installGuardPlan(core.guard.engine.(*fakeEngine), buildGuardPlan([]byte("x"), 1)); err != nil {
		t.Fatal(err)
	}
	if err := core.stop(); err != nil {
		t.Fatal(err)
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 0 {
		t.Fatalf("%d filters left", count)
	}
}

func TestFailedCoreStopKeepsGuard(t *testing.T) {
	core, guard, host := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{guard: true}); err != nil {
		t.Fatal(err)
	}
	host.stopErr = errors.New("cannot kill")
	if err := core.stop(); err == nil {
		t.Fatal("expected stop failure")
	}
	if !guard.state().Active {
		t.Fatal("guard must stay while the Core cannot be confirmed stopped")
	}
}

func TestShutdownRemovesEvenWhenCoreStopFails(t *testing.T) {
	core, guard, host := testGuardedCore(newFakeEngine())
	if err := core.start(startOptions{guard: true}); err != nil {
		t.Fatal(err)
	}
	host.stopErr = errors.New("cannot kill")
	_ = core.shutdown()
	if guard.state().Active {
		t.Fatal("shutdown must remove the guard regardless")
	}
}

func TestResolverInstallsInterfacePermits(t *testing.T) {
	core, guard, _ := testGuardedCore(newFakeEngine())
	guard.resolveIndex = func(name string) (uint32, error) { return 12, nil }
	if err := core.start(startOptions{guard: true, device: "Meta"}); err != nil {
		t.Fatal(err)
	}
	// Resolved synchronously at install time: no resolver needed.
	if guard.state().InterfaceIndex != 12 {
		t.Fatalf("interface index %+v", guard.state())
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 16 {
		t.Fatalf("filters with interface: %d", count)
	}
}

func TestResolverRetriesUntilInterfaceAppears(t *testing.T) {
	core, guard, _ := testGuardedCore(newFakeEngine())
	guard.resolveInterval = time.Millisecond
	guard.resolveAttempts = 500
	appears := make(chan struct{})
	var once sync.Once
	guard.resolveIndex = func(name string) (uint32, error) {
		select {
		case <-appears:
			return 21, nil
		default:
			return 0, errors.New("no such interface")
		}
	}
	if err := core.start(startOptions{guard: true, device: "Meta"}); err != nil {
		t.Fatal(err)
	}
	if guard.state().InterfaceIndex != 0 {
		t.Fatal("interface must be unresolved at start")
	}
	once.Do(func() { close(appears) })
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if guard.state().InterfaceIndex == 21 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if guard.state().InterfaceIndex != 21 {
		t.Fatalf("resolver never installed the interface: %+v", guard.state())
	}
	_, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 16 {
		t.Fatalf("filters after resolution: %d", count)
	}
}

func TestResolverStopsWhenUninstalled(t *testing.T) {
	core, guard, _ := testGuardedCore(newFakeEngine())
	guard.resolveInterval = time.Millisecond
	guard.resolveAttempts = 500
	guard.resolveIndex = func(name string) (uint32, error) { return 0, errors.New("no such interface") }
	if err := core.start(startOptions{guard: true, device: "Meta"}); err != nil {
		t.Fatal(err)
	}
	if err := core.stop(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if guard.state().Active {
		t.Fatal("guard still active")
	}
	ops, count := core.guard.engine.(*fakeEngine).snapshot()
	if count != 0 {
		t.Fatalf("%d filters left; ops %s", count, ops)
	}
}

func TestResolverRetriesInstallFailure(t *testing.T) {
	core, guard, _ := testGuardedCore(newFakeEngine())
	guard.resolveInterval = time.Millisecond
	guard.resolveAttempts = 500
	engine := core.guard.engine.(*fakeEngine)
	var resolution sync.Mutex
	resolvable := false
	guard.resolveIndex = func(name string) (uint32, error) {
		resolution.Lock()
		defer resolution.Unlock()
		if !resolvable {
			return 0, errors.New("no such interface")
		}
		return 21, nil
	}
	if err := core.start(startOptions{guard: true, device: "Meta"}); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	engine.addErr = errors.New("engine busy")
	engine.mu.Unlock()
	resolution.Lock()
	resolvable = true
	resolution.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ops, _ := engine.snapshot()
		if strings.Contains(ops, "abort") {
			break
		}
		time.Sleep(time.Millisecond)
	}
	ops, _ := engine.snapshot()
	if !strings.Contains(ops, "abort") {
		t.Fatalf("resolver never attempted the reinstall: %s", ops)
	}
	engine.mu.Lock()
	engine.addErr = nil
	engine.mu.Unlock()
	for time.Now().Before(deadline) {
		if guard.state().InterfaceIndex == 21 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if guard.state().InterfaceIndex != 21 {
		t.Fatalf("resolver never recovered: %+v", guard.state())
	}
	_, count := engine.snapshot()
	if count != 16 {
		t.Fatalf("filters after recovery: %d", count)
	}
}
