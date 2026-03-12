import Browser from "./components/Browser";

export default function Home() {
  const whitelistEnabled = process.env.PROXY_WHITELIST_ENABLED !== "false";

  return (
    <main className="app-shell">
      <Browser whitelistEnabled={whitelistEnabled} />
    </main>
  );
}
