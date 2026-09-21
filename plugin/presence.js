/**
 * Is anyone at this PC? Windows only: milliseconds since the last keyboard or
 * mouse input (user32 GetLastInputInfo) and whether the lock screen is up
 * (LogonUI.exe runs while the session is locked).
 *
 * One long-lived PowerShell child prints "<idleMs> <locked>" every 2 s, so a
 * check costs a variable read, not a process spawn. It starts on first use
 * and is restarted a few times if it dies; elsewhere `get()` returns null
 * (unknown), which callers treat as "present".
 *
 * GetLastInputInfo is per session: this must run in the user's interactive
 * session (DSH started at logon, not as a service), or it reports nonsense.
 */

import { spawn } from 'node:child_process'

const script = (parent) => `
$ErrorActionPreference = 'Stop'
$parent = ${Number(parent) || 0}
# Windows reuses PIDs quickly: the parent is "alive" only while the same PID has the same start time.
$born = if ($parent) { (Get-Process -Id $parent).StartTime } else { $null }
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class DshIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Ms() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return unchecked((uint)Environment.TickCount - l.dwTime); }
}
'@
while ($true) {
  # Writing to a dead parent's pipe does not always fail: leave explicitly when it is gone.
  if ($parent) {
    $p = Get-Process -Id $parent -ErrorAction SilentlyContinue
    if (-not $p -or $p.StartTime -ne $born) { exit }
  }
  $locked = [int][bool](Get-Process LogonUI -ErrorAction SilentlyContinue)
  [Console]::Out.WriteLine(([string][DshIdle]::Ms()) + ' ' + $locked)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}`

/**
 * @param {{ log?: (m: string) => void, platform?: string, spawnImpl?: typeof spawn }} [opts]
 * @returns {{ get(): { idleMs: number, locked: boolean, at: number } | null, close(): void }}
 */
export function createPresence({ log = () => {}, platform = process.platform, spawnImpl = spawn } = {}) {
  let child = null
  let last = null
  let restarts = 0
  let closed = false

  function start() {
    if (closed || platform !== 'win32' || child || restarts > 3) return
    child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = /^(\d+) ([01])/.exec(buf.slice(0, i).trim())
        buf = buf.slice(i + 1)
        if (m) last = { idleMs: Number(m[1]), locked: m[2] === '1', at: Date.now() }
      }
    })
    child.on('exit', (code) => {
      child = null
      if (closed) return
      restarts++
      log(`presence: helper exited (${code}), restart ${restarts}`)
      setTimeout(start, 5000 * restarts).unref()
    })
    child.on('error', () => {})
  }

  return {
    get() {
      if (!child) start()
      // A reading older than 10 s means the helper stalled: unknown.
      return last && Date.now() - last.at < 10000 ? last : null
    },
    close() {
      closed = true
      if (child) { try { child.kill() } catch {} }
    },
  }
}
