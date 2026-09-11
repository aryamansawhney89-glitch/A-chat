self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => self.clients.claim());
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'A-Chat', body: 'New message' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'A-Chat', {
      body: data.body || 'You have a new message',
      icon: '/avatars/aria.svg',
      badge: '/avatars/aria.svg',
      vibrate: [100, 50, 100],
      data: { url: '/' }
    })
  );
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'notify') {
    self.registration.showNotification(event.data.title, {
      body: event.data.body,
      icon: '/avatars/aria.svg'
    });
  }
});
