import { load } from "cheerio";
import {
  auditLog,
  appendSetCookies,
  buildUpstreamHeaders,
  checkRateLimit,
  decodeUrlToken,
  encodeUrlToken,
  getClientIp,
  parseAndValidateTarget,
  proxify,
  proxifyDocument,
  shouldEncodeUrls,
} from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PROXY_ASSET_VERSION = "2026-03-12a";

function getProxyBaseFromCookies(cookieHeader) {
  if (!cookieHeader) return "";
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.toLowerCase().startsWith("proxy-base=")) {
      const raw = part.slice("proxy-base=".length);
      if (!raw) return "";
      if (raw.startsWith("e:")) {
        return decodeUrlToken(raw.slice(2)) || "";
      }
      return decodeURIComponent(raw);
    }
  }
  return "";
}

function unwrapPreviewUrl(rawUrl, requestOrigin) {
  let current = rawUrl;
  for (let i = 0; i < 5; i++) {
    if (!current) break;
    try {
      const parsed = new URL(current);
      if (parsed.pathname === "/api/preview") {
        const encoded = parsed.searchParams.get("e");
        if (encoded) {
          const decoded = decodeUrlToken(encoded);
          if (!decoded) break;
          current = decoded;
          continue;
        }
        const inner = parsed.searchParams.get("url");
        if (!inner) break;
        current = inner;
        continue;
      }
    } catch {
      // Ignore invalid URLs.
    }
    break;
  }
  return current;
}

function rewriteSrcset(srcset, baseUrl) {
  if (!srcset) return srcset;
  if (/(data:|blob:)/i.test(srcset)) return srcset;
  const entries = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, ...descriptor] = entry.split(/\s+/);
      const rewritten = proxify(url, baseUrl);
      return [rewritten, ...descriptor].join(" ");
    });
  return entries.join(", ");
}

export async function GET(request) {
  try {
    const requestUrl = new URL(request.url);
    const isTopMode = requestUrl.searchParams.get("top") === "1";
    let rawUrl = requestUrl.searchParams.get("url");
    if (!rawUrl) {
      const encoded = requestUrl.searchParams.get("e");
      if (encoded) {
        rawUrl = decodeUrlToken(encoded);
      }
    }
    if (!rawUrl) {
      const referer = request.headers.get("referer");
      if (referer) {
        try {
          const refUrl = new URL(referer);
          const refEncoded = refUrl.searchParams.get("e");
          const refTarget = refEncoded ? decodeUrlToken(refEncoded) : refUrl.searchParams.get("url");
          if (refTarget) {
            const base = new URL(refTarget);
            const nextSearch = new URLSearchParams(requestUrl.searchParams);
            nextSearch.delete("url");
            nextSearch.delete("e");
            if ([...nextSearch.keys()].length > 0) {
              base.search = nextSearch.toString();
            }
            rawUrl = base.toString();
          }
        } catch {
          // Ignore referer fallback errors.
        }
      }
    }
    if (!rawUrl) {
      const cookieBase = getProxyBaseFromCookies(request.headers.get("cookie"));
      if (cookieBase) {
        try {
          const base = new URL(cookieBase);
          const nextSearch = new URLSearchParams(requestUrl.searchParams);
          nextSearch.delete("url");
          nextSearch.delete("e");
          if ([...nextSearch.keys()].length > 0) {
            base.search = nextSearch.toString();
          }
          rawUrl = base.toString();
        } catch {
          // Ignore cookie fallback errors.
        }
      }
    }
    rawUrl = unwrapPreviewUrl(rawUrl, requestUrl.origin);
    const validation = parseAndValidateTarget(rawUrl);

    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

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
    headers.set("accept", "text/html,application/xhtml+xml");
    headers.set("accept-encoding", "identity");
    if (!headers.get("user-agent")) {
      headers.set("user-agent", "Mozilla/5.0");
    }

    const timeoutMs = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || "15000");
    const maxRetries = Math.max(0, Number(process.env.PROXY_UPSTREAM_RETRIES || "2"));
    const baseDelayMs = 200;
    let upstream;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
      try {
        upstream = await fetch(validation.url.toString(), {
          headers,
          redirect: "follow",
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (upstream.status >= 500 && attempt < maxRetries) {
          await upstream.arrayBuffer().catch(() => {});
          const delayMs = Math.min(baseDelayMs * 2 ** attempt, 1000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        break;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        if (attempt >= maxRetries) break;
        const delayMs = Math.min(baseDelayMs * 2 ** attempt, 1000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!upstream) {
      const error = lastError || new Error("Upstream fetch failed");
      throw error;
    }

    const html = await upstream.text();
    const $ = load(html);

    $("base").remove();
    $("meta[http-equiv='Content-Security-Policy']").remove();
    $("meta[http-equiv='content-security-policy']").remove();
    $("meta[http-equiv='Content-Security-Policy-Report-Only']").remove();
    $("meta[http-equiv='content-security-policy-report-only']").remove();
    const baseUrl = validation.url.toString();
    const encodeEnabled = shouldEncodeUrls();
    const proxyOriginPrefix = encodeEnabled
      ? `/api/p/e/${encodeUrlToken(validation.url.origin)}`
      : `/api/p/${validation.url.protocol.replace(":", "")}/${validation.url.host}`;
    const proxyBase = proxify(baseUrl, baseUrl);
    if (proxyBase) {
      const safeProxyBase = proxyBase.replace(/"/g, "&quot;");
      $("head").prepend(`<base href="${safeProxyBase}">`);
    }
    const encodedBase = encodeEnabled ? `e:${encodeUrlToken(baseUrl)}` : baseUrl;
    $("html").attr("data-proxy-base", encodedBase.replace(/"/g, "&quot;"));
    $("head").prepend(
      `<script data-proxy-static="1">window.__proxyBase=${JSON.stringify(encodedBase)};</script>`
    );
    if (encodeEnabled) {
      $("head").prepend('<meta name="proxy-encode" content="1">');
      $("head").prepend(
        `<script data-proxy-static="1">window.__proxyEncode=true;</script>`
      );
    }
    const nextData = $("script#__NEXT_DATA__");
    if (nextData.length) {
      try {
        const json = JSON.parse(nextData.text());
        json.assetPrefix = proxyOriginPrefix;
        nextData.text(JSON.stringify(json));
      } catch {
        // Ignore malformed __NEXT_DATA__.
      }
    }
    $("head").prepend(
      `<script src="/interceptor.js?v=${PROXY_ASSET_VERSION}" data-proxy-static="1"></script>`
    );
    const safeMetaBase = encodedBase.replace(/"/g, "&quot;");
    $("head").prepend(`<meta name="proxy-base" content="${safeMetaBase}">`);
    $("head").prepend('<meta name="referrer" content="same-origin">');

    if (isTopMode) {
      $("head").append('<meta name="proxy-top" content="1">');
      const barHtml = `
        <div class="proxy-topbar" data-proxy-static="1" data-proxy-topbar="1"
          style="position:fixed;top:12px;left:12px;right:12px;z-index:2147483647;display:grid;grid-template-columns:auto auto auto 1fr auto auto;gap:10px;align-items:center;padding:10px 12px;border-radius:14px;background:rgba(8,10,14,0.82);color:#f5f7fb;font-family:Segoe UI,Tahoma,sans-serif;box-shadow:0 18px 40px rgba(0,0,0,0.35);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.12);pointer-events:auto;">
          <span class="proxy-topbar-item" data-proxy-item="1" data-proxy-label="1" style="font-size:0.85rem;color:rgba(245,247,251,0.75);font-weight:600;letter-spacing:0.02em;text-transform:uppercase;">Proxy</span>
          <button type="button" class="proxy-topbar-item" data-proxy-item="1" data-action="back" style="appearance:none;border:none;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.12);color:#f5f7fb;font-weight:600;cursor:pointer;">Back</button>
          <button type="button" class="proxy-topbar-item" data-proxy-item="1" data-action="forward" style="appearance:none;border:none;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.12);color:#f5f7fb;font-weight:600;cursor:pointer;">Forward</button>
          <input type="text" class="proxy-topbar-item" data-proxy-item="1" data-proxy-url placeholder="Enter a URL or search"
            style="width:100%;border-radius:10px;border:1px solid rgba(255,255,255,0.18);padding:8px 10px;background:rgba(10,14,20,0.9);color:#f5f7fb;font-size:0.95rem;" />
          <button type="button" class="proxy-topbar-item" data-proxy-item="1" data-action="exit" style="appearance:none;border:none;padding:8px 12px;border-radius:10px;background:linear-gradient(135deg,#4ea8ff,#7b5bff);color:#fff;font-weight:600;cursor:pointer;">Exit</button>
          <button type="button" data-action="toggle" aria-label="Toggle bar" style="appearance:none;border:none;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.16);color:#f5f7fb;font-weight:700;cursor:pointer;">▴</button>
        </div>
      `;
      $("body").prepend(barHtml);
    }

    const rewriteTargets = [
      { selector: "link[href]", attr: "href" },
      { selector: "script[src]", attr: "src" },
      { selector: "img[src]", attr: "src" },
      { selector: "source[src]", attr: "src" },
      { selector: "video[src]", attr: "src" },
      { selector: "audio[src]", attr: "src" },
      { selector: "track[src]", attr: "src" },
      { selector: "iframe[src]", attr: "src" }
    ];

    rewriteTargets.forEach(({ selector, attr }) => {
      $(selector).each((_, element) => {
        if ($(element).attr("data-proxy-static") === "1") return;
        const value = $(element).attr(attr);
        if (value === "/interceptor.js") return;
        const rewritten = proxify(value, baseUrl);
        if (rewritten) {
          $(element).attr(attr, rewritten);
          if (rewritten !== value) {
            $(element).removeAttr("integrity");
            $(element).removeAttr("crossorigin");
          }
        }
      });
    });

    const appendTopParam = (value) => {
      if (!isTopMode || !value) return value;
      try {
        const next = new URL(value, requestUrl.origin);
        if (!next.searchParams.has("top")) {
          next.searchParams.set("top", "1");
        }
        return next.pathname + next.search + next.hash;
      } catch {
        return value.includes("?") ? `${value}&top=1` : `${value}?top=1`;
      }
    };

    $("a[href]").each((_, element) => {
      const value = $(element).attr("href");
      const rewritten = proxifyDocument(value, baseUrl);
      if (rewritten) $(element).attr("href", appendTopParam(rewritten));
    });

    $("form[action]").each((_, element) => {
      const method = ($(element).attr("method") || "get").toLowerCase();
      const value = $(element).attr("action");
      if (method === "get") return;
      const rewritten = proxify(value, baseUrl);
      if (rewritten) $(element).attr("action", rewritten);
    });

    $("iframe[src]").each((_, element) => {
      const value = $(element).attr("src");
      const rewritten = proxifyDocument(value, baseUrl);
      if (rewritten) $(element).attr("src", rewritten);
    });

    $("img[srcset], source[srcset]").each((_, element) => {
      const value = $(element).attr("srcset");
      const rewritten = rewriteSrcset(value, baseUrl);
      if (rewritten) $(element).attr("srcset", rewritten);
    });

    $("meta[http-equiv='refresh']").each((_, element) => {
      const content = $(element).attr("content");
      if (!content) return;
      const match = content.match(/^(\d+;\s*url=)(.*)$/i);
      if (!match) return;
      const rewrittenUrl = proxifyDocument(match[2], baseUrl);
      if (rewrittenUrl) {
        const nextUrl = appendTopParam(rewrittenUrl);
        $(element).attr("content", `${match[1]}${nextUrl}`);
      }
    });

    await auditLog({
      action: "preview",
      url: validation.url.toString(),
      status: upstream.status,
      ip,
      userAgent: request.headers.get("user-agent") || "unknown"
    });

    const responseHeaders = new Headers();
    responseHeaders.set("content-type", "text/html; charset=utf-8");
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-content-type-options", "nosniff");
    appendSetCookies(upstream.headers, responseHeaders);
    responseHeaders.append(
      "set-cookie",
      encodeEnabled
        ? `proxy-base=e:${encodeUrlToken(validation.url.toString())}; Path=/; SameSite=Lax`
        : `proxy-base=${encodeURIComponent(validation.url.toString())}; Path=/; SameSite=Lax`
    );
    if (encodeEnabled) {
      responseHeaders.append("set-cookie", "proxy-encode=1; Path=/; SameSite=Lax");
    }
    // Intentionally omit CSP here to avoid breaking complex sites (e.g., YouTube).

    return new Response($.html(), {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    console.error("preview route error:", error);
    return Response.json(
      { error: "Preview failed", detail: String(error?.message || error) },
      { status: 500 }
    );
  }
}
