/** Bounded, reusable mobile previews. Source files are never modified. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export function createVideoPreviews({ dir, ffmpeg = 'ffmpeg', spawnProcess = spawn, log = () => {} }) {
  const jobs = new Map(), queue = []
  let active = null, closed = false
  function pump() {
    if (closed || active || !queue.length) return
    const job = active = queue.shift()
    job.state = 'preparing'
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', job.source,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '1400k', '-bufsize', '2800k', '-r', '30',
      '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', job.temp]
    let child, finished = false
    const finish = (ok) => {
      if (finished) return
      finished = true; clearTimeout(job.timer)
      try {
        if (ok && !closed && fs.statSync(job.temp).size > 0) { fs.renameSync(job.temp, job.file); job.state = 'ready' }
        else job.state = 'unavailable'
      } catch { job.state = 'unavailable' }
      if (job.state !== 'ready') { try { fs.unlinkSync(job.temp) } catch {} }
      active = null; pump()
    }
    try {
      child = job.child = spawnProcess(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
      child.once('error', (err) => { log(`video preview: ${err.code || 'encoder unavailable'}`); finish(false) })
      child.once('close', (code) => finish(code === 0 && !job.timedOut))
      job.timer = setTimeout(() => { job.timedOut = true; child.kill() }, 10 * 60 * 1000)
    } catch { finish(false) }
  }
  function request(source, stat) {
    const key = crypto.createHash('sha256').update(JSON.stringify([source, stat.size, stat.mtimeMs, 'mobile-1280-30-v1'])).digest('hex')
    const file = path.join(dir, key + '.mp4')
    try { if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) return { state: 'ready', file } } catch {}
    if (jobs.has(key)) return jobs.get(key)
    if (closed || queue.length >= 8) return { state: 'unavailable' }
    try { fs.mkdirSync(dir, { recursive: true }) } catch { return { state: 'unavailable' } }
    const job = { state: 'preparing', source, file, temp: path.join(dir, key + '.partial.mp4') }
    jobs.set(key, job); queue.push(job); pump()
    return job
  }
  function close() { closed = true; queue.length = 0; if (active && active.child) active.child.kill() }
  return { request, close }
}
