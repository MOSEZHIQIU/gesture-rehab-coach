// 手护健康 · Service Worker（离线可用）
// 策略（v3）：
//   页面 HTML            —— 网络优先（保证更新及时生效），断网回退缓存
//   模型/识别库/语音/图标 —— 缓存优先；装图标时预缓存整个模型，之后加载器
//                       的 Range 分段请求直接从缓存切片回 206，不再每次重下
//   （库和模型文件内容不变，升级靠 CACHE_NAME 整库换新）
//   跨域资源             —— 网络优先 + 运行时缓存
const CACHE_NAME = "handrehab-v3";
//   v2：旧版缓存过模型分段下载的半截文件，必须整库废弃
//   v3：模型加载器用 Range 读文件，v2 的"Range 直连网络"=每次重下模型；
//       改为从缓存的完整模型切字节回 206，并预缓存整个模型文件
const CORE = ["./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png",
  "./hand_landmarker.task?v=2"];   // 预缓存整模型：Range 切片才有整块来源

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

  // 分段（Range）请求：从缓存的完整文件切出对应字节回 206
  // （模型加载器分段读模型用）。缓存里没有完整文件才直连网络。
  // 绝不能拿半截字节凑合——字节对不上加载器会卡死
  if (e.request.headers.get("Range")) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (!cached) return fetch(e.request);
        const m = e.request.headers.get("Range").match(/^bytes=(\d*)-(\d*)$/);
        if (!m) return fetch(e.request);
        return cached.blob().then((blob) => {
          let start, end;
          if (m[1] === "") {              // 后缀范围 bytes=-N（取最后 N 字节）
            const n = parseInt(m[2], 10);
            start = Math.max(blob.size - n, 0);
            end = blob.size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = (m[2] === "") ? blob.size - 1
                                : Math.min(parseInt(m[2], 10), blob.size - 1);
          }
          if (start >= blob.size || start > end) return fetch(e.request);
          const body = blob.slice(start, end + 1);
          return new Response(body, {
            status: 206,
            headers: {
              "Content-Type": cached.headers.get("Content-Type") ||
                "application/octet-stream",
              "Content-Range": "bytes " + start + "-" + end + "/" + blob.size,
              "Content-Length": String(body.size),
              "Accept-Ranges": "bytes",
            },
          });
        });
      }).catch(() => fetch(e.request))
    );
    return;
  }

  // 同源：HTML 网络优先（更新及时），其余缓存优先。
  // 只缓存完整的 200 响应，分段（206）不缓存
  const isHtml = url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html");
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
      return isHtml ? fetched : (hit || fetched);
    })
  );
});
