// Round 254 — the transit mixer drawn on the Vehicle tracking stage bar
// (owner, 31 Oct 2026, from the photo of the plant's own truck): blue cabin,
// orange-yellow tilted drum, "Our Own Ready Mix" on the drum. Faces right
// going to site; flipped when returning. `chute` shows the chute down while
// unloading.
import { useId } from "react";

export default function TransitMixer({ returning = false, chute = false, width = 122, height = 60, title = "Transit mixer" }) {
  const p = `tm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const truck = (
    <>
      <ellipse cx="98" cy="93" rx="88" ry="3.5" fill="#000" opacity=".14" /><rect x="28" y="66" width="152" height="7" rx="1.5" fill={`url(#${p}Dark)`} /><path d="M42 74 Q42 63 56 63 L84 63 Q97 63 97 74Z" fill="#2B2F34" /><path d="M142 74 Q142 64 154 64 Q166 64 166 74Z" fill="#2B2F34" /><path d="M20 14 L40 14 L36 28 L25 28Z" fill={`url(#${p}Dark)`} /><rect x="19" y="12" width="22" height="3.5" rx="1" fill="#4A5058" /><path d="M25 28 L34 28 L29 46 L17 50 L15 46Z" fill="#3A3F45" /><path d="M22 34 L22 66 M28 34 L28 66 M22 42 L28 42 M22 50 L28 50 M22 58 L28 58" stroke="#4A5058" strokeWidth="1.6" fill="none" /><path d="M30 30 L44 22 L46 64 L32 66Z" fill="#3A3F45" /><path d="M44 20 C56 13 80 13 94 19 L111 30 C116 39 116 55 111 62 L96 65 L58 65 C49 63 44 58 44 50 Z" fill={`url(#${p}Drum)`} /><path d="M62 15 C66 32 68 50 68 65 L78 65 C78 50 76 32 72 14Z" fill="#E08C10" opacity=".5" /><path d="M90 18 C95 34 97 50 96 64 L104 63 C105 49 103 34 99 23Z" fill="#E08C10" opacity=".5" /><path d="M54 17 C70 14 86 15 100 22" stroke="#FFF1C2" strokeWidth="2.6" fill="none" strokeLinecap="round" opacity=".85" /><ellipse cx="45" cy="40" rx="4.5" ry="21" fill={`url(#${p}Dark)`} /><path d="M108 29 C116 36 116 56 109 62 L112 61 C119 55 119 37 111 30Z" fill="#C27A0C" /><path d="M106 46 L124 46 L126 66 L104 66Z" fill="#3A3F45" /><circle cx="120" cy="35" r="6.5" fill={`url(#${p}Drum)`} /><circle cx="120" cy="35" r="2.6" fill="#C27A0C" /><path d="M126 34 L130 28 L130 46" stroke="#5A6169" strokeWidth="1.4" fill="none" /><rect x="106" y="68" width="22" height="12" rx="2" fill={`url(#${p}Tank)`} /><path d="M110 70 V78 M114 70 V78 M118 70 V78 M122 70 V78" stroke="#8C949C" strokeWidth=".9" /><path d="M131 30 L170 30 Q178 30 180 37 L182 52 L182 76 L131 76Z" fill={`url(#${p}Cab)`} /><path d="M155 34 L170 34 Q174 34 175 39 L176.5 49 L155 49Z" fill={`url(#${p}Glass)`} /><path d="M137 34 L151 34 L151 47 L137 47Z" fill={`url(#${p}Glass)`} /><path d="M153 31 V74" stroke="#16477F" strokeWidth="1" /><rect x="143" y="52" width="6" height="1.8" rx=".9" fill="#0F3460" /><path d="M131 58 L182 58" stroke="#F7AE22" strokeWidth="2.2" /><rect x="178" y="62" width="5" height="13" rx="1" fill="#22262B" /><rect x="177.5" y="65" width="5.5" height="3.2" rx=".8" fill="#FFE9A8" /><path d="M180 36 L186 36 L186 45" stroke="#22262B" strokeWidth="1.6" fill="none" /><rect x="184.5" y="43" width="3.4" height="7" rx="1" fill="#22262B" /><rect x="133" y="76" width="10" height="3" fill="#22262B" /><circle cx="56" cy="82" r="10.5" fill="#1C1F23" /><circle cx="56" cy="82" r="9" fill="none" stroke="#34383E" strokeWidth="1.6" strokeDasharray="2.4 1.6" /><circle cx="56" cy="82" r="5.6" fill={`url(#${p}Rim)`} /><circle cx="56" cy="82" r="1.9" fill="#5A6169" /><circle cx="83" cy="82" r="10.5" fill="#1C1F23" /><circle cx="83" cy="82" r="9" fill="none" stroke="#34383E" strokeWidth="1.6" strokeDasharray="2.4 1.6" /><circle cx="83" cy="82" r="5.6" fill={`url(#${p}Rim)`} /><circle cx="83" cy="82" r="1.9" fill="#5A6169" /><circle cx="154" cy="82" r="10.5" fill="#1C1F23" /><circle cx="154" cy="82" r="9" fill="none" stroke="#34383E" strokeWidth="1.6" strokeDasharray="2.4 1.6" /><circle cx="154" cy="82" r="5.6" fill={`url(#${p}Rim)`} /><circle cx="154" cy="82" r="1.9" fill="#5A6169" />
      {chute && <><path d="M17 50 C15 60 18 70 15 84" stroke="#8C949C" strokeWidth="4.5" fill="none" strokeLinecap="round" /><ellipse cx="15" cy="90" rx="12" ry="4" fill="#8C949C" /></>}
    </>
  );
  return (
    <svg viewBox="0 0 196 96" width={width} height={height} role="img" aria-label={title}>
      <defs>
<linearGradient id={`${p}Drum`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFD866" /><stop offset=".35" stopColor="#F7AE22" /><stop offset=".8" stopColor="#E08C10" /><stop offset="1" stopColor="#B9700A" /></linearGradient>
<linearGradient id={`${p}Cab`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3D8BDB" /><stop offset=".55" stopColor="#1F5FA8" /><stop offset="1" stopColor="#16477F" /></linearGradient>
<linearGradient id={`${p}Glass`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#EAF4FD" /><stop offset=".5" stopColor="#B7D3EE" /><stop offset="1" stopColor="#8FB4D9" /></linearGradient>
<linearGradient id={`${p}Dark`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5A6169" /><stop offset="1" stopColor="#2B2F34" /></linearGradient>
<radialGradient id={`${p}Rim`} cx=".45" cy=".4" r=".7"><stop offset="0" stopColor="#F2F4F6" /><stop offset=".7" stopColor="#AEB5BD" /><stop offset="1" stopColor="#7D858E" /></radialGradient>
<linearGradient id={`${p}Tank`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F4F6F8" /><stop offset="1" stopColor="#A9B0B8" /></linearGradient></defs>
      {returning ? <g transform="translate(196 0) scale(-1 1)">{truck}</g> : truck}
      <g transform={returning ? "rotate(-8 119 40)" : "rotate(8 77 40)"}>
        <text x={returning ? 119 : 77} y="37" fontSize="10.5" fontFamily="-apple-system,Segoe UI,Roboto,sans-serif" fontWeight="800" textAnchor="middle" fill="#12365F" letterSpacing=".3">OUR OWN</text>
        <text x={returning ? 119 : 77} y="49" fontSize="10" fontFamily="-apple-system,Segoe UI,Roboto,sans-serif" fontWeight="800" textAnchor="middle" fill="#12365F" letterSpacing=".3">READY MIX</text>
      </g>
    </svg>
  );
}
