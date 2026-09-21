'use strict'
/*
 * Service worker of the installed web app (iPhone "Add to Home Screen").
 * It only turns Web Push messages into notifications and opens the session a
 * notification is about. Nothing is cached: the UI always comes from the PC.
 */

self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()) })

self.addEventListener('push', function (e) {
  var d = {}
  try { d = e.data ? e.data.json() : {} } catch (err) { d = { body: e.data ? e.data.text() : '' } }
  // iOS requires every push to show a notification; there are no silent ones.
  e.waitUntil(self.registration.showNotification(d.title || 'DSH', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    requireInteraction: Boolean(d.sticky),
    icon: '/m/icon-192.png',
    badge: '/m/icon-192.png',
    data: { s: d.s || '' },
  }))
})

self.addEventListener('notificationclick', function (e) {
  e.notification.close()
  var s = (e.notification.data && e.notification.data.s) || ''
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (new URL(list[i].url).pathname.indexOf('/m/') === 0 && 'focus' in list[i]) {
        list[i].postMessage({ t: 'open', s: s })
        return list[i].focus()
      }
    }
    return self.clients.openWindow('/m/' + (s ? '#' + encodeURIComponent(s) : ''))
  }))
})
