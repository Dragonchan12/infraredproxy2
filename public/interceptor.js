(function() {
  const originalFetch = window.fetch;
  const originalXhrOpen = window.XMLHttpRequest.prototype.open;
  const PROXY_URL = '/api/p/';
  const PREVIEW_URL = '/api/preview?url=';
  const META_BASE_SELECTOR = 'meta[name="proxy-base"]';

  function shouldRewrite(value) {
    if (!value) return false;
    if (typeof value !== "string") {
      if (value instanceof URL) {
        value = value.toString();
      } else if (typeof value === "object" && typeof value.toString === "function") {
        value = value.toString();
      } else {
        return false;
      }
    }
    const trimmed = value.trim();
    if (!trimmed) return false;
    const origin = window.location.origin;
    if (
      trimmed.startsWith(origin + PROXY_URL) ||
      trimmed.startsWith(origin + "/api/p/") ||
      trimmed.startsWith(origin + PREVIEW_URL) ||
      trimmed.startsWith(origin + "/api/preview")
    ) {
      return false;
    }
    if (trimmed.startsWith("/interceptor.js")) return false;
    if (trimmed.startsWith(PROXY_URL) || trimmed.startsWith(PREVIEW_URL)) return false;
    if (trimmed.startsWith("#")) return false;
    if (/^(data:|javascript:|mailto:|tel:)/i.test(trimmed)) return false;
    return true;
  }

  function buildProxyPath(url) {
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.replace(":", "");
      const host = parsed.host;
      const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
      const base = `${PROXY_URL}${scheme}/${host}${path}`;
      return parsed.search ? `${base}${parsed.search}` : base;
    } catch {
      return "";
    }
  }

  function normalizeLocal(value, baseUrl) {
    if (typeof value !== "string") return value;
    const origin = window.location.origin;
    let isProxyContext = false;
    try {
      isProxyContext = new URL(baseUrl, origin).origin !== origin;
    } catch {
      isProxyContext = false;
    }
    if (value.startsWith(origin)) {
      try {
        const parsed = new URL(value);
        if (
          parsed.pathname.startsWith("/api/p/") ||
          parsed.pathname.startsWith("/api/preview") ||
          (!isProxyContext && parsed.pathname.startsWith("/_next/")) ||
          parsed.pathname === "/interceptor.js" ||
          parsed.pathname === "/proxy-sw.js"
        ) {
          return value;
        }
        return new URL(parsed.pathname + parsed.search + parsed.hash, baseUrl).toString();
      } catch {
        return value;
      }
    }
    if (value.startsWith("/")) {
      if (
        value.startsWith("/api/p/") ||
        value.startsWith("/api/preview") ||
        (!isProxyContext && value.startsWith("/_next/")) ||
        value === "/interceptor.js" ||
        value === "/proxy-sw.js"
      ) {
        return value;
      }
      try {
        return new URL(value, baseUrl).toString();
      } catch {
        return value;
      }
    }
    return value;
  }

  function proxify(value, baseUrl) {
    if (!shouldRewrite(value)) return value;
    const normalized = normalizeLocal(value, baseUrl);
    try {
      const resolved = new URL(normalized, baseUrl);
      if (!/^https?:$/.test(resolved.protocol)) return value;
      const path = buildProxyPath(resolved.toString());
      return path || value;
    } catch {
      return value;
    }
  }

  function proxifyDocument(value, baseUrl) {
    if (!shouldRewrite(value)) return value;
    try {
      const resolved = new URL(value, baseUrl);
      if (!/^https?:$/.test(resolved.protocol)) return value;
      return `${PREVIEW_URL}${encodeURIComponent(resolved.toString())}`;
    } catch {
      return value;
    }
  }

  function getBaseUrl() {
    if (window.__proxyBase) return window.__proxyBase;
    const meta = document.querySelector(META_BASE_SELECTOR);
    if (meta && meta.content) {
      window.__proxyBase = meta.content;
      return meta.content;
    }
    const htmlBase =
      document.documentElement && document.documentElement.getAttribute("data-proxy-base");
    if (htmlBase) {
      window.__proxyBase = htmlBase;
      return htmlBase;
    }
    return document.baseURI;
  }

  function rewriteElement(el) {
    if (!el || !el.getAttribute) return;
    const baseUrl = getBaseUrl();
    const attrList = ["src", "href", "action", "poster"];
    const tag = (el.tagName || "").toLowerCase();
    const isForm = tag === "form";
    const isAnchor = tag === "a";
    const isFrame = tag === "iframe";

    attrList.forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value) {
        const method = isForm ? (el.getAttribute("method") || "get").toLowerCase() : "get";
        const usePreview =
          (isAnchor && attr === "href") ||
          (isFrame && attr === "src") ||
          (isForm && attr === "action" && method === "get");
        const rewritten = usePreview ? proxifyDocument(value, baseUrl) : proxify(value, baseUrl);
        if (rewritten && rewritten !== value) {
          el.setAttribute(attr, rewritten);
          el.removeAttribute("integrity");
          el.removeAttribute("crossorigin");
        }
      }
    });
    if (el.getAttribute("srcset")) {
      const srcset = el.getAttribute("srcset");
      if (srcset && /(data:|blob:)/i.test(srcset)) return;
      const rewritten = srcset
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const parts = entry.split(/\s+/);
          const rewrittenUrl = proxify(parts[0], baseUrl);
          return [rewrittenUrl, ...parts.slice(1)].join(" ");
        })
        .join(", ");
      if (rewritten && rewritten !== srcset) {
        el.setAttribute("srcset", rewritten);
      }
    }
  }

  function rewriteTree(node) {
    if (!node || node.nodeType !== 1) return;
    rewriteElement(node);
    if (node.querySelectorAll) {
      node.querySelectorAll("[src],[href],[action],[poster],[srcset]").forEach((child) => rewriteElement(child));
    }
  }

  window.fetch = function(url, options) {
    const baseUrl = getBaseUrl();
    if (url instanceof Request) {
      const rewrittenUrl = proxify(normalizeLocal(url.url, baseUrl), baseUrl);
      const nextRequest = new Request(rewrittenUrl, url);
      return originalFetch.call(this, nextRequest);
    }
    const rawUrl = url instanceof URL ? url.toString() : url;
    const rewrittenUrl = proxify(normalizeLocal(rawUrl, baseUrl), baseUrl);
    return originalFetch.call(this, rewrittenUrl, options);
  };

  window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
    const baseUrl = getBaseUrl();
    const rawUrl = url instanceof URL ? url.toString() : url;
    const rewrittenUrl = proxify(normalizeLocal(rawUrl, baseUrl), baseUrl);
    return originalXhrOpen.call(this, method, rewrittenUrl, async, user, password);
  };

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/proxy-sw.js", { scope: "/" }).catch(() => {});
  }

  if (window.open) {
    const originalOpen = window.open;
    window.open = function(url, target, features) {
      const rewrittenUrl = url ? proxifyDocument(url, getBaseUrl()) : url;
      return originalOpen.call(this, rewrittenUrl, target, features);
    };
  }

  try {
    const locationProto = window.Location && window.Location.prototype;
    if (locationProto && locationProto.assign) {
      const originalAssign = locationProto.assign;
      locationProto.assign = function(url) {
        return originalAssign.call(this, proxifyDocument(url, getBaseUrl()));
      };
    }
    if (locationProto) {
      const hrefDescriptor = Object.getOwnPropertyDescriptor(locationProto, "href");
      if (hrefDescriptor && hrefDescriptor.set) {
        Object.defineProperty(locationProto, "href", {
          configurable: true,
          enumerable: true,
          get: hrefDescriptor.get,
          set: function(url) {
            return hrefDescriptor.set.call(this, proxifyDocument(url, getBaseUrl()));
          },
        });
      }
    }
    if (locationProto && locationProto.replace) {
      const originalReplace = locationProto.replace;
      locationProto.replace = function(url) {
        return originalReplace.call(this, proxifyDocument(url, getBaseUrl()));
      };
    }
  } catch {
    // Some browsers lock down Location; ignore.
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!target) return;
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = target.getAttribute("href");
      const rewritten = proxifyDocument(href, getBaseUrl());
      if (rewritten && rewritten !== href) {
        event.preventDefault();
        window.location.href = rewritten;
      }
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!form || form.tagName !== "FORM") return;
      const method = (form.getAttribute("method") || "get").toLowerCase();
      if (method !== "get") return;
      const action = form.getAttribute("action") || "";
      const targetUrl = new URL(action || getBaseUrl(), getBaseUrl());
      const data = new FormData(form);
      for (const [key, value] of data.entries()) {
        targetUrl.searchParams.set(key, String(value));
      }
      const rewritten = proxifyDocument(targetUrl.toString(), getBaseUrl());
      if (rewritten) {
        event.preventDefault();
        window.location.href = rewritten;
      }
    },
    true
  );

  let isRewriting = false;
  const observer = new MutationObserver((mutations) => {
    if (isRewriting) return;
    isRewriting = true;
    try {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes") {
          rewriteElement(mutation.target);
        } else {
          mutation.addedNodes.forEach((node) => rewriteTree(node));
        }
      });
    } finally {
      isRewriting = false;
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "action", "poster", "srcset"],
  });
})();
