// No public landing page: every user arrives on their own /c/<token> link.
export default function Home() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", padding: 24, textAlign: "center" }}>
      <p style={{ color: "#575757" }}>Astrolokal</p>
    </main>
  );
}
