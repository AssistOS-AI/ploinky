import argparse
import ctypes as c
import json
import os
import signal
import sys

MIB = 1 << 20
STEP = 128 * MIB
OOM = 2
held = []
cleanup_errors = []
cuda = None
device = None
retained = False
report = {"ok": False, "status": "failed"}

class ProbeError(Exception):
    def __init__(self, step, detail, blocked=False):
        self.step, self.detail, self.blocked = step, detail, blocked

def api(name, args, alternate=None):
    fn = getattr(cuda, name, None)
    if fn is None and alternate:
        fn = getattr(cuda, alternate, None)
    if fn is None:
        raise ProbeError(name, "driver symbol unavailable", True)
    fn.argtypes, fn.restype = args, c.c_int
    return fn

def error_name(code):
    value = c.c_char_p()
    if get_error_name(code, c.byref(value)) == 0 and value.value:
        return value.value.decode("ascii", "replace")
    return "CUDA_RESULT_" + str(code)

def check(code, step):
    if code != 0:
        name = error_name(code)
        raise ProbeError(step, name, name == "CUDA_ERROR_NOT_SUPPORTED")

def deadline(signum, frame):
    raise ProbeError("deadline", "probe exceeded 30 seconds")

class SmCount(c.Structure):
    _fields_ = [("val", c.c_uint)]

class AffinityValue(c.Union):
    _fields_ = [("smCount", SmCount)]

class Affinity(c.Structure):
    _fields_ = [("type", c.c_int), ("param", AffinityValue)]

try:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-mib", type=int, required=True)
    args = parser.parse_args()
    if not 128 <= args.max_mib <= 8192 or args.max_mib % 128:
        raise ProbeError("arguments", "max-mib must be a multiple of 128 in 128..8192")
    signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, 30)
    cuda = c.CDLL("/usr/local/nvidia/lib64/libcuda.so.1")
    get_error_name = api("cuGetErrorName", [c.c_int, c.POINTER(c.c_char_p)])
    init = api("cuInit", [c.c_uint])
    get_device = api("cuDeviceGet", [c.POINTER(c.c_int), c.c_int])
    get_version = api("cuDriverGetVersion", [c.POINTER(c.c_int)])
    retain = api("cuDevicePrimaryCtxRetain", [c.POINTER(c.c_void_p), c.c_int])
    release = api("cuDevicePrimaryCtxRelease_v2", [c.c_int],
                  "cuDevicePrimaryCtxRelease")
    set_current = api("cuCtxSetCurrent", [c.c_void_p])
    affinity = api("cuCtxGetExecAffinity", [c.POINTER(Affinity), c.c_int])
    memory_info = api("cuMemGetInfo_v2", [c.POINTER(c.c_size_t),
                                       c.POINTER(c.c_size_t)])
    allocate = api("cuMemAlloc_v2", [c.POINTER(c.c_uint64), c.c_size_t])
    touch = api("cuMemsetD8_v2", [c.c_uint64, c.c_ubyte, c.c_size_t])
    synchronize = api("cuCtxSynchronize", [])
    free_memory = api("cuMemFree_v2", [c.c_uint64])
    check(init(0), "cuInit")
    device = c.c_int()
    check(get_device(c.byref(device), 0), "cuDeviceGet")
    version = c.c_int()
    check(get_version(c.byref(version)), "cuDriverGetVersion")
    context = c.c_void_p()
    check(retain(c.byref(context), device), "cuDevicePrimaryCtxRetain")
    retained = True
    check(set_current(context), "cuCtxSetCurrent")
    execution = Affinity()
    check(affinity(c.byref(execution), 0), "cuCtxGetExecAffinity")
    if execution.param.smCount.val <= 0:
        raise ProbeError("cuCtxGetExecAffinity", "nonpositive SM count")
    free_bytes, total_bytes = c.c_size_t(), c.c_size_t()
    check(memory_info(c.byref(free_bytes), c.byref(total_bytes)), "cuMemGetInfo")
    allocated = 0
    termination = "bound"
    while allocated < args.max_mib * MIB:
        pointer = c.c_uint64()
        code = allocate(c.byref(pointer), STEP)
        if code == OOM:
            termination = "allocation_oom"
            break
        check(code, "cuMemAlloc")
        held.append(pointer.value)
        check(touch(pointer.value, 0xA5, STEP), "cuMemsetD8")
        check(synchronize(), "cuCtxSynchronize")
        allocated += STEP
    report = {
        "ok": True, "status": "complete", "termination": termination,
        "driverApiVersion": version.value,
        "containerPid": os.getpid(), "containerUid": os.getuid(),
        "smCount": execution.param.smCount.val,
        "allocatedMiB": allocated // MIB, "boundMiB": args.max_mib,
        "memGetInfo": {"freeBytes": free_bytes.value, "totalBytes": total_bytes.value},
        "mpsEnv": {key: os.environ.get(key) for key in (
            "CUDA_MPS_PIPE_DIRECTORY", "CUDA_MPS_ACTIVE_THREAD_PERCENTAGE",
            "CUDA_MPS_PINNED_DEVICE_MEM_LIMIT")}
    }
except ProbeError as error:
    report = {"ok": False, "status": "blocked" if error.blocked else "failed",
              "step": error.step, "error": error.detail[:300]}
except Exception as error:
    report = {"ok": False, "status": "failed", "step": "python",
              "error": (type(error).__name__ + ": " + str(error))[:300]}
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    for pointer in reversed(held):
        try:
            code = free_memory(pointer)
            if code:
                cleanup_errors.append("cuMemFree:" + str(code))
        except Exception as error:
            cleanup_errors.append(type(error).__name__)
    if retained:
        try:
            code = release(device)
            if code:
                cleanup_errors.append("cuDevicePrimaryCtxRelease:" + str(code))
        except Exception as error:
            cleanup_errors.append(type(error).__name__)
    if cleanup_errors:
        report.update(ok=False, status="failed", cleanupErrors=cleanup_errors[:8])
    print(json.dumps(report, sort_keys=True), flush=True)

sys.exit(0 if report["ok"] else 3 if report["status"] == "blocked" else 2)
