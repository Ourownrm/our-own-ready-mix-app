// These roles' screens were designed and approved as mockups already.
// Placeholders here mark where each gets wired to the real backend next.
export function ComingSoon({ role }) {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center", color: "#666" }}>
      <h2 style={{ fontSize: 18 }}>{role}</h2>
      <p style={{ fontSize: 14 }}>This screen's design is approved — being wired to the live backend next.</p>
    </div>
  );
}
