// Any unknown path (e.g. a mistyped link) gets the same friendly screen as an expired chat link.
export default function NotFound() {
  return (
    <main style={{ minHeight: "100dvh", maxWidth: 480, margin: "0 auto", display: "grid", placeContent: "center", gap: 8, padding: "32px 28px", textAlign: "center", background: "var(--ground)" }}>
      <div aria-hidden style={{ width: 64, height: 64, borderRadius: 22, background: "var(--orange-wash)", display: "grid", placeItems: "center", fontSize: 28, margin: "0 auto 6px" }}>✨</div>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>This link isn&apos;t working</h1>
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 15, lineHeight: 1.45 }}>Please open the link from your WhatsApp message again.</p>
    </main>
  );
}
