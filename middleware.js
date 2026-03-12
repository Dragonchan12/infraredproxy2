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

function buildProxyPath(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const scheme = parsed.protocol.replace(":", "");
    const host = parsed.host;
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    const base = `/api/p/${scheme}/${host}${path}`;
    return parsed.search ? `${base}${parsed.search}` : base;
  } catch {
    return "";
  }
}

function parseTargetFromProxiedPath(pathname) {
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
    const target = refUrl.searchParams.get("url");
    if (target) return new URL(target);
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
        targetBase = new URL(decodeURIComponent(cookieBase));
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
    previewUrl.search = `?url=${encodeURIComponent(targetUrl)}`;
    return NextResponse.redirect(previewUrl);
  }

  const proxyPath = buildProxyPath(targetUrl);
  if (!proxyPath) return NextResponse.next();
  const proxyUrl = new URL(request.url);
  proxyUrl.pathname = proxyPath;
  proxyUrl.search = "";
  return NextResponse.redirect(proxyUrl);
}

export const config = {
  matcher: ["/:path*"]
};
