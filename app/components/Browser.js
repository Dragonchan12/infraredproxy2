"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function Tab({ title, onSelect, onClose, isActive }) {
  return (
    <div className={`tab ${isActive ? "active" : ""}`}>
      <button type="button" className="tab-select" onClick={onSelect}>
        {title}
      </button>
      <button type="button" className="tab-close" onClick={onClose}>
        &times;
      </button>
    </div>
  );
}

const DEFAULT_HOME = "https://search.brave.com/";
const STORAGE_KEY = "proxy-browser-state-v1";
const SETTINGS_KEY = "proxy-browser-settings-v1";
const HISTORY_KEY = "proxy-browser-history-v1";
const MAX_HISTORY_ENTRIES = 200;

function makeSearchUrl(query) {
  return `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
}

function isIpAddress(input) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(input);
}

function looksLikeHost(input) {
  if (!input) return false;
  if (input.includes(" ")) return false;
  if (input === "localhost") return true;
  if (isIpAddress(input)) return true;
  return input.includes(".");
}

function normalizeInput(value) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (looksLikeHost(trimmed)) {
    return `https://${trimmed}`;
  }
  return makeSearchUrl(trimmed);
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

function buildInitialTabs() {
  return [
    {
      id: 1,
      title: "search.brave.com",
      url: DEFAULT_HOME,
      iframeUrl: DEFAULT_HOME,
      history: [DEFAULT_HOME],
      historyIndex: 0,
      reloadNonce: 0,
    },
  ];
}

export default function Browser({ whitelistEnabled, encodeEnabled }) {
  const [tabs, setTabs] = useState(buildInitialTabs);
  const [activeTabId, setActiveTabId] = useState(1);
  const nextIdRef = useRef(2);
  const [input, setInput] = useState(DEFAULT_HOME);
  const iframeRefs = useRef(new Map());
  const [historyItems, setHistoryItems] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [branding, setBranding] = useState({
    iconUrl: "",
    title: "Controlled Proxy",
    hideAddress: true,
  });
  const [addressFocused, setAddressFocused] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId]
  );

  const getIframeSrc = useCallback(
    (url) => {
      if (!url) return "";
      if (encodeEnabled) {
        const token = encodeUrlToken(url);
        if (token) return `/api/preview?e=${token}`;
      }
      return `/api/preview?url=${encodeURIComponent(url)}`;
    },
    [encodeEnabled]
  );

  const getPreviewHref = useCallback(
    (url) => {
      if (!url) return "";
      if (encodeEnabled) {
        const token = encodeUrlToken(url);
        if (token) return `/api/preview?e=${token}`;
      }
      return `/api/preview?url=${encodeURIComponent(url)}`;
    },
    [encodeEnabled]
  );

  const getTabTitle = useCallback((url) => {
    if (!url) return "New Tab";
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./i, "");
    } catch {
      return url;
    }
  }, []);

  const addHistoryEntry = useCallback(
    (url, title) => {
      if (!url) return;
      const nextTitle = title || getTabTitle(url);
      setHistoryItems((prev) => {
        if (prev[0]?.url === url) {
          if (prev[0]?.title === nextTitle) return prev;
          const updated = [
            { ...prev[0], title: nextTitle, ts: Date.now() },
            ...prev.slice(1),
          ];
          return updated;
        }
        const next = [{ url, title: nextTitle, ts: Date.now() }, ...prev];
        return next.slice(0, MAX_HISTORY_ENTRIES);
      });
    },
    [getTabTitle]
  );

  const updateTabHistory = useCallback((tab, nextUrl) => {
    if (!nextUrl) return tab;
    const history = Array.isArray(tab.history) ? tab.history : [];
    const index = Number.isFinite(tab.historyIndex)
      ? tab.historyIndex
      : history.length - 1;
    const safeIndex = Math.max(0, Math.min(index, Math.max(history.length - 1, 0)));
    if (history[safeIndex] === nextUrl) {
      return { ...tab, history, historyIndex: safeIndex };
    }
    const trimmed = history.slice(0, safeIndex + 1);
    trimmed.push(nextUrl);
    return {
      ...tab,
      history: trimmed,
      historyIndex: trimmed.length - 1,
    };
  }, []);

  const openTabWithUrl = useCallback(
    (url) => {
      const nextId = nextIdRef.current++;
      let finalUrl = url;
      try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.pathname.startsWith("/api/preview")) {
          const encoded = parsed.searchParams.get("e");
          if (encoded) {
            const decoded = decodeUrlToken(encoded);
            if (decoded) finalUrl = decoded;
          } else {
            const inner = parsed.searchParams.get("url");
            if (inner) finalUrl = decodeURIComponent(inner);
          }
        }
      } catch {
        // Ignore invalid URLs.
      }
      const title = getTabTitle(finalUrl);
      const newTab = {
        id: nextId,
        title,
        url: finalUrl,
        iframeUrl: finalUrl,
        history: finalUrl ? [finalUrl] : [],
        historyIndex: finalUrl ? 0 : -1,
        reloadNonce: 0,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(nextId);
      setInput(finalUrl);
      addHistoryEntry(finalUrl, title);
    },
    [getTabTitle, addHistoryEntry]
  );

  const handleNewTab = () => {
    openTabWithUrl(DEFAULT_HOME);
  };

  const handleCloseTab = (id) => {
    if (tabs.length === 1) {
      setTabs(buildInitialTabs());
      setActiveTabId(1);
      nextIdRef.current = 2;
      setInput(DEFAULT_HOME);
      return;
    }

    const newTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(newTabs);

    if (activeTabId === id) {
      const newActiveTab = newTabs[newTabs.length - 1];
      setActiveTabId(newActiveTab.id);
      setInput(newActiveTab.url);
    }
  };

  const handleSelectTab = (id) => {
    setActiveTabId(id);
    const selectedTab = tabs.find((tab) => tab.id === id);
    setInput(selectedTab?.url || "");
  };

  const handleOpen = () => {
    const normalized = normalizeInput(input);
    if (!normalized) return;
    const newTabs = tabs.map((tab) => {
      if (tab.id === activeTabId) {
        const updated = {
          ...tab,
          url: normalized,
          iframeUrl: normalized,
          title: getTabTitle(normalized),
        };
        return updateTabHistory(updated, normalized);
      }
      return tab;
    });
    setTabs(newTabs);
    addHistoryEntry(normalized, getTabTitle(normalized));
  };

  const handleReset = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
    } catch {
      // Ignore SW unregister errors.
    }
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch {
      // Ignore cache cleanup errors.
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Ignore storage errors.
    }
    try {
      document.cookie = "proxy-base=; Path=/; Max-Age=0; SameSite=Lax";
    } catch {
      // Ignore cookie errors.
    }
    window.location.reload();
  };

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "proxy:new-tab") {
        const url = typeof data.url === "string" && data.url ? data.url : DEFAULT_HOME;
        let shouldReuse = false;
        try {
          if (activeTab && activeTab.url) {
            const nextHost = new URL(url).hostname;
            const currentHost = new URL(activeTab.url).hostname;
            shouldReuse = nextHost === currentHost;
          }
        } catch {
          shouldReuse = false;
        }
        if (shouldReuse && activeTab) {
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeTab.id) return tab;
              const updated = {
                ...tab,
                url,
                iframeUrl: url,
                title: getTabTitle(url),
              };
              return updateTabHistory(updated, url);
            })
          );
          setInput(url);
          addHistoryEntry(url, getTabTitle(url));
          return;
        }
        openTabWithUrl(url);
        return;
      }
      if (data.type === "proxy:url-change") {
        const url = typeof data.url === "string" && data.url ? data.url : "";
        if (!url) return;
        let targetId = null;
        for (const [id, frame] of iframeRefs.current.entries()) {
          if (frame && frame.contentWindow === event.source) {
            targetId = id;
            break;
          }
        }
        if (!targetId) return;
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== targetId) return tab;
            const updated = { ...tab, url, title: getTabTitle(url) };
            return updateTabHistory(updated, url);
          })
        );
        if (targetId === activeTabId) {
          setInput(url);
        }
        addHistoryEntry(url, getTabTitle(url));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openTabWithUrl, getTabTitle, activeTabId, updateTabHistory, addHistoryEntry, getPreviewHref]);

  const handleBack = () => {
    const current = activeTab;
    if (!current || !current.history || current.historyIndex <= 0) return;
    const nextIndex = current.historyIndex - 1;
    const nextUrl = current.history[nextIndex];
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === current.id
          ? {
              ...tab,
              url: nextUrl,
              iframeUrl: nextUrl,
              title: getTabTitle(nextUrl),
              historyIndex: nextIndex,
            }
          : tab
      )
    );
    setInput(nextUrl);
  };

  const handleForward = () => {
    const current = activeTab;
    if (!current || !current.history) return;
    if (current.historyIndex >= current.history.length - 1) return;
    const nextIndex = current.historyIndex + 1;
    const nextUrl = current.history[nextIndex];
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === current.id
          ? {
              ...tab,
              url: nextUrl,
              iframeUrl: nextUrl,
              title: getTabTitle(nextUrl),
              historyIndex: nextIndex,
            }
          : tab
      )
    );
    setInput(nextUrl);
  };

  const handleRefresh = () => {
    const current = activeTab;
    if (!current) return;
    const frame = iframeRefs.current.get(current.id);
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.location.reload();
        return;
      } catch {
        // Fall through to reload via key.
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === current.id
          ? { ...tab, reloadNonce: (tab.reloadNonce || 0) + 1 }
          : tab
      )
    );
  };

  const handleOpenHistoryEntry = (entryUrl) => {
    if (!entryUrl) return;
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== activeTabId) return tab;
        const updated = {
          ...tab,
          url: entryUrl,
          iframeUrl: entryUrl,
          title: getTabTitle(entryUrl),
        };
        return updateTabHistory(updated, entryUrl);
      })
    );
    setInput(entryUrl);
  };

  const clearHistory = () => {
    setHistoryItems([]);
  };

  const canGoBack = Boolean(activeTab && activeTab.historyIndex > 0);
  const canGoForward = Boolean(
    activeTab &&
      activeTab.history &&
      activeTab.historyIndex < activeTab.history.length - 1
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const loadedTabs =
          Array.isArray(parsed.tabs) && parsed.tabs.length ? parsed.tabs : null;
        if (loadedTabs) {
          setTabs(loadedTabs);
          const nextId =
            loadedTabs.reduce((max, tab) => Math.max(max, tab.id || 0), 0) + 1;
          nextIdRef.current = nextId;
          const desiredId =
            typeof parsed.activeTabId === "number"
              ? parsed.activeTabId
              : loadedTabs[0].id;
          const activeExists = loadedTabs.some((tab) => tab.id === desiredId);
          const finalId = activeExists ? desiredId : loadedTabs[0].id;
          setActiveTabId(finalId);
          const active = loadedTabs.find((tab) => tab.id === finalId);
          if (active && active.url) {
            setInput(active.url);
          } else if (typeof parsed.input === "string") {
            setInput(parsed.input);
          }
        } else if (typeof parsed.input === "string") {
          setInput(parsed.input);
        }
      }
    } catch {
      // Ignore storage errors.
    }
    try {
      const rawHistory = localStorage.getItem(HISTORY_KEY);
      if (rawHistory) {
        const parsedHistory = JSON.parse(rawHistory);
        if (Array.isArray(parsedHistory)) {
          setHistoryItems(parsedHistory);
        }
      }
    } catch {
      // Ignore history load errors.
    }
    try {
      const rawSettings = localStorage.getItem(SETTINGS_KEY);
      if (rawSettings) {
        const parsedSettings = JSON.parse(rawSettings);
        if (parsedSettings && typeof parsedSettings === "object") {
          setBranding((prev) => ({
            iconUrl:
              typeof parsedSettings.iconUrl === "string"
                ? parsedSettings.iconUrl
                : prev.iconUrl,
            title:
              typeof parsedSettings.title === "string"
                ? parsedSettings.title
                : prev.title,
            hideAddress:
              typeof parsedSettings.hideAddress === "boolean"
                ? parsedSettings.hideAddress
                : prev.hideAddress,
          }));
        }
      }
    } catch {
      // Ignore settings load errors.
    }
  }, []);

  useEffect(() => {
    try {
      const payload = {
        tabs,
        activeTabId,
        input,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage errors.
    }
  }, [tabs, activeTabId, input]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems));
    } catch {
      // Ignore storage errors.
    }
  }, [historyItems]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(branding));
    } catch {
      // Ignore storage errors.
    }
  }, [branding]);

  useEffect(() => {
    if (!branding.iconUrl) return;
    try {
      let link = document.querySelector("link[rel='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = branding.iconUrl;
    } catch {
      // Ignore favicon updates.
    }
  }, [branding.iconUrl]);

  const addressValue =
    branding.hideAddress && !addressFocused ? "" : input;

  return (
    <div className="browser-shell">
      <header className="browser-top">
        <div className="tabs-bar">
          <div className="brand">
            {branding.iconUrl ? (
              <img src={branding.iconUrl} alt="" className="brand-icon" />
            ) : (
              <div className="brand-icon placeholder">CP</div>
            )}
            <span className="brand-title">{branding.title || "Controlled Proxy"}</span>
          </div>
          <div className="tabs-scroll">
            {tabs.map((tab) => (
              <Tab
                key={tab.id}
                title={tab.title}
                onSelect={() => handleSelectTab(tab.id)}
                onClose={() => handleCloseTab(tab.id)}
                isActive={tab.id === activeTabId}
              />
            ))}
          </div>
          <button type="button" className="new-tab" onClick={handleNewTab} aria-label="New tab">
            +
          </button>
        </div>
        <div className="panel controls">
          <div className="controls-row">
            <div className="nav-buttons">
              <button type="button" className="tool-button" onClick={handleBack} disabled={!canGoBack}>
                Back
              </button>
              <button type="button" className="tool-button" onClick={handleForward} disabled={!canGoForward}>
                Forward
              </button>
              <button type="button" className="tool-button" onClick={handleRefresh}>
                Refresh
              </button>
            </div>
            <input
              id="target"
              type="text"
              placeholder="Enter a URL or search with Brave"
              value={addressValue}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleOpen();
              }}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
            />
            <div className="controls-actions">
              <button type="button" onClick={handleOpen}>
                Go
              </button>
              <button type="button" className="ghost" onClick={() => setShowHistory((prev) => !prev)}>
                History
              </button>
              <button type="button" className="ghost" onClick={() => setShowSettings((prev) => !prev)}>
                Settings
              </button>
              <button type="button" className="reset" onClick={handleReset}>
                Reset
              </button>
            </div>
          </div>
        </div>
        {showSettings && (
          <div className="panel settings-panel">
            <div className="settings-grid">
              <label htmlFor="brandTitle">Header text</label>
              <input
                id="brandTitle"
                type="text"
                value={branding.title}
                onChange={(event) => setBranding((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Controlled Proxy"
              />
              <label htmlFor="brandIcon">Favicon URL</label>
              <input
                id="brandIcon"
                type="text"
                value={branding.iconUrl}
                onChange={(event) => setBranding((prev) => ({ ...prev, iconUrl: event.target.value }))}
                placeholder="https://example.com/icon.png"
              />
              <label htmlFor="hideAddress">Hide address bar</label>
              <div className="settings-toggle">
                <input
                  id="hideAddress"
                  type="checkbox"
                  checked={branding.hideAddress}
                  onChange={(event) =>
                    setBranding((prev) => ({ ...prev, hideAddress: event.target.checked }))
                  }
                />
                <span>Mask current site info until focused</span>
              </div>
            </div>
          </div>
        )}
        {showHistory && (
          <div className="panel history-panel">
            <div className="history-header">
              <strong>History</strong>
              <button type="button" className="ghost" onClick={clearHistory}>
                Clear
              </button>
            </div>
            <div className="history-list">
              {!historyItems.length && (
                <div className="history-empty">No history yet.</div>
              )}
              {historyItems.map((entry) => (
                <button
                  type="button"
                  key={`${entry.ts}-${entry.url}`}
                  className="history-item"
                  onClick={() => handleOpenHistoryEntry(entry.url)}
                >
                  <span className="history-title">{entry.title}</span>
                  <span className="history-url">{entry.url}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>
      <section className="viewer">
        {tabs.map((tab) => {
          const src = getIframeSrc(tab.iframeUrl);
          if (!src) return null;
          return (
            <iframe
              key={`${tab.id}:${tab.reloadNonce || 0}`}
              title={`Proxy preview ${tab.title}`}
              src={src}
              className={tab.id === activeTabId ? "" : "hidden"}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              ref={(node) => {
                if (node) {
                  iframeRefs.current.set(tab.id, node);
                } else {
                  iframeRefs.current.delete(tab.id);
                }
              }}
            />
          );
        })}
        {!tabs.length && <div className="panel empty-state">Enter an allowlisted URL to begin.</div>}
      </section>
    </div>
  );
}
