const COLORS = [
  "var(--signal-green)", "var(--info)", "var(--violet)", "var(--amber)",
  "var(--alert-red)", "var(--slate)", "#0F6E56", "#993C1D",
];

// Monochromatic shades of one hue — darkest for the largest slice, fading
// lighter for smaller ones, rather than a distinct color per category.
function monochromeShades(hue, count) {
  const shades = [];
  for (let i = 0; i < count; i++) {
    const lightness = 32 + (i * (46 / Math.max(count - 1, 1)));
    shades.push(`hsl(${hue}, 45%, ${Math.min(lightness, 78)}%)`);
  }
  return shades;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeSlice(cx, cy, r, startAngle, endAngle) {
  if (endAngle - startAngle >= 359.99) {
    // A single 100% slice — the arc formula degenerates when start === end,
    // so draw it as two half-circle arcs instead.
    const mid = polarToCartesian(cx, cy, r, startAngle + 180);
    const start = polarToCartesian(cx, cy, r, startAngle);
    return `M ${start.x} ${start.y} A ${r} ${r} 0 1 0 ${mid.x} ${mid.y} A ${r} ${r} 0 1 0 ${start.x} ${start.y} Z`;
  }
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

// data: [{ label, value }]. Purely presentational, no external dependency —
// matches the existing hand-rolled SVG bar chart already used in this app.
export function PieChart({ data, valueLabel = (v) => v, size = 160, monochromeHue }) {
  const total = data.reduce((s, d) => s + Number(d.value), 0);
  const r = size / 2;

  if (!data.length || total <= 0) {
    return <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing to chart yet.</div>;
  }

  const palette = monochromeHue != null ? monochromeShades(monochromeHue, data.length) : COLORS;
  let angle = 0;
  const slices = data.map((d, i) => {
    const sliceAngle = (Number(d.value) / total) * 360;
    const path = describeSlice(r, r, r, angle, angle + sliceAngle);
    angle += sliceAngle;
    return { ...d, path, color: palette[i % palette.length], pct: ((Number(d.value) / total) * 100).toFixed(1) };
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Pie chart: ${data.map((d) => `${d.label} ${valueLabel(d.value)}`).join(", ")}`}>
        {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="var(--surface-1, #fff)" strokeWidth="1" />)}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span>{s.label} — {valueLabel(s.value)} ({s.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
