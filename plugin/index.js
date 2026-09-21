/**
 * dsh-pager — the phone app's home inside DSH.
 *
 * Mounts one prefix route, /m, on DSH's own web server. Everything the phone
 * needs is served there (see server.js), so whatever already carries DSH's
 * web UI to a remote browser (a VPN, an authenticating gateway) carries this
 * too, with no change to DSH's bind address or source.
 *
 * Remove the `mobile` row from cordis.patch.yml (or this package) and DSH is
 * exactly as before; the desktop UI at / is never touched.
 *
 * @module dsh-pager
 */

import { createMobile } from './server.js'

/** Stable plugin name (Cordis convention). */
export const name = 'mobile'

/** Needs the web server for route registration and its bound port. */
export const inject = ['webServer']

/**
 * Injected into DSH's own page at `/`: the installed web app (iPhone "Add to
 * Home Screen") lands there after a gateway login that redirects to `/`, and
 * has no address bar to get back to /m/. Only standalone app windows move; a
 * normal browser tab keeps the desktop UI.
 */
const STANDALONE_TO_M = "(function(){try{if(location.pathname==='/'&&(navigator.standalone===true||matchMedia('(display-mode: standalone)').matches))location.replace('/m/')}catch(e){}})()"

/**
 * @param ctx - Cordis context carrying the injected `webServer`.
 * @param config - optional `{ trustedHosts: string[] }` from the cordis.patch.yml row:
 *   the non-loopback authorities (e.g. a VPN address `100.64.0.5:8080`) this
 *   deployment serves /m on. Mirror what you give DSH's own `connection` row.
 */
export function apply(ctx, config) {
  const trustedHosts = (config && config.trustedHosts) ?? []
  if (!Array.isArray(trustedHosts)) throw new Error('dsh-pager: trustedHosts must be a list of host[:port] strings')
  const mobile = createMobile({
    apiPort: () => ctx.webServer.port,
    log: (msg) => process.stdout.write(`[dsh-pager] ${msg}\n`),
    trustedHosts,
    pushDir: (config && config.pushDir) || undefined,
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/m', handler: mobile.handle }), 'dsh-mobile: /m route')
  ctx.effect(() => () => mobile.close(), 'dsh-mobile: live streams')
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: STANDALONE_TO_M })
  })
}
