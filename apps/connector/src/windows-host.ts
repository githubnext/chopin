import { dlopen, FFIType, ptr } from "bun:ffi";

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: closing the job's last handle ends every process in it. */
const KILL_ON_JOB_CLOSE = 0x2000;
/** `JobObjectBasicAccountingInformation` and `JobObjectExtendedLimitInformation`. */
const ACCOUNTING = 1;
const EXTENDED_LIMITS = 9;
/** `PROCESS_SET_QUOTA | PROCESS_TERMINATE`, what assigning a process to a job takes. */
const ASSIGN = 0x0100 | 0x0001;

let kernel32: ReturnType<typeof open> | undefined;

function open() {
	return dlopen("kernel32.dll", {
		CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		SetInformationJobObject: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		QueryInformationJobObject: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
			returns: FFIType.i32,
		},
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		CreateFileW: {
			args: [
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.ptr,
			],
			returns: FFIType.ptr,
		},
		DeviceIoControl: {
			args: [
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
		SetFilePointerEx: {
			args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		SetEndOfFile: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
		SetFileAttributesW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	}).symbols;
}

function api() {
	return kernel32 ??= open();
}

/** A path as Windows' wide-character calls take it: UTF-16, ending in a NUL. */
function wide(path: string) {
	return Buffer.from(`${path}\0`, "utf16le");
}

/** Whether `CreateFileW` answered a handle: never null, nor `INVALID_HANDLE_VALUE` (all bits set). */
function valid(handle: unknown) {
	return !!handle && Number(handle) < Number.MAX_SAFE_INTEGER;
}

/**
 * Makes `path` a sparse file of `bytes`, which takes on disk only what is written to it. A file a
 * guest grows over an NTFS share isn't sparse: NTFS writes zeros up to each write, so a disk made
 * that way took its whole size and minutes. Throws, saying which call failed.
 */
export function sparseFile(path: string, bytes: number) {
	let calls = api();
	// GENERIC_WRITE, no sharing, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL.
	let file = calls.CreateFileW(ptr(wide(path)), 0x40000000, 0, null, 2, 0x80, null);
	if (!valid(file)) throw new Error(`Couldn't create ${path}.`);
	try {
		let returned = new Uint32Array(1);
		// FSCTL_SET_SPARSE.
		if (!calls.DeviceIoControl(file, 0x000900c4, null, 0, null, 0, ptr(returned), null)) {
			throw new Error(`Couldn't make ${path} sparse.`);
		}
		// FILE_BEGIN.
		if (!calls.SetFilePointerEx(file, BigInt(bytes), null, 0) || !calls.SetEndOfFile(file)) {
			throw new Error(`Couldn't size ${path}.`);
		}
	} finally {
		calls.CloseHandle(file);
	}
}

/**
 * Clears the Hidden attribute of `path`, which Git for Windows sets on a clone's `.git`: a guest
 * can't read a hidden entry inside a share, and NVX won't share a checkout and its `.git` apart.
 * The attribute is only how Explorer shows the folder; nothing in it changes. False where the path
 * isn't there or keeps the attribute.
 */
export function unhide(path: string): boolean {
	if (process.platform !== "win32") return true;
	let calls = api();
	let name = wide(path);
	let attributes = calls.GetFileAttributesW(ptr(name));
	// INVALID_FILE_ATTRIBUTES.
	if (attributes === 0xffffffff) return false;
	// FILE_ATTRIBUTE_HIDDEN.
	if (!(attributes & 0x2)) return true;
	return !!calls.SetFileAttributesW(ptr(name), attributes & ~0x2);
}

/** A Windows job object holding one launch's `nvx.exe` and the OpenVMM it starts. */
export type KillJob = {
	/** Ends every process in the job at once. */
	kill(): void;
	/** How many of its processes are still running: a VM that outlives its kill is wedged. */
	active(): number;
	/** Lets go of the job; closing it ends whatever is still in it. */
	close(): void;
};

/**
 * Puts process `pid`, just started, in a job that ends it and every process it starts when the job
 * is killed or closed, so stopping a launch never leaves its OpenVMM running, as killing `nvx.exe`
 * alone does. A process `pid` starts before it joins is not in the job; `nvx` starts OpenVMM only
 * after it has read and checked its arguments and artifacts, later than this. Undefined where the
 * job can't be made, or off Windows.
 */
export function killJob(pid: number): KillJob | undefined {
	if (process.platform !== "win32") return undefined;
	let calls: ReturnType<typeof open>;
	try {
		calls = api();
	} catch {
		return undefined;
	}
	let job = calls.CreateJobObjectW(null, null);
	if (!job) return undefined;
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64 is 144 bytes; LimitFlags is at offset 16.
	let limits = new Uint8Array(144);
	new DataView(limits.buffer).setUint32(16, KILL_ON_JOB_CLOSE, true);
	let child = calls.OpenProcess(ASSIGN, 0, pid);
	if (
		!child
		|| !calls.SetInformationJobObject(job, EXTENDED_LIMITS, ptr(limits), limits.length)
		|| !calls.AssignProcessToJobObject(job, child)
	) {
		if (child) calls.CloseHandle(child);
		calls.CloseHandle(job);
		return undefined;
	}
	calls.CloseHandle(child);
	let open_ = true;
	return {
		kill() {
			if (open_) calls.TerminateJobObject(job, 1);
		},
		active() {
			if (!open_) return 0;
			// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION is 48 bytes; ActiveProcesses is at offset 40.
			let accounting = new Uint8Array(48);
			if (!calls.QueryInformationJobObject(job, ACCOUNTING, ptr(accounting), 48, null)) return 0;
			return new DataView(accounting.buffer).getUint32(40, true);
		},
		close() {
			if (!open_) return;
			open_ = false;
			calls.CloseHandle(job);
		},
	};
}
