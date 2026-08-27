import { createContext, useContext, useState } from "react";

// Round 119, post-ship again — round 6, item 3: the language option
// originally shipped only inside the logged-in portal's More screen. Business
// feedback was that a member of the public browsing the pre-login pages
// (Services, Ready-Mix vs. Site-Mix, Free Technical Assistance, a booking
// link, a shared tracking link, the public inquiry form) has no way to
// switch languages at all before signing in. CustomerLanguageProvider now
// wraps the whole app (see App.jsx) instead of just the portal, and this
// small standalone switcher — same 3 languages, same localStorage-backed
// choice — drops into each of those public pages' own header.

// Round 119, post-ship again, item 6 — a language option for the customer
// portal (/portal), covering English, Malayalam, and Kannada. Deliberately a
// SEPARATE dictionary from lib/i18n.js, not an extension of it: that file's
// own header scopes it to the driver app, and its language set (en/ml/hi)
// doesn't even match what was asked for here (ml/kn, no Hindi). Same
// separation-of-concerns reasoning as customerPortalApi.js keeping its own
// session storage instead of reusing the staff one.
//
// Coverage note: this ships translated the shell chrome every customer sees
// on every visit — bottom nav, screen titles, the Home tile grid, and the
// More menu (including this language switcher itself) — plus the common
// status/action words reused across screens. Deeper screens (order detail
// field labels, QC reports, technical writings body copy) still render in
// English pending translation; the dictionary and hook below are built so
// filling those in later is additive — add a key to all three languages and
// call t() where the string is written, nothing structural to change.

export const CUSTOMER_LANGUAGES = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ" },
];

const STORAGE_KEY = "oorm_customer_language";

const DICT = {
  appName: { en: "Our Own Ready Mix", ml: "ഔർ ഓൺ റെഡി മിക്സ്", kn: "ಅವರ್ ಓನ್ ರೆಡಿ ಮಿಕ್ಸ್" },
  nav_home: { en: "Home", ml: "ഹോം", kn: "ಮುಖಪುಟ" },
  nav_orders: { en: "Orders", ml: "ഓർഡറുകൾ", kn: "ಆರ್ಡರ್‌ಗಳು" },
  nav_track: { en: "Track", ml: "ട്രാക്ക്", kn: "ಟ್ರ್ಯಾಕ್" },
  nav_more: { en: "More", ml: "കൂടുതൽ", kn: "ಇನ್ನಷ್ಟು" },

  title_my_orders: { en: "My Orders", ml: "എന്റെ ഓർഡറുകൾ", kn: "ನನ್ನ ಆರ್ಡರ್‌ಗಳು" },
  title_track: { en: "Track", ml: "ട്രാക്ക്", kn: "ಟ್ರ್ಯಾಕ್" },
  title_more: { en: "More", ml: "കൂടുതൽ", kn: "ಇನ್ನಷ್ಟು" },
  title_order_concrete: { en: "Order Concrete", ml: "കോൺക്രീറ്റ് ഓർഡർ ചെയ്യുക", kn: "ಕಾಂಕ್ರೀಟ್ ಆರ್ಡರ್ ಮಾಡಿ" },
  title_qc_mix_designs: { en: "QC & Mix Designs", ml: "ക്യുസി & മിക്സ് ഡിസൈനുകൾ", kn: "ಕ್ಯುಸಿ ಮತ್ತು ಮಿಕ್ಸ್ ಡಿಸೈನ್‌ಗಳು" },
  title_technical_writings: { en: "Technical Writings", ml: "സാങ്കേതിക രചനകൾ", kn: "ತಾಂತ್ರಿಕ ಬರಹಗಳು" },
  title_feedback: { en: "Feedback", ml: "അഭിപ്രായം", kn: "ಪ್ರತಿಕ್ರಿಯೆ" },
  title_live_delivery_status: { en: "Live delivery status", ml: "തത്സമയ ഡെലിവറി സ്ഥിതി", kn: "ಲೈವ್ ಡೆಲಿವರಿ ಸ್ಥಿತಿ" },

  home_view_orders: { en: "View orders", ml: "ഓർഡറുകൾ കാണുക", kn: "ಆರ್ಡರ್‌ಗಳನ್ನು ವೀಕ್ಷಿಸಿ" },
  home_track_delivery: { en: "Track delivery", ml: "ഡെലിവറി ട്രാക്ക് ചെയ്യുക", kn: "ಡೆಲಿವರಿ ಟ್ರ್ಯಾಕ್ ಮಾಡಿ" },
  home_live_tracking: { en: "Live Tracking", ml: "തത്സമയ ട്രാക്കിംഗ്", kn: "ಲೈವ್ ಟ್ರ್ಯಾಕಿಂಗ್" },

  more_qc_mix_designs: { en: "QC & Mix Designs", ml: "ക്യുസി & മിക്സ് ഡിസൈനുകൾ", kn: "ಕ್ಯುಸಿ ಮತ್ತು ಮಿಕ್ಸ್ ಡಿಸೈನ್‌ಗಳು" },
  more_technical_writings: { en: "Technical Writings", ml: "സാങ്കേതിക രചനകൾ", kn: "ತಾಂತ್ರಿಕ ಬರಹಗಳು" },
  more_feedback: { en: "Feedback", ml: "അഭിപ്രായം", kn: "ಪ್ರತಿಕ್ರಿಯೆ" },
  more_services: { en: "Services, Products & Equipment", ml: "സേവനങ്ങൾ, ഉൽപ്പന്നങ്ങൾ & ഉപകരണങ്ങൾ", kn: "ಸೇವೆಗಳು, ಉತ್ಪನ್ನಗಳು ಮತ್ತು ಉಪಕರಣಗಳು" },
  more_rmc_vs_sitemix: { en: "Ready-mix vs. Site-mix", ml: "റെഡി-മിക്സ് vs. സൈറ്റ്-മിക്സ്", kn: "ರೆಡಿ-ಮಿಕ್ಸ್ vs. ಸೈಟ್-ಮಿಕ್ಸ್" },
  more_technical_assistance: { en: "Free Technical Assistance", ml: "സൗജന്യ സാങ്കേതിക സഹായം", kn: "ಉಚಿತ ತಾಂತ್ರಿಕ ಸಹಾಯ" },
  more_request_quote: { en: "Request a Quote", ml: "ഒരു ക്വോട്ട് അഭ്യർത്ഥിക്കുക", kn: "ಉಲ್ಲೇಖ ಕೋರಿ" },
  more_language: { en: "Language", ml: "ഭാഷ", kn: "ಭಾಷೆ" },
  more_no_sites: { en: "No sites on this code", ml: "ഈ കോഡിൽ സൈറ്റുകളൊന്നുമില്ല", kn: "ಈ ಕೋಡ್‌ನಲ್ಲಿ ಯಾವುದೇ ಸೈಟ್‌ಗಳಿಲ್ಲ" },
  sign_out: { en: "Sign out", ml: "സൈൻ ഔട്ട്", kn: "ಸೈನ್ ಔಟ್" },

  choose_language: { en: "Choose language", ml: "ഭാഷ തിരഞ്ഞെടുക്കുക", kn: "ಭಾಷೆ ಆಯ್ಕೆಮಾಡಿ" },
  done: { en: "Done", ml: "ശരി", kn: "ಮುಗಿದಿದೆ" },

  // Public (pre-login) page titles — round 6, item 3
  title_services: { en: "Services & Products", ml: "സേവനങ്ങളും ഉൽപ്പന്നങ്ങളും", kn: "ಸೇವೆಗಳು ಮತ್ತು ಉತ್ಪನ್ನಗಳು" },
  title_rmc_vs_sitemix: { en: "Ready-Mix vs. Site-Mix", ml: "റെഡി-മിക്സ് vs. സൈറ്റ്-മിക്സ്", kn: "ರೆಡಿ-ಮಿಕ್ಸ್ vs. ಸೈಟ್-ಮಿಕ್ಸ್" },
  title_technical_assistance: { en: "Free Technical Assistance", ml: "സൗജന്യ സാങ്കേതിക സഹായം", kn: "ಉಚಿತ ತಾಂತ್ರಿಕ ಸಹಾಯ" },
  title_request_quote: { en: "Request a Quote", ml: "ഒരു ക്വോട്ട് അഭ്യർത്ഥിക്കുക", kn: "ಉಲ್ಲೇಖ ಕೋರಿ" },
  title_delivery_tracking: { en: "Delivery tracking", ml: "ഡെലിവരി ട്രാക്കിംഗ്", kn: "ಡೆಲಿವರಿ ಟ್ರ್ಯಾಕಿಂಗ್" },
  title_concrete_booking: { en: "Concrete booking", ml: "കോൺക്രീറ്റ് ബുക്കിംഗ്", kn: "ಕಾಂಕ್ರೀಟ್ ಬುಕಿಂಗ್" },
  back: { en: "Back", ml: "തിരികെ", kn: "ಹಿಂದೆ" },
};

export function t(key, lang) {
  return DICT[key]?.[lang] || DICT[key]?.en || key;
}

export function getStoredCustomerLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
}

const CustomerLanguageContext = createContext({ lang: "en", setLang: () => {}, t: (key) => t(key, "en") });

export function CustomerLanguageProvider({ children }) {
  const [lang, setLangState] = useState(getStoredCustomerLanguage);
  function setLang(code) {
    setLangState(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // best-effort — a language choice that doesn't persist across visits
      // still works for the current one
    }
  }
  const value = { lang, setLang, t: (key) => t(key, lang) };
  return <CustomerLanguageContext.Provider value={value}>{children}</CustomerLanguageContext.Provider>;
}

export function useCustomerLanguage() {
  return useContext(CustomerLanguageContext);
}

// A compact "🌐 English ▾" button that expands into the same 3-language list
// as the portal's More screen — meant to sit in a public page's topbar
// (round 6, item 3). Self-contained: manages its own open/closed state, so
// dropping it into a page needs nothing beyond rendering it inside a
// CustomerLanguageProvider (App.jsx provides one for the whole app).
export function PublicLanguageSwitcher() {
  const { lang, setLang } = useCustomerLanguage();
  const [open, setOpen] = useState(false);
  const current = CUSTOMER_LANGUAGES.find((l) => l.code === lang) || CUSTOMER_LANGUAGES[0];

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 11.5, padding: "5px 10px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(255,255,255,0.08)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        🌐 {current.nativeLabel} ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 20, minWidth: 140,
            background: "#fff", border: "1px solid var(--border, #DEDAD1)", borderRadius: 8,
            boxShadow: "0 4px 14px rgba(0,0,0,0.15)", overflow: "hidden",
          }}
        >
          {CUSTOMER_LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => { setLang(l.code); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px", fontSize: 12.5,
                background: l.code === lang ? "var(--concrete)" : "transparent", color: "var(--charcoal, #22262B)", border: "none",
              }}
            >
              {l.nativeLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
