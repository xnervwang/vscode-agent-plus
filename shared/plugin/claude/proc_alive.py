# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/proc_alive.py; sync-shared.js copies it, so edit it there.

"""os.kill(pid, 0) tells whether a process is running only on Linux and macOS. On Windows 0 is CTRL_C_EVENT, a Ctrl+C
sent to the console process group the pid names, and any other signal terminates the process, so there the process is
opened and its exit code read instead.
"""
import os

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ERROR_ACCESS_DENIED = 5


def alive(pid):
    """True when pid is a running process. Anything but a positive int is False."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        return _alive_windows(pid)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False


def _alive_windows(pid):
    """A process that cannot be opened for lack of rights exists. If the check itself fails, the process is taken to
    be running: a wrong yes shows a state that is out of date, a wrong no drops a live window or conversation."""
    try:
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return ctypes.get_last_error() == ERROR_ACCESS_DENIED
        try:
            code = wintypes.DWORD()
            return bool(k.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == STILL_ACTIVE
        finally:
            k.CloseHandle(handle)
    except Exception:
        return True
