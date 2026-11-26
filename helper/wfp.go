//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The WFP constants, struct layouts and entry points mirror the Windows SDK
// (fwpmtypes.h/fwpmu.h), cross-checked against sing-tun's internal/winsys
// (MIT) which ships the same bindings in production.
const (
	rpcCAuthnDefault uint32 = 0xFFFFFFFF

	fwpMatchEqual uint32 = 0

	fwpEmpty             uint32 = 0
	fwpUint8             uint32 = fwpEmpty + 1
	fwpUint16            uint32 = fwpUint8 + 1
	fwpUint32            uint32 = fwpUint16 + 1
	fwpByteArray16Type   uint32 = fwpEmpty + 11
	fwpByteBlobType      uint32 = fwpByteArray16Type + 1
	fwpSingleDataTypeMax uint32 = 0xff
	fwpV4AddrMask        uint32 = fwpSingleDataTypeMax + 1
	fwpV6AddrMask        uint32 = fwpV4AddrMask + 1

	fwpActionFlagTerminating uint32 = 0x00001000
	fwpActionBlock           uint32 = 0x00000001 | fwpActionFlagTerminating
	fwpActionPermit          uint32 = 0x00000002 | fwpActionFlagTerminating

	fwpmFilterFlagClearActionRight uint32 = 0x00000008

	ipprotoICMPv6 uint32 = 58
)

const (
	fwpEFilterNotFound   syscall.Errno = 0x80320003
	fwpESublayerNotFound syscall.Errno = 0x80320007
)

var (
	fwpmLayerAleAuthConnectV4 = windows.GUID{
		Data1: 0xc38d57d1, Data2: 0x05a7, Data3: 0x4c33,
		Data4: [8]byte{0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82},
	}
	fwpmLayerAleAuthConnectV6 = windows.GUID{
		Data1: 0x4a72393b, Data2: 0x319f, Data3: 0x44bc,
		Data4: [8]byte{0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4},
	}
	fwpmConditionAleAppID = windows.GUID{
		Data1: 0xd78e1e87, Data2: 0x8644, Data3: 0x4ea5,
		Data4: [8]byte{0x94, 0x37, 0xd8, 0x09, 0xec, 0xef, 0xc9, 0x71},
	}
	fwpmConditionLocalInterfaceIndex = windows.GUID{
		Data1: 0x667fd755, Data2: 0xd695, Data3: 0x434a,
		Data4: [8]byte{0x8a, 0xf5, 0xd3, 0x83, 0x5a, 0x12, 0x59, 0xbc},
	}
	fwpmConditionIPRemoteAddress = windows.GUID{
		Data1: 0xb235ae9a, Data2: 0x1d64, Data3: 0x49b8,
		Data4: [8]byte{0xa4, 0x4c, 0x5f, 0xf3, 0xd9, 0x09, 0x50, 0x45},
	}
	fwpmConditionIPProtocol = windows.GUID{
		Data1: 0x3971ef2b, Data2: 0x623e, Data3: 0x4f9a,
		Data4: [8]byte{0x8c, 0xb1, 0x6e, 0x79, 0xb8, 0x06, 0xb9, 0xa7},
	}
	fwpmConditionIPRemotePort = windows.GUID{
		Data1: 0xc35a604d, Data2: 0xd22b, Data3: 0x4e1a,
		Data4: [8]byte{0x91, 0xb4, 0x68, 0xf6, 0x74, 0xee, 0x67, 0x4b},
	}
	fwpmConditionIPLocalPort = windows.GUID{
		Data1: 0x0c1ba1af, Data2: 0x5765, Data3: 0x453f,
		Data4: [8]byte{0xaf, 0x22, 0xa8, 0xf7, 0x91, 0xac, 0x77, 0x5b},
	}
)

// ICMP type and code ride on the port fields; this is the documented WFP
// mapping sing-tun uses as well.
var (
	fwpmConditionICMPType = fwpmConditionIPLocalPort
	fwpmConditionICMPCode = fwpmConditionIPRemotePort
)

type fwpmDisplayData0 struct {
	name        *uint16
	description *uint16
}

type fwpmSession0 struct {
	sessionKey           windows.GUID
	displayData          fwpmDisplayData0
	flags                uint32
	txnWaitTimeoutInMSec uint32
	processId            uint32
	sid                  *windows.SID
	username             *uint16
	kernelMode           int32
}

type fwpByteBlob struct {
	size uint32
	data *uint8
}

type fwpmSublayer0 struct {
	subLayerKey  windows.GUID
	displayData  fwpmDisplayData0
	flags        uint32
	providerKey  *windows.GUID
	providerData fwpByteBlob
	weight       uint16
}

type fwpValue0 struct {
	typ   uint32
	value uintptr
}

type fwpByteArray16 struct {
	byteArray16 [16]uint8
}

type fwpV4AddrAndMask struct {
	addr uint32
	mask uint32
}

type fwpV6AddrAndMask struct {
	addr         [16]uint8
	prefixLength uint8
}

type fwpmFilterCondition0 struct {
	fieldKey       windows.GUID
	matchType      uint32
	conditionValue fwpValue0
}

type fwpmAction0 struct {
	typ   uint32
	value windows.GUID
}

type fwpmFilter0 struct {
	filterKey           windows.GUID
	displayData         fwpmDisplayData0
	flags               uint32
	providerKey         *windows.GUID
	providerData        fwpByteBlob
	layerKey            windows.GUID
	subLayerKey         windows.GUID
	weight              fwpValue0
	numFilterConditions uint32
	filterCondition     *fwpmFilterCondition0
	action              fwpmAction0
	rawContext          uint64
	reserved            *windows.GUID
	filterId            uint64
	effectiveWeight     fwpValue0
}

var (
	modfwpuclnt = windows.NewLazySystemDLL("fwpuclnt.dll")

	procFwpmEngineOpen0           = modfwpuclnt.NewProc("FwpmEngineOpen0")
	procFwpmEngineClose0          = modfwpuclnt.NewProc("FwpmEngineClose0")
	procFwpmTransactionBegin0     = modfwpuclnt.NewProc("FwpmTransactionBegin0")
	procFwpmTransactionCommit0    = modfwpuclnt.NewProc("FwpmTransactionCommit0")
	procFwpmTransactionAbort0     = modfwpuclnt.NewProc("FwpmTransactionAbort0")
	procFwpmSubLayerAdd0          = modfwpuclnt.NewProc("FwpmSubLayerAdd0")
	procFwpmSubLayerDeleteByKey0  = modfwpuclnt.NewProc("FwpmSubLayerDeleteByKey0")
	procFwpmFilterAdd0            = modfwpuclnt.NewProc("FwpmFilterAdd0")
	procFwpmFilterDeleteByKey0    = modfwpuclnt.NewProc("FwpmFilterDeleteByKey0")
	procFwpmGetAppIdFromFileName0 = modfwpuclnt.NewProc("FwpmGetAppIdFromFileName0")
	procFwpmFreeMemory0           = modfwpuclnt.NewProc("FwpmFreeMemory0")
)

// Lazy resolution panics on first use, so every entry point is resolved when
// the engine opens: a missing export then reads as an ordinary engine
// failure instead of crashing the service inside a transaction. The list
// doubles as the test's inventory of names to check against the real DLL.
var wfpProcs = []*windows.LazyProc{
	procFwpmEngineOpen0,
	procFwpmEngineClose0,
	procFwpmTransactionBegin0,
	procFwpmTransactionCommit0,
	procFwpmTransactionAbort0,
	procFwpmSubLayerAdd0,
	procFwpmSubLayerDeleteByKey0,
	procFwpmFilterAdd0,
	procFwpmFilterDeleteByKey0,
	procFwpmGetAppIdFromFileName0,
	procFwpmFreeMemory0,
}

func resolveWfpProcs() error {
	for _, proc := range wfpProcs {
		if err := proc.Find(); err != nil {
			return err
		}
	}
	return nil
}

func fwpmEngineOpen0(session *fwpmSession0) (uintptr, error) {
	var engine uintptr
	r1, _, _ := syscall.SyscallN(
		procFwpmEngineOpen0.Addr(),
		0,
		uintptr(rpcCAuthnDefault),
		0,
		uintptr(unsafe.Pointer(session)),
		uintptr(unsafe.Pointer(&engine)),
	)
	if r1 != 0 {
		return 0, syscall.Errno(r1)
	}
	return engine, nil
}

func fwpmEngineClose0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmEngineClose0.Addr(), engine)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmTransactionBegin0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionBegin0.Addr(), engine, 0)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmTransactionCommit0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionCommit0.Addr(), engine)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmTransactionAbort0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionAbort0.Addr(), engine)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmSubLayerAdd0(engine uintptr, sublayer *fwpmSublayer0) error {
	r1, _, _ := syscall.SyscallN(procFwpmSubLayerAdd0.Addr(), engine, uintptr(unsafe.Pointer(sublayer)), 0)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmSubLayerDeleteByKey0(engine uintptr, key *windows.GUID) error {
	r1, _, _ := syscall.SyscallN(procFwpmSubLayerDeleteByKey0.Addr(), engine, uintptr(unsafe.Pointer(key)))
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmFilterAdd0(engine uintptr, filter *fwpmFilter0) error {
	r1, _, _ := syscall.SyscallN(
		procFwpmFilterAdd0.Addr(),
		engine,
		uintptr(unsafe.Pointer(filter)),
		0,
		0,
	)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmFilterDeleteByKey0(engine uintptr, key *windows.GUID) error {
	r1, _, _ := syscall.SyscallN(procFwpmFilterDeleteByKey0.Addr(), engine, uintptr(unsafe.Pointer(key)))
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmGetAppIdFromFileName0(path string) ([]byte, error) {
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	var blob *fwpByteBlob
	r1, _, _ := syscall.SyscallN(
		procFwpmGetAppIdFromFileName0.Addr(),
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&blob)),
	)
	if r1 != 0 {
		return nil, syscall.Errno(r1)
	}
	if blob == nil || blob.data == nil || blob.size == 0 {
		return nil, errors.New("WFP returned an empty application id")
	}
	out := make([]byte, blob.size)
	copy(out, unsafe.Slice(blob.data, blob.size))
	syscall.SyscallN(procFwpmFreeMemory0.Addr(), uintptr(unsafe.Pointer(&blob)))
	return out, nil
}

func displayData(name, description string) (fwpmDisplayData0, error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return fwpmDisplayData0{}, err
	}
	descriptionPtr, err := windows.UTF16PtrFromString(description)
	if err != nil {
		return fwpmDisplayData0{}, err
	}
	return fwpmDisplayData0{name: namePtr, description: descriptionPtr}, nil
}

// wfpEngine is the real filter engine. Objects are added inside a static
// session, so they survive this process dying; the guard lifecycle decides
// when they are removed. All object memory is copied by the engine during
// each call, so Go-owned pointers only need to outlive the call itself.
type wfpEngine struct {
	engine uintptr
}

func openWfpEngine() (*wfpEngine, error) {
	if err := resolveWfpProcs(); err != nil {
		return nil, err
	}
	display, err := displayData("Sash TUN Guard", "Sash TUN kill switch objects")
	if err != nil {
		return nil, err
	}
	session := &fwpmSession0{displayData: display}
	engine, err := fwpmEngineOpen0(session)
	if err != nil {
		return nil, fmt.Errorf("FwpmEngineOpen0: %w", err)
	}
	return &wfpEngine{engine: engine}, nil
}

func (e *wfpEngine) close() {
	if e.engine != 0 {
		_ = fwpmEngineClose0(e.engine)
		e.engine = 0
	}
}

func (e *wfpEngine) begin() error {
	if err := fwpmTransactionBegin0(e.engine); err != nil {
		return fmt.Errorf("FwpmTransactionBegin0: %w", err)
	}
	return nil
}

func (e *wfpEngine) commit() error {
	if err := fwpmTransactionCommit0(e.engine); err != nil {
		return fmt.Errorf("FwpmTransactionCommit0: %w", err)
	}
	return nil
}

func (e *wfpEngine) abort() {
	_ = fwpmTransactionAbort0(e.engine)
}

func (e *wfpEngine) addSubLayer(spec sublayerSpec) error {
	display, err := displayData(spec.name, spec.description)
	if err != nil {
		return err
	}
	sublayer := fwpmSublayer0{
		subLayerKey: spec.key,
		displayData: display,
		weight:      spec.weight,
	}
	if err := fwpmSubLayerAdd0(e.engine, &sublayer); err != nil {
		return fmt.Errorf("FwpmSubLayerAdd0: %w", err)
	}
	return nil
}

func (e *wfpEngine) deleteSubLayer(key windows.GUID) error {
	if err := fwpmSubLayerDeleteByKey0(e.engine, &key); err != nil {
		return fmt.Errorf("FwpmSubLayerDeleteByKey0: %w", err)
	}
	return nil
}

// buildConditions assembles the condition array for one filter. Every backing
// value the array points at is individually heap-allocated and returned in
// keep; both must stay referenced until the engine call they serve returns.
func buildConditions(conditions []conditionSpec) (array []fwpmFilterCondition0, keep []any, err error) {
	array = make([]fwpmFilterCondition0, len(conditions))
	for i, condition := range conditions {
		array[i].fieldKey = condition.field
		array[i].matchType = condition.match
		value := &array[i].conditionValue
		value.typ = condition.value.dataType
		switch condition.value.dataType {
		case fwpUint8, fwpUint16, fwpUint32:
			value.value = uintptr(condition.value.scalar)
		case fwpByteBlobType:
			if len(condition.value.bytes) == 0 {
				return nil, nil, fmt.Errorf("empty blob condition on %v", condition.field)
			}
			blob := &fwpByteBlob{size: uint32(len(condition.value.bytes)), data: &condition.value.bytes[0]}
			keep = append(keep, blob)
			value.value = uintptr(unsafe.Pointer(blob))
		case fwpV4AddrMask:
			mask := &fwpV4AddrAndMask{
				addr: condition.value.addr4.network,
				mask: condition.value.addr4.mask,
			}
			keep = append(keep, mask)
			value.value = uintptr(unsafe.Pointer(mask))
		case fwpV6AddrMask:
			mask := &fwpV6AddrAndMask{
				addr:         condition.value.addr6.network,
				prefixLength: condition.value.addr6.prefix,
			}
			keep = append(keep, mask)
			value.value = uintptr(unsafe.Pointer(mask))
		case fwpByteArray16Type:
			addr := &fwpByteArray16{byteArray16: condition.value.array16}
			keep = append(keep, addr)
			value.value = uintptr(unsafe.Pointer(addr))
		default:
			return nil, nil, fmt.Errorf("unsupported condition value type %d", condition.value.dataType)
		}
	}
	return array, keep, nil
}

func (e *wfpEngine) addFilter(spec filterSpec) error {
	display, err := displayData(spec.name, spec.description)
	if err != nil {
		return err
	}
	filter := fwpmFilter0{
		filterKey:   spec.key,
		displayData: display,
		layerKey:    spec.layer,
		subLayerKey: spec.sublayer,
		action:      fwpmAction0{typ: spec.action},
	}
	filter.weight.typ = fwpUint8
	filter.weight.value = uintptr(spec.weight)
	if spec.clearActionRight {
		filter.flags = fwpmFilterFlagClearActionRight
	}
	array, keep, err := buildConditions(spec.conditions)
	if err != nil {
		return err
	}
	if len(array) > 0 {
		filter.numFilterConditions = uint32(len(array))
		filter.filterCondition = &array[0]
	}
	addErr := fwpmFilterAdd0(e.engine, &filter)
	runtime.KeepAlive(array)
	runtime.KeepAlive(keep)
	if addErr != nil {
		return fmt.Errorf("FwpmFilterAdd0 %q: %w", spec.name, addErr)
	}
	return nil
}

func (e *wfpEngine) deleteFilter(key windows.GUID) error {
	if err := fwpmFilterDeleteByKey0(e.engine, &key); err != nil {
		return fmt.Errorf("FwpmFilterDeleteByKey0: %w", err)
	}
	return nil
}
