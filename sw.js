// 简单的 Service Worker，满足 PWA 安装要求
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Install');
    e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
    console.log('[Service Worker] Activate');
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
    // 简单的透传策略，确保有 fetch handler
    e.respondWith(fetch(e.request));
});
