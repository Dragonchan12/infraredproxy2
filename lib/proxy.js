import fs from "fs/promises";
import net from "net";
import { checkRateLimit } from "./rate-limit";

function parseWhitelist() {
  const raw = process.env.PROXY_WHITELIST || "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateIPv4(host) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateIPv6(host) {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe80")) return true; // fe80::/10
  return false;
}

function isPrivateHost(host) {
  const lowered = host.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".local") || lowered.endsWith(".internal")) {
    return true;
  }
  if (net.isIP(lowered) === 4) return isPrivateIPv4(lowered);
  if (net.isIP(lowered) === 6) return isPrivateIPv6(lowered);
  return false;
}

function hostMatchesEntry(host, entry) {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (entry.startsWith(".")) {
    const suffix = entry.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === entry;
}

export function isHostAllowed(host) {
  const allowlist = parseWhitelist();
  if (allowlist.length === 0) return false;
  return allowlist.some((entry) => hostMatchesEntry(host, entry));
}

export function getAllowlist() {
  return parseWhitelist();
}

export function parseAndValidateTarget(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: "Missing url parameter." };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, error: "Only http and https are allowed." };
  }

  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { ok: false, error: "Target host is not allowed." };
  }

  const whitelistEnabled = process.env.PROXY_WHITELIST_ENABLED !== 'false';
  if (whitelistEnabled && !isHostAllowed(host)) {
    return { ok: false, error: "Target host is not on the allowlist." };
  }

  return { ok: true, url: parsed };
}

export function shouldEncodeUrls() {
  return (process.env.PROXY_ENCODE_URLS || "true").trim().toLowerCase() !== "false";
}

export function encodeUrlToken(url) {
  if (!url) return "";
  return Buffer.from(url, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeUrlToken(token) {
  if (!token) return "";
  const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function getClientIp(headers) {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = headers.get("x-real-ip");
  return realIp || "unknown";
}

export function buildUpstreamHeaders(requestHeaders) {
  const headers = new Headers();
  const allow = [
    "accept",
    "accept-language",
    "cookie",
    "dnt",
    "if-range",
    "origin",
    "referer",
    "range",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "upgrade-insecure-requests",
    "user-agent",
  ];
  const cookiesEnabled =
    (process.env.PROXY_COOKIES_ENABLED || "false").trim().toLowerCase() === "true";
  allow.forEach((name) => {
    if (name === "cookie" && !cookiesEnabled) return;
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  });
  if (!headers.get("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  return headers;
}

export function buildDownstreamHeaders(upstreamHeaders, targetOrigin) {
    const headers = new Headers();
    const allow = [
        "accept-ranges",
        "content-disposition",
        "content-range",
        "content-type",
        "etag",
        "last-modified",
    ];
    allow.forEach(name => {
        const value = upstreamHeaders.get(name);
        if (value) headers.set(name, value);
    });

    appendSetCookies(upstreamHeaders, headers);

    const location = upstreamHeaders.get("location");
    if (location) {
        const resolved = new URL(location, targetOrigin).toString();
        headers.set("location", proxify(resolved, targetOrigin));
    }

    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.delete("content-encoding");
    headers.delete("content-length");
    return headers;
}

export function appendSetCookies(upstreamHeaders, downstreamHeaders) {
    const cookiesEnabled =
        (process.env.PROXY_COOKIES_ENABLED || "false").trim().toLowerCase() === "true";
    if (!cookiesEnabled) return;
    const setCookies = getSetCookieHeaders(upstreamHeaders);
    setCookies.forEach((value) => {
        const rewritten = rewriteSetCookie(value);
        if (rewritten) downstreamHeaders.append("set-cookie", rewritten);
    });
}

function getSetCookieHeaders(upstreamHeaders) {
    if (typeof upstreamHeaders.getSetCookie === "function") {
        return upstreamHeaders.getSetCookie();
    }
    const combined = upstreamHeaders.get("set-cookie");
    if (!combined) return [];
    return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(header) {
    const parts = [];
    let start = 0;
    let inExpires = false;
    for (let i = 0; i < header.length; i++) {
        const segment = header.slice(i, i + 8).toLowerCase();
        if (segment === "expires=") {
            inExpires = true;
        }
        const char = header[i];
        if (char === ";" && inExpires) {
            inExpires = false;
        }
        if (char === "," && !inExpires) {
            const slice = header.slice(start, i).trim();
            if (slice) parts.push(slice);
            start = i + 1;
        }
    }
    const last = header.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

function rewriteSetCookie(headerValue) {
    if (!headerValue) return headerValue;
    const parts = headerValue.split(";").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return headerValue;
    const [nameValue, ...attrs] = parts;
    const name = nameValue.split("=")[0] || "";
    const stripSecure =
        (process.env.PROXY_STRIP_SECURE_COOKIES || "false").trim().toLowerCase() === "true";
    const requiresSecurePrefix = name.startsWith("__Secure-") || name.startsWith("__Host-");
    const rewritten = [nameValue];
    attrs.forEach((attr) => {
        const [key] = attr.split("=");
        if (!key) return;
        const lower = key.toLowerCase();
        if (lower === "domain") return;
        if (lower === "secure") {
            if (stripSecure && !requiresSecurePrefix) return;
            rewritten.push("Secure");
            return;
        }
        rewritten.push(attr);
    });
    return rewritten.join("; ");
}


export async function auditLog(entry) {
  const payload = {
    time: new Date().toISOString(),
    ...entry
  };
  console.log(JSON.stringify(payload));

  const logPath = process.env.AUDIT_LOG_PATH;
  if (!logPath) return;
  try {
    await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    console.warn("Audit log write failed:", error);
  }
}


export function shouldRewrite(value) {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isAlreadyProxied(trimmed)) return false;
  if (trimmed.startsWith("#")) return false;
  if (/^(data:|javascript:|mailto:|tel:)/i.test(trimmed)) return false;
  return true;
}

function isAlreadyProxied(value) {
  return (
    value.startsWith("/api/proxy?") ||
    value.startsWith("/api/preview?") ||
    value.startsWith("/api/p/") ||
    value.startsWith("/api/p/e/")
  );
}

function buildProxyPath(url) {
  try {
    if (shouldEncodeUrls()) {
      return `/api/p/e/${encodeUrlToken(url)}`;
    }
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(":", "");
    const host = parsed.host;
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    const base = `/api/p/${scheme}/${host}${path}`;
    return parsed.search ? `${base}${parsed.search}` : base;
  } catch {
    return "";
  }
}

export function proxify(value, baseUrl) {
  if (!shouldRewrite(value)) return value;
  try {
    const resolved = new URL(value, baseUrl);
    if (!/^https?:$/.test(resolved.protocol)) return value;
    const path = buildProxyPath(resolved.toString());
    return path || value;
  } catch {
    return value;
  }
}

export function proxifyDocument(value, baseUrl) {
  if (!shouldRewrite(value)) return value;
  try {
    const resolved = new URL(value, baseUrl);
    if (!/^https?:$/.test(resolved.protocol)) return value;
    if (shouldEncodeUrls()) {
      return `/api/preview?e=${encodeUrlToken(resolved.toString())}`;
    }
    return `/api/preview?url=${encodeURIComponent(resolved.toString())}`;
  } catch {
    return value;
  }
}

export { checkRateLimit };
