// 手护健康 · Service Worker（离线可用）
// 策略：
//   页面/代码/模型  —— 网络优先（保证更新及时生效、大文件不会被半截缓存坑），
//                       断网时回退缓存
//   语音/图标        —— 缓存优先（文件名带 ?v= 版本号，改版本号自动取新文件）
//   跨域资源         —— 网络优先 + 运行时缓存
const CACHE_NAME = "handrehab-v2";   // v2：旧版缓存过模型分段下载的半截文件，必须整库废弃
const CORE = ["./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  // 分段（Range）请求必须直连网络：缓存里存的是整文件或前一段字节，
  // 拿错字节给加载器会把它卡死（模型加载器会用 Range 读文件）
  if (e.request.headers.get("Range")) {
    e.respondWith(fetch(e.request));
    return;
  }

  const url = new URL(e.request.url);

  // 跨域（MediaPipe wasm 等 CDN 资源）：网络优先 + 运行时缓存
  if (url.origin !== location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          caches.open(CACHE_NAME)
            .then((c) => c.put(e.request, res.clone()))
            .catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 同源：HTML/代码/模型 网络优先（及时更新、防止半截缓存坑模型加载），
  // 语音/图标 缓存优先（离线即时可用）。只缓存完整的 200 响应，分段（206）不缓存
  const isCritical = url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html") ||
    /\.(task|wasm|mjs|js)$/i.test(url.pathname);
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok && res.status === 200) {
            caches.open(CACHE_NAME)
              .then((c) => c.put(e.request, res.clone()))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return isCritical ? fetched : (hit || fetched);
    })
  );
});
