/* Service worker to proxy same-origin requests from preview pages. */
const PROXY_PREFIX = "/api/p/";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function isBypassPath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/interceptor.js" ||
    pathname === "/proxy-sw.js"
  );
}

function buildProxyPath(url) {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(":", "");
    const host = parsed.host;
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    const base = `${PROXY_PREFIX}${scheme}/${host}${path}`;
    return parsed.search ? `${base}${parsed.search}` : base;
  } catch {
    return "";
  }
}

function buildPreviewPath(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return `/api/preview?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return "";
  }
}

function getPreviewTargetFromReferrer(referrer) {
  if (!referrer) return "";
  try {
    const refUrl = new URL(referrer);
    if (!refUrl.pathname.startsWith("/api/preview")) return "";
    return refUrl.searchParams.get("url") || "";
  } catch {
    return "";
  }
}

async function getClientTargetBase(clientId) {
  if (!clientId) return "";
  const client = await self.clients.get(clientId);
  if (!client || !client.url) return "";
  const url = new URL(client.url);
  if (!url.pathname.startsWith("/api/preview")) return "";
  return url.searchParams.get("url") || "";
}

self.addEventListener("fetch", (event) => {
  const reqUrl = new URL(event.request.url);

  // Never intercept the proxy itself or Next assets.
  if (reqUrl.origin === self.location.origin && isBypassPath(reqUrl.pathname)) return;

  event.respondWith((async () => {
    const isNavigation = event.request.mode === "navigate";
    let targetBase = await getClientTargetBase(event.clientId);
    if (!targetBase) {
      targetBase =
        getPreviewTargetFromReferrer(event.request.referrer) ||
        getPreviewTargetFromReferrer(event.request.headers.get("referer"));
    }
    const isSameOrigin = reqUrl.origin === self.location.origin;
    const canProxyDirect = !isSameOrigin && /^https?:$/.test(reqUrl.protocol);
    if (!targetBase && !canProxyDirect) {
      return fetch(event.request);
    }

    let targetUrl = reqUrl.href;
    if (isSameOrigin && targetBase) {
      targetUrl = new URL(reqUrl.pathname + reqUrl.search, targetBase).toString();
    }

    if (isNavigation) {
      const previewUrl = buildPreviewPath(targetUrl);
      if (!previewUrl) return fetch(event.request);
      const headers = new Headers(event.request.headers);
      return fetch(previewUrl, {
        headers,
        redirect: "follow",
        credentials: "omit",
      });
    }

    const proxied = buildProxyPath(targetUrl);
    if (!proxied) return fetch(event.request);

    const init = {
      method: event.request.method,
      credentials: "omit",
      redirect: "follow",
    };
    const headers = new Headers(event.request.headers);
    if (event.request.method !== "GET" && event.request.method !== "HEAD") {
      const contentType = event.request.headers.get("content-type");
      if (contentType) {
        headers.set("content-type", contentType);
      }
      init.body = await event.request.clone().arrayBuffer();
    }
    init.headers = headers;
    return fetch(proxied, init);
  })());
});
