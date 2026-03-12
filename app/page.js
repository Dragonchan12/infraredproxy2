import Browser from "./components/Browser";

export default function Home() {
  const whitelistEnabled = process.env.PROXY_WHITELIST_ENABLED !== "false";
  const encodeEnabled =
    (process.env.PROXY_ENCODE_URLS || "true").trim().toLowerCase() !== "false";

  return (
    <main className="app-shell">
      <Browser whitelistEnabled={whitelistEnabled} encodeEnabled={encodeEnabled} />
    </main>
  );
}
