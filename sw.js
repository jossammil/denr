// denr service worker.
// 1. Offline use: the app shell is cached at install; the R runtime (webr/),
//    large libraries (vendor/pdfjs-*) and packages from repo.r-wasm.org are
//    cached the first time they load.
// 2. Cross-origin isolation: GitHub Pages cannot send the COOP/COEP headers R
//    needs to be interrupted (SharedArrayBuffer), so this worker adds them to
//    every same-origin response.
// scripts/build.mjs fills in VERSION and PRECACHE.
const VERSION = "0.8.0-9f7582e1da";
const WEBR_VERSION = "0.6.1";
const PRECACHE = ["./","app.js","chunks/answer-IRJYQUT2.js","chunks/chunk-2FZRPMAP.js","chunks/chunk-6LFQ3K5Y.js","chunks/chunk-7SZRL6FY.js","chunks/chunk-FWSC4ABL.js","chunks/chunk-JV5KTYH7.js","chunks/chunk-TIPDRYC4.js","chunks/knit-UEL3LCCD.js","chunks/render-CIL753VR.js","chunks/typst-DXLLJQNK.js","chunks/webr-NWZDM6DN.js","css/app.css","icons/apple-touch-icon.png","icons/favicon-32.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/icon.svg","index.html","manifest.webmanifest","vendor/fonts/LICENSE-antonio.txt","vendor/fonts/LICENSE-chakra-petch.txt","vendor/fonts/LICENSE-jetbrains-mono.txt","vendor/fonts/LICENSE-saira-stencil-one.txt","vendor/fonts/antonio.woff2","vendor/fonts/chakra-petch-400.woff2","vendor/fonts/chakra-petch-600.woff2","vendor/fonts/jetbrains-mono.woff2","vendor/fonts/saira-stencil-one.woff2","vendor/plank/COPYRIGHTS","vendor/plank/LICENSE","vendor/plank/VERSION.json","vendor/plank/plank-core.js","vendor/plank/plank.css"];
const SHELL = `pocket-r-shell-${VERSION}`;
const RUNTIME = `pocket-r-webr-${WEBR_VERSION}`;
const PACKAGES = 'pocket-r-packages-v1';
// pdf.js, Typst, scratchy's editor and other large libraries, in versioned folders: kept once fetched.
const VENDOR = 'pocket-r-vendor-v1';
const LAZY = /^vendor\/(pdfjs|typst|scratchy)-/;
const REPO = 'https://repo.r-wasm.org/';
const UNIVERSE = 'https://jossammil.r-universe.dev/';
const scope = new URL(self.registration.scope);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE.map(path => new Request(new URL(path, scope), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith('pocket-r-shell-') && name !== SHELL) || (name.startsWith('pocket-r-webr-') && name !== RUNTIME)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && (response.type === 'basic' || response.type === 'cors')) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && (response.type === 'basic' || response.type === 'cors')) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw error;
  }
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  const url = new URL(request.url);
  if (request.mode === 'navigate' && url.pathname === scope.pathname) {
    const page = await cache.match(new URL('./index.html', scope));
    if (page) return page;
  }
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

// R's virtual filesystem reads some files lazily: a HEAD request for the size,
// then a GET. Both are answered from the cache, and partial (range) downloads
// are not offered, so each file is fetched whole once and works offline.
async function runtimeHead(url) {
  const response = await cacheFirst(RUNTIME, new Request(url, { method: 'GET' }));
  const length = (await response.clone().arrayBuffer()).byteLength;
  const headers = new Headers(response.headers);
  headers.delete('Accept-Ranges');
  headers.set('Content-Length', String(length));
  return new Response(null, { status: response.status, statusText: response.statusText, headers });
}
function wholeFile(response) {
  if (!response.headers.has('Accept-Ranges')) return response;
  const headers = new Headers(response.headers);
  headers.delete('Accept-Ranges');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const local = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
  const path = local ? url.pathname.slice(scope.pathname.length) : '';
  if (local && path.startsWith('webr/') && request.method === 'HEAD') {
    event.respondWith(runtimeHead(url).then(isolate));
    return;
  }
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (local) {
    const handler = path.startsWith('webr/') ? cacheFirst(RUNTIME, request).then(wholeFile)
      : LAZY.test(path) ? cacheFirst(VENDOR, request) : shell(request);
    event.respondWith(handler.then(isolate));
    return;
  }
  if (url.href.startsWith(REPO) || url.href.startsWith(UNIVERSE)) {
    // Package files are versioned and never change; the PACKAGES index does.
    const index = /\/PACKAGES(\.gz|\.rds)?$/.test(url.pathname);
    event.respondWith(index ? networkFirst(PACKAGES, request) : cacheFirst(PACKAGES, request));
  }
});
