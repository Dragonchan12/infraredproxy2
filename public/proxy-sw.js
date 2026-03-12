/* Service worker to proxy same-origin requests from preview pages. */
const PROXY_PREFIX = "/api/p/";
const PREVIEW_PARAM = "url";
const ENCODE_PARAM = "e";
const FORCE_ENCODE = true;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function isBypassPath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/interceptor.js" ||
    pathname === "/proxy-sw.js"
  );
}

function buildProxyPath(url) {
  try {
    if (isEncodeEnabled()) {
      return `${PROXY_PREFIX}e/${encodeUrlToken(url)}`;
    }
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
    if (isEncodeEnabled()) {
      return `/api/preview?e=${encodeUrlToken(parsed.toString())}`;
    }
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
    const encoded = refUrl.searchParams.get(ENCODE_PARAM);
    if (encoded) return decodeUrlToken(encoded);
    return refUrl.searchParams.get(PREVIEW_PARAM) || "";
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
  const encoded = url.searchParams.get(ENCODE_PARAM);
  if (encoded) return decodeUrlToken(encoded);
  return url.searchParams.get(PREVIEW_PARAM) || "";
}

function isEncodeEnabled() {
  return FORCE_ENCODE || self.__proxyEncode === true;
}

function updateEncodeFlag({ clientUrl, referrer, cookieHeader }) {
  if (FORCE_ENCODE) {
    self.__proxyEncode = true;
    return;
  }
  if (self.__proxyEncode === true) return;
  if (cookieHeader && cookieHeader.toLowerCase().includes("proxy-encode=1")) {
    self.__proxyEncode = true;
    return;
  }
  try {
    if (clientUrl) {
      const url = new URL(clientUrl);
      if (url.pathname.startsWith("/api/preview") && url.searchParams.get(ENCODE_PARAM)) {
        self.__proxyEncode = true;
        return;
      }
    }
  } catch {
    // Ignore client URL parsing.
  }
  try {
    if (referrer) {
      const url = new URL(referrer);
      if (url.pathname.startsWith("/api/preview") && url.searchParams.get(ENCODE_PARAM)) {
        self.__proxyEncode = true;
      }
    }
  } catch {
    // Ignore referrer parsing.
  }
}

function encodeUrlToken(url) {
  try {
    const encoded = btoa(unescape(encodeURIComponent(url)));
    return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } catch {
    return "";
  }
}

function decodeUrlToken(token) {
  if (!token) return "";
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
    return decodeURIComponent(escape(atob(pad)));
  } catch {
    return "";
  }
}

self.addEventListener("fetch", (event) => {
  const reqUrl = new URL(event.request.url);

  event.respondWith((async () => {
    const isNavigation = event.request.mode === "navigate";
    let targetBase = await getClientTargetBase(event.clientId);
    if (!targetBase) {
      targetBase =
        getPreviewTargetFromReferrer(event.request.referrer) ||
        getPreviewTargetFromReferrer(event.request.headers.get("referer"));
    }
    updateEncodeFlag({
      clientUrl: (await self.clients.get(event.clientId))?.url,
      referrer: event.request.referrer || event.request.headers.get("referer"),
      cookieHeader: event.request.headers.get("cookie")
    });
    const isSameOrigin = reqUrl.origin === self.location.origin;
    if (isSameOrigin) {
      if (isBypassPath(reqUrl.pathname)) return fetch(event.request);
      if (reqUrl.pathname.startsWith("/_next/") && !targetBase) {
        return fetch(event.request);
      }
    }
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
