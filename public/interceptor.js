(function() {
  const originalFetch = window.fetch;
  const originalXhrOpen = window.XMLHttpRequest.prototype.open;
  const PROXY_URL = '/api/p/';
  const PREVIEW_URL = '/api/preview?url=';
  const PREVIEW_PARAM = 'url';
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
    try {
      const parsed = new URL(trimmed, origin);
      if (
        parsed.pathname.startsWith("/api/preview") ||
        parsed.pathname.startsWith("/api/p/")
      ) {
        return false;
      }
    } catch {
      // Ignore URL parsing for non-URL strings.
    }
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

  function unwrapPreviewValue(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      if (!parsed.pathname.startsWith("/api/preview")) return "";
      const inner = parsed.searchParams.get(PREVIEW_PARAM);
      return inner ? decodeURIComponent(inner) : "";
    } catch {
      return "";
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

  function getVirtualUrl() {
    if (window.__proxyVirtualUrl) return window.__proxyVirtualUrl;
    try {
      const current = new URL(window.location.href);
      const inner = current.searchParams.get(PREVIEW_PARAM);
      if (inner) {
        window.__proxyVirtualUrl = decodeURIComponent(inner);
        return window.__proxyVirtualUrl;
      }
    } catch {
      // Ignore URL parsing errors.
    }
    const base = getBaseUrl();
    if (base) {
      window.__proxyVirtualUrl = base;
      return base;
    }
    return "";
  }

  function setVirtualUrl(nextUrl) {
    if (typeof nextUrl === "string" && nextUrl) {
      window.__proxyVirtualUrl = nextUrl;
    }
  }

  function resolveVirtualUrl(value) {
    if (!value) return "";
    const raw = value instanceof URL ? value.toString() : String(value);
    if (/^(data:|javascript:|mailto:|tel:)/i.test(raw)) return "";
    const unwrapped = unwrapPreviewValue(raw);
    const base = getVirtualUrl() || getBaseUrl();
    try {
      return new URL(unwrapped || raw, base).toString();
    } catch {
      return "";
    }
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
        if (isForm && attr === "action" && method === "get") return;
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

  try {
    const historyProto = window.history;
    if (historyProto && historyProto.pushState) {
      const originalPushState = historyProto.pushState.bind(historyProto);
      historyProto.pushState = function(state, title, url) {
        if (typeof url !== "undefined" && url !== null) {
          const nextVirtual = resolveVirtualUrl(url);
          if (nextVirtual) setVirtualUrl(nextVirtual);
          return originalPushState(state, title, window.location.href);
        }
        return originalPushState(state, title, url);
      };
    }
    if (historyProto && historyProto.replaceState) {
      const originalReplaceState = historyProto.replaceState.bind(historyProto);
      historyProto.replaceState = function(state, title, url) {
        if (typeof url !== "undefined" && url !== null) {
          const nextVirtual = resolveVirtualUrl(url);
          if (nextVirtual) setVirtualUrl(nextVirtual);
          return originalReplaceState(state, title, window.location.href);
        }
        return originalReplaceState(state, title, url);
      };
    }
  } catch {
    // Ignore history overrides.
  }

  if (window.open) {
    const originalOpen = window.open;
    window.open = function(url, target, features) {
      const resolved = url ? resolveVirtualUrl(url) : "";
      const rewrittenUrl = url ? proxifyDocument(url, getBaseUrl()) : url;
      if (window.parent && window.parent !== window) {
        try {
          window.parent.postMessage(
            { type: "proxy:new-tab", url: resolved || url },
            window.location.origin
          );
          return null;
        } catch {
          // Fall back to real window open.
        }
      }
      return originalOpen.call(this, rewrittenUrl, target, features);
    };
  }

  try {
    const locationProto = window.Location && window.Location.prototype;
    if (locationProto && locationProto.assign) {
      const originalAssign = locationProto.assign;
      locationProto.assign = function(url) {
        const nextVirtual = resolveVirtualUrl(url);
        if (nextVirtual) setVirtualUrl(nextVirtual);
        return originalAssign.call(this, proxifyDocument(url, getBaseUrl()));
      };
    }
    if (locationProto) {
      const hrefDescriptor = Object.getOwnPropertyDescriptor(locationProto, "href");
      if (hrefDescriptor && hrefDescriptor.get && hrefDescriptor.set) {
        Object.defineProperty(locationProto, "href", {
          configurable: true,
          enumerable: true,
          get: function() {
            return getVirtualUrl() || hrefDescriptor.get.call(this);
          },
          set: function(url) {
            const nextVirtual = resolveVirtualUrl(url);
            if (nextVirtual) setVirtualUrl(nextVirtual);
            return hrefDescriptor.set.call(this, proxifyDocument(url, getBaseUrl()));
          },
        });
      }
      const virtualProps = ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"];
      virtualProps.forEach((prop) => {
        const descriptor = Object.getOwnPropertyDescriptor(locationProto, prop);
        if (!descriptor || !descriptor.get) return;
        Object.defineProperty(locationProto, prop, {
          configurable: true,
          enumerable: true,
          get: function() {
            const virtual = getVirtualUrl();
            if (!virtual) return descriptor.get.call(this);
            try {
              const parsed = new URL(virtual);
              return parsed[prop];
            } catch {
              return descriptor.get.call(this);
            }
          },
          set: descriptor.set
            ? function(url) {
                const nextVirtual = resolveVirtualUrl(url);
                if (nextVirtual) setVirtualUrl(nextVirtual);
                return descriptor.set.call(this, proxifyDocument(url, getBaseUrl()));
              }
            : undefined,
        });
      });
    }
    if (locationProto && locationProto.replace) {
      const originalReplace = locationProto.replace;
      locationProto.replace = function(url) {
        const nextVirtual = resolveVirtualUrl(url);
        if (nextVirtual) setVirtualUrl(nextVirtual);
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
      const isNewTabRequest =
        target.getAttribute("target") === "_blank" ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey;
      const href = target.getAttribute("href");
      const rewritten = proxifyDocument(href, getBaseUrl());
      const resolved = resolveVirtualUrl(href);
      if (isNewTabRequest && rewritten) {
        event.preventDefault();
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: "proxy:new-tab", url: resolved || href },
            window.location.origin
          );
        }
        return;
      }
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
      let action = form.getAttribute("action") || "";
      const unwrapped = unwrapPreviewValue(action);
      if (unwrapped) action = unwrapped;
      const targetUrl = new URL(action || getBaseUrl(), getBaseUrl());
      const data = new FormData(form);
      for (const [key, value] of data.entries()) {
        targetUrl.searchParams.set(key, String(value));
      }
      const rewritten = proxifyDocument(targetUrl.toString(), getBaseUrl());
      if (rewritten) {
        setVirtualUrl(targetUrl.toString());
        event.preventDefault();
        window.location.href = rewritten;
      }
    },
    true
  );

  try {
    const formProto = window.HTMLFormElement && window.HTMLFormElement.prototype;
    if (formProto && formProto.submit) {
      const originalSubmit = formProto.submit;
      formProto.submit = function() {
        try {
          const method = (this.getAttribute("method") || "get").toLowerCase();
          if (method === "get") {
            let action = this.getAttribute("action") || "";
            const unwrapped = unwrapPreviewValue(action);
            if (unwrapped) action = unwrapped;
            const targetUrl = new URL(action || getBaseUrl(), getBaseUrl());
            const data = new FormData(this);
            for (const [key, value] of data.entries()) {
              targetUrl.searchParams.set(key, String(value));
            }
            const rewritten = proxifyDocument(targetUrl.toString(), getBaseUrl());
            if (rewritten) {
              setVirtualUrl(targetUrl.toString());
              window.location.href = rewritten;
              return;
            }
          }
        } catch {
          // Fall through to native submit.
        }
        return originalSubmit.call(this);
      };
    }
  } catch {
    // Ignore form submit overrides.
  }

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
