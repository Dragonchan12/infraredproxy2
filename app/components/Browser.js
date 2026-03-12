"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function Tab({ title, onSelect, onClose, isActive }) {
  return (
    <div className={`tab ${isActive ? 'active' : ''}`}>
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

export default function Browser({ whitelistEnabled }) {
  const [tabs, setTabs] = useState([
    { id: 1, title: "search.brave.com", url: DEFAULT_HOME },
  ]);
  const [activeTabId, setActiveTabId] = useState(1);
  const nextIdRef = useRef(2);
  const [input, setInput] = useState(DEFAULT_HOME);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const getIframeSrc = useCallback((url) => {
    if (!url) return "";
    return `/api/preview?url=${encodeURIComponent(url)}`;
  }, []);

  const getTabTitle = useCallback((url) => {
    if (!url) return "New Tab";
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./i, "");
    } catch {
      return url;
    }
  }, []);

  const openTabWithUrl = useCallback((url) => {
    const nextId = nextIdRef.current++;
    let finalUrl = url;
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.pathname.startsWith("/api/preview")) {
        const inner = parsed.searchParams.get("url");
        if (inner) finalUrl = decodeURIComponent(inner);
      }
    } catch {
      // Ignore invalid URLs.
    }
    const title = getTabTitle(finalUrl);
    const newTab = { id: nextId, title, url: finalUrl };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(nextId);
    setInput(finalUrl);
  }, [getTabTitle]);

  const handleNewTab = () => {
    openTabWithUrl(DEFAULT_HOME);
  };

  const handleCloseTab = (id) => {
    if (tabs.length === 1) {
      setTabs([{ id: 1, title: "search.brave.com", url: DEFAULT_HOME }]);
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
        return { ...tab, url: normalized, title: getTabTitle(normalized) };
      }
      return tab;
    });
    setTabs(newTabs);
  };

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== "proxy:new-tab") return;
      const url = typeof data.url === "string" && data.url ? data.url : DEFAULT_HOME;
      openTabWithUrl(url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openTabWithUrl]);

  return (
    <div className="browser-shell">
      <header className="browser-top">
        <div className="tabs">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              title={tab.title}
              onSelect={() => handleSelectTab(tab.id)}
              onClose={() => handleCloseTab(tab.id)}
              isActive={tab.id === activeTabId}
            />
          ))}
          <button type="button" className="new-tab" onClick={handleNewTab} aria-label="New tab">
            +
          </button>
        </div>
        <div className="panel controls">
          <div className="controls-row">
            <input
              id="target"
              type="text"
              placeholder="Enter a URL or search with Brave"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleOpen();
              }}
            />
            <button type="button" onClick={handleOpen}>
              Go
            </button>
          </div>
        </div>
      </header>
      <section className="viewer">
        {tabs.map((tab) => {
          const src = getIframeSrc(tab.url);
          if (!src) return null;
          return (
            <iframe
              key={tab.id}
              title={`Proxy preview ${tab.title}`}
              src={src}
              className={tab.id === activeTabId ? "" : "hidden"}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            />
          );
        })}
        {!tabs.length && <div className="panel empty-state">Enter an allowlisted URL to begin.</div>}
      </section>
    </div>
  );
}
