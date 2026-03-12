import {
  auditLog,
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  checkRateLimit,
  decodeUrlToken,
  getClientIp,
  parseAndValidateTarget,
  proxify
} from "./proxy";

const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const CSS_URL_REGEX = /url\(([^)]+)\)/g;
const PROXY_PATH_PREFIX = "/api/p/";
const FONT_EXT_REGEX = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const STATIC_EXT_REGEX = /\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot)(\?|#|$)/i;
const LITE_BLOCK_HOSTS = [
  "improving.duckduckgo.com",
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "adservice.google.com",
  "scorecardresearch.com",
  "stats.g.doubleclick.net",
  "pixel.wp.com"
];

function isChromeOS(userAgent) {
  if (!userAgent) return false;
  return /CrOS/i.test(userAgent);
}

function hasLiteCookie(cookieHeader) {
  if (!cookieHeader) return false;
  const parts = cookieHeader.split(";").map((part) => part.trim().toLowerCase());
  return parts.some((part) => part.startsWith("proxy-lite=1"));
}

function shouldUseLiteMode(request) {
  const env = (process.env.PROXY_LITE_MODE || "").trim().toLowerCase();
  if (env === "true") return true;
  if (env === "false") return false;
  return (
    isChromeOS(request.headers.get("user-agent")) ||
    hasLiteCookie(request.headers.get("cookie"))
  );
}

function shouldBlockInLite(url) {
  if (!url) return false;
  if (
    LITE_BLOCK_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  ) {
    return true;
  }
  if (FONT_EXT_REGEX.test(url.pathname)) return true;
  return false;
}

function isStaticAsset(contentType, urlPath) {
  if (!contentType && !urlPath) return false;
  const lower = (contentType || "").toLowerCase();
  if (
    lower.startsWith("text/css") ||
    lower.includes("javascript") ||
    lower.startsWith("image/") ||
    lower.startsWith("font/")
  ) {
    return true;
  }
  return STATIC_EXT_REGEX.test(urlPath || "");
}

function getProxyOrigin(requestHeaders) {
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const proto = forwardedProto || "http";
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

function parseTargetFromProxiedPath(pathname) {
  if (pathname.startsWith("/api/p/e/")) {
    const rest = pathname.slice("/api/p/e/".length);
    const parts = rest.split("/");
    const token = parts[0];
    const decoded = decodeUrlToken(token);
    if (!decoded) return "";
    let origin = decoded;
    try {
      origin = new URL(decoded).origin;
    } catch {
      origin = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
    }
    if (parts.length > 1) {
      const tail = parts.slice(1).join("/");
      return `${origin}/${tail}`;
    }
    return decoded;
  }
  if (!pathname.startsWith(PROXY_PATH_PREFIX)) return "";
  const rest = pathname.slice(PROXY_PATH_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length < 2) return "";
  const scheme = parts[0];
  const host = parts[1];
  if (!scheme || !host) return "";
  return `${scheme}://${host}`;
}

function mapRefererToTarget(referer, proxyOrigin, fallbackOrigin) {
  if (!referer) return fallbackOrigin || "";
  try {
    const refUrl = new URL(referer);
    if (proxyOrigin && refUrl.origin === proxyOrigin) {
      if (refUrl.pathname.startsWith("/api/preview")) {
        const encoded = refUrl.searchParams.get("e");
        if (encoded) return decodeUrlToken(encoded);
        const target = refUrl.searchParams.get("url");
        if (target) return target;
      }
      const proxiedOrigin = parseTargetFromProxiedPath(refUrl.pathname);
      if (proxiedOrigin) return proxiedOrigin;
      if (fallbackOrigin) return fallbackOrigin;
    }
    return referer;
  } catch {
    return fallbackOrigin || "";
  }
}

function rewriteCss(css, baseUrl) {
  return css.replace(CSS_URL_REGEX, (match, url) => {
    const trimmed = url.trim().replace(/["']/g, "");
    const rewritten = proxify(trimmed, baseUrl);
    return `url(${rewritten})`;
  });
}

export async function handleProxyRequest(request, rawUrl) {
  console.log("proxy request", request.method, rawUrl);
  if (!SAFE_METHODS.has(request.method)) {
    return new Response("Method not allowed", { status: 405 });
  }

  const validation = parseAndValidateTarget(rawUrl);
  if (!validation.ok) {
    console.warn("proxy validation failed", rawUrl, validation.error);
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const liteMode = shouldUseLiteMode(request);
  if (
    liteMode &&
    (request.method === "GET" || request.method === "HEAD") &&
    shouldBlockInLite(validation.url)
  ) {
    const headers = new Headers();
    headers.set("cache-control", "public, max-age=86400, immutable");
    headers.set("x-proxy-lite", "1");
    return new Response(null, { status: 204, headers });
  }

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || "15000");
  const maxRetries = Math.max(0, Number(process.env.PROXY_UPSTREAM_RETRIES || "2"));
  const canRetry =
    (request.method === "GET" || request.method === "HEAD") && maxRetries > 0;

  const ip = getClientIp(request.headers);
  const rate = checkRateLimit(ip);
  if (!rate.ok) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "Retry-After": Math.ceil((rate.resetAt - Date.now()) / 1000).toString()
      }
    });
  }

  const headers = buildUpstreamHeaders(request.headers);
  const proxyOrigin = getProxyOrigin(request.headers);
  const mappedReferer = mapRefererToTarget(
    request.headers.get("referer"),
    proxyOrigin,
    validation.url.origin
  );
  if (mappedReferer) {
    headers.set("referer", mappedReferer);
  }
  const incomingOrigin = request.headers.get("origin");
  if (!incomingOrigin || (proxyOrigin && incomingOrigin === proxyOrigin)) {
    headers.set("origin", validation.url.origin);
  }
  headers.set("accept-encoding", "identity");
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
  }

  let upstream;
  let lastError;
  const bodyBuffer =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const baseDelayMs = 200;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
    try {
      upstream = await fetch(validation.url.toString(), {
        method: request.method,
        headers,
        body: bodyBuffer,
        redirect: "follow",
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (canRetry && upstream.status >= 500 && attempt < maxRetries) {
        await upstream.arrayBuffer().catch(() => {});
        const delayMs = Math.min(baseDelayMs * 2 ** attempt, 1000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (!canRetry || attempt >= maxRetries) break;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, 1000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!upstream) {
    const error = lastError || new Error("Upstream fetch failed");
    console.error("proxy upstream error:", validation.url.toString(), error);
    return Response.json(
      { error: "Upstream fetch failed", detail: String(error?.message || error) },
      { status: error?.name === "AbortError" ? 504 : 502 }
    );
  }
  console.log("proxy upstream ok", validation.url.toString(), upstream.status, Date.now() - startedAt, "ms");

  await auditLog({
    action: "proxy",
    url: validation.url.toString(),
    status: upstream.status,
    ip,
    userAgent: request.headers.get("user-agent") || "unknown"
  });

  const responseHeaders = buildDownstreamHeaders(upstream.headers, validation.url.origin);
  if (liteMode) {
    responseHeaders.set("x-proxy-lite", "1");
  }

  const contentType = responseHeaders.get("content-type") || "";
  if (contentType.includes("text/css")) {
    const css = await upstream.text();
    const rewrittenCss = rewriteCss(css, validation.url.toString());
    responseHeaders.set("content-length", Buffer.byteLength(rewrittenCss).toString());
    return new Response(rewrittenCss, {
      status: upstream.status,
      headers: responseHeaders
    });
  }

  if (request.method === "HEAD") {
    if (liteMode && isStaticAsset(contentType, validation.url.pathname)) {
      responseHeaders.set("cache-control", "public, max-age=86400, immutable");
    }
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders
    });
  }

  const lowerType = contentType.toLowerCase();
  const shouldStream =
    Boolean(request.headers.get("range")) ||
    upstream.status === 206 ||
    lowerType.startsWith("video/") ||
    lowerType.startsWith("audio/") ||
    lowerType.includes("text/event-stream");

  if (shouldStream) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  }

  const body = await upstream.arrayBuffer();
  if (liteMode && isStaticAsset(contentType, validation.url.pathname)) {
    responseHeaders.set("cache-control", "public, max-age=86400, immutable");
  }
  responseHeaders.set("content-length", body.byteLength.toString());
  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders
  });
}
