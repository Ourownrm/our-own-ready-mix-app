// Server-side counterpart to frontend/src/lib/i18n.js — used only for the
// text of push notifications sent to a driver (round 96, items 6 & 9). Kept
// as its own small dictionary rather than sharing a module with the
// frontend, since the backend and frontend are separate deploys/bundles in
// this app; the same "first pass, needs native-speaker review" caveat noted
// in the frontend dictionary applies here too.
const DICT = {
  en: {
    left_plant_title: "Looks like you've left the plant",
    left_plant_body: (ticket, truck) => `${ticket} (${truck}) — tap to log Plant Out`,
    reached_site_title: "Looks like you've reached site",
    reached_site_body: (ticket) => `${ticket} — tap to confirm Site In`,
    left_site_title: "Looks like you've left site",
    left_site_body: (ticket) => `${ticket} — confirm Site Out if unloading's done`,
    returned_to_plant_title: "Looks like you're back at the plant",
    returned_to_plant_body: (ticket, truck) => `${ticket} (${truck}) — tap to log Plant In`,
    action_plant_out: "Plant Out",
    action_site_in: "Site In",
    action_site_out: "Site Out",
    action_plant_in: "Plant In",
  },
  ml: {
    left_plant_title: "നിങ്ങൾ പ്ലാന്റ് വിട്ടതായി തോന്നുന്നു",
    left_plant_body: (ticket, truck) => `${ticket} (${truck}) — പ്ലാന്റ് ഔട്ട് രേഖപ്പെടുത്താൻ ടാപ്പ് ചെയ്യുക`,
    reached_site_title: "നിങ്ങൾ സൈറ്റിൽ എത്തിയതായി തോന്നുന്നു",
    reached_site_body: (ticket) => `${ticket} — സൈറ്റ് ഇൻ സ്ഥിരീകരിക്കാൻ ടാപ്പ് ചെയ്യുക`,
    left_site_title: "നിങ്ങൾ സൈറ്റ് വിട്ടതായി തോന്നുന്നു",
    left_site_body: (ticket) => `${ticket} — അൺലോഡിംഗ് കഴിഞ്ഞെങ്കിൽ സൈറ്റ് ഔട്ട് സ്ഥിരീകരിക്കുക`,
    returned_to_plant_title: "നിങ്ങൾ പ്ലാന്റിൽ തിരിച്ചെത്തിയതായി തോന്നുന്നു",
    returned_to_plant_body: (ticket, truck) => `${ticket} (${truck}) — പ്ലാന്റ് ഇൻ രേഖപ്പെടുത്താൻ ടാപ്പ് ചെയ്യുക`,
    action_plant_out: "പ്ലാന്റ് ഔട്ട്",
    action_site_in: "സൈറ്റ് ഇൻ",
    action_site_out: "സൈറ്റ് ഔട്ട്",
    action_plant_in: "പ്ലാന്റ് ഇൻ",
  },
  hi: {
    left_plant_title: "लगता है आपने प्लांट छोड़ दिया है",
    left_plant_body: (ticket, truck) => `${ticket} (${truck}) — प्लांट आउट दर्ज करने के लिए टैप करें`,
    reached_site_title: "लगता है आप साइट पर पहुंच गए हैं",
    reached_site_body: (ticket) => `${ticket} — साइट इन की पुष्टि करने के लिए टैप करें`,
    left_site_title: "लगता है आपने साइट छोड़ दी है",
    left_site_body: (ticket) => `${ticket} — अनलोडिंग पूरी हो गई हो तो साइट आउट की पुष्टि करें`,
    returned_to_plant_title: "लगता है आप वापस प्लांट पर पहुंच गए हैं",
    returned_to_plant_body: (ticket, truck) => `${ticket} (${truck}) — प्लांट इन दर्ज करने के लिए टैप करें`,
    action_plant_out: "प्लांट आउट",
    action_site_in: "साइट इन",
    action_site_out: "साइट आउट",
    action_plant_in: "प्लांट इन",
  },
};

function dictFor(lang) {
  return DICT[lang] || DICT.en;
}

// e.g. pushText("left_plant", "ml", "title") or pushText("left_plant", "ml", "body", [ticketNo, truckNo])
export function pushText(eventKey, lang, part, args = []) {
  const d = dictFor(lang);
  const key = `${eventKey}_${part}`;
  const entry = d[key] ?? DICT.en[key];
  if (typeof entry === "function") return entry(...args);
  return entry ?? key;
}

export function actionLabel(stageKey, lang) {
  const d = dictFor(lang);
  const key = `action_${stageKey}`;
  return d[key] ?? DICT.en[key] ?? stageKey;
}
