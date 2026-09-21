/**
 * Standalone dev server: serves /m exactly as the DSH plugin does, but in its
 * own process, talking to the running DSH over loopback. Lets the UI and the
 * API be developed against real data without restarting DSH.
 *
 *   node dev.mjs            -> http://127.0.0.1:3090/m/
 *   PORT=3091 DSH_PORT=3080 node dev.mjs
 *   TRUSTED_HOSTS=100.64.0.5:8080 node dev.mjs   (comma-separated, as the plugin's trustedHosts)
 */

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMobile } from './server.js'

const PORT = Number(process.env.PORT || 3090)
const DSH_PORT = Number(process.env.DSH_PORT || 3080)

const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)

// Its own push state: a dev server next to the live plugin must not push every notice twice.
const PUSH_DIR = process.env.PUSH_DIR || path.join(os.homedir(), '.dsh-pager-dev')

const mobile = createMobile({ apiPort: () => DSH_PORT, log: (m) => console.log(`[dsh-pager] ${m}`), trustedHosts: TRUSTED_HOSTS, pushDir: PUSH_DIR })

http
  .createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/m/' }); res.end(); return }
    if ((req.url || '').startsWith('/m')) return mobile.handle(req, res)
    res.writeHead(404)
    res.end()
  })
  .listen(PORT, '127.0.0.1', () => console.log(`dsh-pager dev: http://127.0.0.1:${PORT}/m/  (DSH on ${DSH_PORT})`))
