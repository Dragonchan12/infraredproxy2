"use client";

import { useMemo, useRef, useState } from "react";

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

function normalizeInput(value) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export default function Browser({ whitelistEnabled }) {
  const [tabs, setTabs] = useState([
    { id: 1, title: "New Tab", url: "" },
  ]);
  const [activeTabId, setActiveTabId] = useState(1);
  const nextIdRef = useRef(2);
  const [input, setInput] = useState("");

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);

  const iframeSrc = useMemo(() => {
    if (!activeTab || !activeTab.url) return "";
    return `/api/preview?url=${encodeURIComponent(activeTab.url)}`;
  }, [activeTab]);

  const getTabTitle = (url) => {
    if (!url) return "New Tab";
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./i, "");
    } catch {
      return url;
    }
  };

  const handleNewTab = () => {
    const nextId = nextIdRef.current++;
    const newTab = { id: nextId, title: "New Tab", url: "" };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(nextId);
    setInput("");
  };

  const handleCloseTab = (id) => {
    if (tabs.length === 1) {
      setTabs([{ id: 1, title: "New Tab", url: "" }]);
      setActiveTabId(1);
      nextIdRef.current = 2;
      setInput("");
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
              placeholder="Enter an allowlisted URL (ex: https://www.youtube.com)"
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
        {iframeSrc ? (
          <iframe
            key={activeTabId}
            title="Proxy preview"
            src={iframeSrc}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          />
        ) : (
          <div className="panel empty-state">Enter an allowlisted URL to begin.</div>
        )}
      </section>
    </div>
  );
}
