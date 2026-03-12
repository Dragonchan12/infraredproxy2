import { NextResponse } from "next/server";

const INTERNAL_PREFIXES = [
  "/_next",
  "/api",
  "/interceptor.js",
  "/proxy-sw.js",
  "/favicon.ico"
];

function isInternalPath(pathname) {
  return INTERNAL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function shouldEncodeUrls() {
  return (process.env.PROXY_ENCODE_URLS || "true").trim().toLowerCase() !== "false";
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

function buildProxyPath(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (shouldEncodeUrls()) {
      const token = encodeUrlToken(parsed.origin);
      if (token) {
        const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
        return { pathname: `/api/p/e/${token}${path}`, search: parsed.search || "" };
      }
    }
    const scheme = parsed.protocol.replace(":", "");
    const host = parsed.host;
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    return { pathname: `/api/p/${scheme}/${host}${path}`, search: parsed.search || "" };
  } catch {
    return null;
  }
}

function buildPreviewSearch(targetUrl) {
  if (shouldEncodeUrls()) {
    const token = encodeUrlToken(targetUrl);
    if (token) return `?e=${token}`;
  }
  return `?url=${encodeURIComponent(targetUrl)}`;
}

function parseTargetFromProxiedPath(pathname) {
  if (pathname.startsWith("/api/p/e/")) {
    const rest = pathname.slice("/api/p/e/".length);
    const token = rest.split("/")[0];
    const decoded = decodeUrlToken(token);
    if (!decoded) return null;
    try {
      return new URL(decoded).origin;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith("/api/p/")) return null;
  const rest = pathname.slice("/api/p/".length);
  const parts = rest.split("/");
  if (parts.length < 2) return null;
  const scheme = parts[0];
  const host = parts[1];
  if (!scheme || !host) return null;
  return `${scheme}://${host}`;
}

function getTargetBaseFromReferer(referer) {
  if (!referer) return null;
  try {
    const refUrl = new URL(referer);
    if (refUrl.pathname.startsWith("/api/preview")) {
      const encoded = refUrl.searchParams.get("e");
      if (encoded) {
        const decoded = decodeUrlToken(encoded);
        if (decoded) return new URL(decoded);
      }
      const target = refUrl.searchParams.get("url");
      if (target) return new URL(target);
    }
    const proxiedOrigin = parseTargetFromProxiedPath(refUrl.pathname);
    if (proxiedOrigin) return new URL(proxiedOrigin);
  } catch {
    return null;
  }
  return null;
}

export function middleware(request) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/" || isInternalPath(pathname)) {
    return NextResponse.next();
  }

  let targetBase = getTargetBaseFromReferer(request.headers.get("referer"));
  if (!targetBase) {
    const cookieBase = request.cookies.get("proxy-base")?.value;
    if (cookieBase) {
      try {
        if (cookieBase.startsWith("e:")) {
          const decoded = decodeUrlToken(cookieBase.slice(2));
          if (decoded) {
            targetBase = new URL(decoded);
          }
        } else {
          targetBase = new URL(decodeURIComponent(cookieBase));
        }
      } catch {
        targetBase = null;
      }
    }
  }
  if (!targetBase) return NextResponse.next();

  const targetUrl = new URL(`${pathname}${search}`, targetBase.origin).toString();
  const dest = request.headers.get("sec-fetch-dest") || "";
  const shouldPreview = dest === "document" || dest === "iframe" || dest === "frame";

  if (shouldPreview) {
    const previewUrl = new URL(request.url);
    previewUrl.pathname = "/api/preview";
    previewUrl.search = buildPreviewSearch(targetUrl);
    return NextResponse.redirect(previewUrl);
  }

  const proxyPath = buildProxyPath(targetUrl);
  if (!proxyPath) return NextResponse.next();
  const proxyUrl = new URL(request.url);
  proxyUrl.pathname = proxyPath.pathname;
  proxyUrl.search = proxyPath.search || "";
  return NextResponse.rewrite(proxyUrl);
}

export const config = {
  matcher: ["/:path*"]
};
