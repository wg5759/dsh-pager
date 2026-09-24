import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STANDALONE_TO_M } from '../index.js'

/** Run the script injected into DSH's page with a fake browser; returns where it sent the page, if anywhere. */
function run({ path = '/', standalone, touch = 0, displayStandalone = false }) {
  let to = null
  const location = { pathname: path, replace: (u) => { to = u } }
  const navigator = { maxTouchPoints: touch }
  if (standalone !== undefined) navigator.standalone = standalone
  const matchMedia = (q) => ({ matches: displayStandalone && /display-mode:\s*standalone/.test(q) })
  new Function('location', 'navigator', 'matchMedia', STANDALONE_TO_M)(location, navigator, matchMedia)
  return to
}

test('only the iPhone / iPad home-screen app is sent to /m/; the PC keeps DSH', () => {
  // DSH installed as a desktop app (Edge / Chrome window): must stay on DSH's own UI.
  assert.equal(run({ displayStandalone: true }), null)
  // iPhone / iPad "Add to Home Screen" app landing on / after a gateway login.
  assert.equal(run({ standalone: true, touch: 5, displayStandalone: true }), '/m/')
  // A Mac's Safari web app ("Add to Dock"): no touch screen, not ours.
  assert.equal(run({ standalone: true, touch: 0, displayStandalone: true }), null)
  // Safari tab on an iPhone: the desktop UI stays reachable.
  assert.equal(run({ standalone: false, touch: 5 }), null)
  // Already in the phone UI, or any other page: nothing to do.
  assert.equal(run({ path: '/m/', standalone: true, touch: 5 }), null)
})
