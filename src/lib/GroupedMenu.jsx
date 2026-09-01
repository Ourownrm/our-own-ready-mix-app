import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";

// items: [{ label, to: "/route" }] for a Link, or [{ label, onClick: fn }] for
// an internal view switch. Renders nothing if items is empty (so a menu with
// zero accessible items for a role just doesn't appear).
export function GroupedMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen(!open)}>{label} {open ? "▴" : "▾"}</button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, background: "var(--surface-2, #fff)",
          border: "1px solid var(--concrete)", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
          zIndex: 20, minWidth: 200, display: "flex", flexDirection: "column", padding: 6,
        }}>
          {items.map((item, i) => {
            const style = { textAlign: "left", padding: "7px 10px", fontSize: 13, border: "none", background: "none", width: "100%" };
            if (item.to) {
              return (
                <Link key={i} to={item.to} onClick={() => setOpen(false)} style={{ textDecoration: "none", color: "inherit" }}>
                  <button type="button" style={style}>{item.label}</button>
                </Link>
              );
            }
            return (
              <button key={i} type="button" style={style} onClick={() => { item.onClick(); setOpen(false); }}>
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
