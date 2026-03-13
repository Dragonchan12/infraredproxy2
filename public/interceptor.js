(function() {
  const originalFetch = window.fetch;
  const originalXhrOpen = window.XMLHttpRequest.prototype.open;
  const PROXY_URL = '/api/p/';
  const PREVIEW_URL = '/api/preview?url=';
  const PREVIEW_PARAM = 'url';
  const META_BASE_SELECTOR = 'meta[name="proxy-base"]';
  const META_ENCODE_SELECTOR = 'meta[name="proxy-encode"]';
  const PROXY_ASSET_VERSION = "2026-03-12a";
  const IS_TOP_MODE = (() => {
    try {
      const current = new URL(window.location.href);
      return current.searchParams.get("top") === "1";
    } catch {
      return false;
    }
  })();
  let lastReportedUrl = "";
  let reportTimer = null;

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

  function shouldKeepOriginalHref(el, baseUrl) {
    try {
      const base = new URL(baseUrl || window.location.href);
      const host = base.hostname.toLowerCase();
      const path = base.pathname.toLowerCase();
      if (host.endsWith("search.brave.com") && path.startsWith("/images")) {
        const attrs = [
          "data-image",
          "data-image-url",
          "data-image-src",
          "data-thumb",
          "data-full",
          "data-testid",
          "data-type",
        ];
        for (const name of attrs) {
          const value = el.getAttribute && el.getAttribute(name);
          if (value && /image|thumb|photo|result/i.test(value)) {
            return true;
          }
        }
        const className = el.getAttribute && el.getAttribute("class");
        if (className && /image|thumb|photo/i.test(className)) {
          return true;
        }
      }
    } catch {
      // Ignore heuristic errors.
    }
    return false;
  }


  function buildProxyPath(url) {
    try {
      if (isEncodeEnabled()) {
        const parsed = new URL(url);
        const token = encodeUrlToken(parsed.origin);
        const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
        const base = `${PROXY_URL}e/${token}${path}`;
        return parsed.search ? `${base}${parsed.search}` : base;
      }
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
          parsed.pathname.startsWith("/interceptor.js") ||
          parsed.pathname.startsWith("/proxy-sw.js")
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
        value.startsWith("/interceptor.js") ||
        value.startsWith("/proxy-sw.js")
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
      if (isEncodeEnabled()) {
        const previewUrl = `/api/preview?e=${encodeUrlToken(resolved.toString())}`;
        return IS_TOP_MODE ? appendTopParam(previewUrl) : previewUrl;
      }
      const previewUrl = `${PREVIEW_URL}${encodeURIComponent(resolved.toString())}`;
      return IS_TOP_MODE ? appendTopParam(previewUrl) : previewUrl;
    } catch {
      return value;
    }
  }

  function appendTopParam(previewUrl) {
    if (!IS_TOP_MODE) return previewUrl;
    try {
      const next = new URL(previewUrl, window.location.origin);
      if (!next.searchParams.has("top")) {
        next.searchParams.set("top", "1");
      }
      return next.pathname + next.search + next.hash;
    } catch {
      return previewUrl.includes("?") ? `${previewUrl}&top=1` : `${previewUrl}?top=1`;
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

  function unwrapPreviewValue(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      if (!parsed.pathname.startsWith("/api/preview")) return "";
      const encoded = parsed.searchParams.get("e");
      if (encoded) return decodeUrlToken(encoded);
      const inner = parsed.searchParams.get(PREVIEW_PARAM);
      return inner ? decodeURIComponent(inner) : "";
    } catch {
      return "";
    }
  }

  function getBaseUrl() {
    if (window.__proxyBase) {
      const base = window.__proxyBase;
      if (typeof base === "string" && base.startsWith("e:")) {
        const decoded = decodeUrlToken(base.slice(2));
        return decoded || base;
      }
      return base;
    }
    const meta = document.querySelector(META_BASE_SELECTOR);
    if (meta && meta.content) {
      window.__proxyBase = meta.content;
      if (meta.content.startsWith("e:")) {
        const decoded = decodeUrlToken(meta.content.slice(2));
        return decoded || meta.content;
      }
      return meta.content;
    }
    const htmlBase =
      document.documentElement && document.documentElement.getAttribute("data-proxy-base");
    if (htmlBase) {
      window.__proxyBase = htmlBase;
      if (htmlBase.startsWith("e:")) {
        const decoded = decodeUrlToken(htmlBase.slice(2));
        return decoded || htmlBase;
      }
      return htmlBase;
    }
    return document.baseURI;
  }

  function isEncodeEnabled() {
    if (window.__proxyEncode) return true;
    const meta = document.querySelector(META_ENCODE_SELECTOR);
    if (meta && meta.content) {
      if (meta.content === "1" || meta.content.toLowerCase() === "true") {
        window.__proxyEncode = true;
        return true;
      }
    }
    return true;
  }

  function getVirtualUrl() {
    if (window.__proxyVirtualUrl) return window.__proxyVirtualUrl;
    try {
      const current = new URL(window.location.href);
      const encoded = current.searchParams.get("e");
      if (encoded) {
        const decoded = decodeUrlToken(encoded);
        if (decoded) {
          window.__proxyVirtualUrl = decoded;
          return window.__proxyVirtualUrl;
        }
      }
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

  function shouldShowTopBar() {
    if (IS_TOP_MODE) return true;
    const meta = document.querySelector("meta[name='proxy-top']");
    if (meta && (meta.content === "1" || meta.content.toLowerCase() === "true")) {
      return true;
    }
    return false;
  }

  function ensureTopBar() {
    if (!shouldShowTopBar()) return;
    if (document.querySelector(".proxy-topbar")) return;
    const bar = document.createElement("div");
    bar.className = "proxy-topbar";
    bar.setAttribute("data-proxy-static", "1");
    bar.style.position = "fixed";
    bar.style.top = "12px";
    bar.style.left = "12px";
    bar.style.right = "12px";
    bar.style.zIndex = "2147483647";
    bar.style.display = "grid";
    bar.style.gridTemplateColumns = "auto auto auto 1fr auto auto";
    bar.style.gap = "10px";
    bar.style.alignItems = "center";
    bar.style.padding = "10px 12px";
    bar.style.borderRadius = "14px";
    bar.style.background = "rgba(8, 10, 14, 0.82)";
    bar.style.color = "#f5f7fb";
    bar.style.fontFamily = '"Segoe UI", Tahoma, sans-serif';
    bar.style.boxShadow = "0 18px 40px rgba(0, 0, 0, 0.35)";
    bar.style.backdropFilter = "blur(8px)";
    bar.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    bar.style.pointerEvents = "auto";
    bar.style.setProperty("position", "fixed", "important");
    bar.style.setProperty("top", "12px", "important");
    bar.style.setProperty("left", "12px", "important");
    bar.style.setProperty("right", "12px", "important");
    bar.style.setProperty("z-index", "2147483647", "important");
    bar.style.setProperty("display", "grid", "important");
    bar.style.setProperty("pointer-events", "auto", "important");
    bar.style.setProperty("visibility", "visible", "important");
    bar.style.setProperty("opacity", "1", "important");

    const makeButton = (label, className) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.className = className;
      btn.style.appearance = "none";
      btn.style.border = "none";
      btn.style.padding = "8px 12px";
      btn.style.borderRadius = "10px";
      btn.style.fontWeight = "600";
      btn.style.cursor = "pointer";
      if (className.includes("secondary")) {
        btn.style.background = "rgba(255, 255, 255, 0.12)";
        btn.style.color = "#f5f7fb";
      } else if (className.includes("toggle")) {
        btn.style.background = "rgba(255, 255, 255, 0.16)";
        btn.style.color = "#f5f7fb";
        btn.style.fontWeight = "700";
      } else {
        btn.style.background = "linear-gradient(135deg, #4ea8ff, #7b5bff)";
        btn.style.color = "#fff";
      }
      return btn;
    };

    const label = document.createElement("span");
    label.textContent = "Proxy";
    label.style.fontSize = "0.85rem";
    label.style.color = "rgba(245, 247, 251, 0.75)";
    label.style.fontWeight = "600";
    label.style.letterSpacing = "0.02em";
    label.style.textTransform = "uppercase";

    const backBtn = makeButton("Back", "secondary");
    const forwardBtn = makeButton("Forward", "secondary");

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter a URL or search";
    input.style.width = "100%";
    input.style.borderRadius = "10px";
    input.style.border = "1px solid rgba(255, 255, 255, 0.18)";
    input.style.padding = "8px 10px";
    input.style.background = "rgba(10, 14, 20, 0.9)";
    input.style.color = "#f5f7fb";
    input.style.fontSize = "0.95rem";

    const exitBtn = makeButton("Exit", "");
    const toggleBtn = makeButton("▴", "toggle");

    const items = [label, backBtn, forwardBtn, input, exitBtn];
    items.forEach((el) => el.setAttribute("data-proxy-item", "1"));

    bar.append(label, backBtn, forwardBtn, input, exitBtn, toggleBtn);

    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const stopBarOnly = (event) => {
      if (event.target !== bar) return;
      event.preventDefault();
      event.stopPropagation();
    };
    bar.addEventListener("click", stopBarOnly, true);
    bar.addEventListener("mousedown", stopBarOnly, true);

    const setCollapsed = (next) => {
      bar.dataset.collapsed = next ? "1" : "0";
      if (next) {
        bar.style.right = "auto";
        bar.style.width = "fit-content";
        bar.style.padding = "6px 10px";
        bar.style.gridTemplateColumns = "auto";
        bar.style.setProperty("right", "auto", "important");
        bar.style.setProperty("width", "fit-content", "important");
        bar.style.setProperty("padding", "6px 10px", "important");
        bar.style.setProperty("grid-template-columns", "auto", "important");
        items.forEach((el) => {
          el.style.display = "none";
        });
      } else {
        bar.style.right = "12px";
        bar.style.width = "auto";
        bar.style.padding = "10px 12px";
        bar.style.gridTemplateColumns = "auto auto auto 1fr auto auto";
        bar.style.setProperty("right", "12px", "important");
        bar.style.setProperty("width", "auto", "important");
        bar.style.setProperty("padding", "10px 12px", "important");
        bar.style.setProperty("grid-template-columns", "auto auto auto 1fr auto auto", "important");
        items.forEach((el) => {
          el.style.display = "";
        });
      }
      toggleBtn.textContent = next ? "▾" : "▴";
      try {
        localStorage.setItem("proxy-topbar-collapsed", next ? "1" : "0");
      } catch {}
    };

    let initialCollapsed = false;
    try {
      initialCollapsed = localStorage.getItem("proxy-topbar-collapsed") === "1";
    } catch {}
    setCollapsed(initialCollapsed);

    toggleBtn.addEventListener(
      "click",
      (event) => {
        stop(event);
        setCollapsed(bar.dataset.collapsed !== "1");
      },
      true
    );
    backBtn.addEventListener(
      "click",
      (event) => {
        stop(event);
        history.back();
      },
      true
    );
    forwardBtn.addEventListener(
      "click",
      (event) => {
        stop(event);
        history.forward();
      },
      true
    );
    exitBtn.addEventListener(
      "click",
      (event) => {
        stop(event);
        if (history.length > 1) {
          history.back();
          return;
        }
        window.location.href = "/";
      },
      true
    );

    const looksLikeHost = (value) => {
      if (!value) return false;
      if (value.includes(" ")) return false;
      if (value === "localhost") return true;
      if (/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(value)) return true;
      return value.includes(".");
    };
    const normalizeInput = (value) => {
      if (!value) return "";
      const trimmed = value.trim();
      if (!trimmed) return "";
      if (/^https?:\\/\\//i.test(trimmed)) return trimmed;
      if (looksLikeHost(trimmed)) return `https://${trimmed}`;
      return `https://search.brave.com/search?q=${encodeURIComponent(trimmed)}&source=web`;
    };
    const buildPreview = (url) => {
      if (!url) return "";
      const token = encodeUrlToken(url);
      if (token) return `/api/preview?e=${token}&top=1`;
      return `/api/preview?url=${encodeURIComponent(url)}&top=1`;
    };

    let isEditing = false;
    const getVirtualFromLocation = () => {
      try {
        const current = new URL(window.location.href);
        if (current.pathname.startsWith("/api/preview")) {
          const encoded = current.searchParams.get("e");
          if (encoded) return decodeUrlToken(encoded);
          const inner = current.searchParams.get("url");
          return inner ? decodeURIComponent(inner) : "";
        }
      } catch {}
      return "";
    };
    const updateInput = () => {
      if (isEditing) return;
      const next = getVirtualUrl() || getVirtualFromLocation() || getBaseUrl();
      if (next && input.value !== next) {
        input.value = next;
      }
    };
    updateInput();
    setInterval(updateInput, 500);

    input.addEventListener("focus", () => {
      isEditing = true;
    });
    input.addEventListener("blur", () => {
      isEditing = false;
      updateInput();
    });
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter") return;
        stop(event);
        const next = normalizeInput(input.value);
        if (!next) return;
        const preview = buildPreview(next);
        if (preview) window.location.href = preview;
      },
      true
    );

    if (document.body) {
      document.body.appendChild(bar);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        if (!document.body) return;
        if (!document.querySelector(".proxy-topbar")) {
          document.body.appendChild(bar);
        }
      });
    }
  }

  function setVirtualUrl(nextUrl) {
    if (typeof nextUrl === "string" && nextUrl) {
      window.__proxyVirtualUrl = nextUrl;
      reportUrlChange(nextUrl);
    }
  }

  function reportUrlChange(nextUrl) {
    if (!nextUrl || nextUrl === lastReportedUrl) return;
    lastReportedUrl = nextUrl;
    if (!window.parent || window.parent === window) return;
    if (reportTimer) {
      clearTimeout(reportTimer);
    }
    reportTimer = setTimeout(() => {
      try {
        window.parent.postMessage(
          { type: "proxy:url-change", url: nextUrl },
          window.location.origin
        );
      } catch {
        // Ignore postMessage errors.
      }
    }, 50);
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
        if (isAnchor && attr === "href" && shouldKeepOriginalHref(el, baseUrl)) {
          el.setAttribute("data-proxy-keep-href", "1");
          return;
        }
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
    navigator.serviceWorker
      .register(`/proxy-sw.js?v=${PROXY_ASSET_VERSION}`, { scope: "/" })
      .catch(() => {});
  }

  ensureTopBar();
  if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", ensureTopBar);
    window.addEventListener("load", ensureTopBar);
    setInterval(() => {
      if (!shouldShowTopBar()) return;
      if (!document.querySelector(".proxy-topbar")) {
        ensureTopBar();
      }
    }, 1000);
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
    if (locationProto && locationProto.replace) {
      const originalReplace = locationProto.replace;
      locationProto.replace = function(url) {
        const nextVirtual = resolveVirtualUrl(url);
        if (nextVirtual) setVirtualUrl(nextVirtual);
        return originalReplace.call(this, proxifyDocument(url, getBaseUrl()));
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

  function patchUrlProperty(proto, prop, mode) {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function(value) {
        const baseUrl = getBaseUrl();
        const next =
          mode === "document"
            ? proxifyDocument(value, baseUrl)
            : proxify(value, baseUrl);
        return descriptor.set.call(this, next);
      }
    });
  }

  try {
    patchUrlProperty(window.HTMLScriptElement && window.HTMLScriptElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLLinkElement && window.HTMLLinkElement.prototype, "href", "asset");
    patchUrlProperty(window.HTMLImageElement && window.HTMLImageElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, "src", "document");
    patchUrlProperty(window.HTMLSourceElement && window.HTMLSourceElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLVideoElement && window.HTMLVideoElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLAudioElement && window.HTMLAudioElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLTrackElement && window.HTMLTrackElement.prototype, "src", "asset");
    patchUrlProperty(window.HTMLAnchorElement && window.HTMLAnchorElement.prototype, "href", "document");
  } catch {
    // Ignore URL property patches.
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
      if (target.getAttribute("data-proxy-keep-href") === "1") return;
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
        target.setAttribute("href", rewritten);
      }
    },
    false
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
    false
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

  reportUrlChange(getVirtualUrl());
})();
