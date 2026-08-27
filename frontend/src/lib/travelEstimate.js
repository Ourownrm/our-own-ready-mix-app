// Round 119, post-ship again — round 6, item 1: helps Create Order / Convert
// Booking suggest a batching time that's early enough for the truck to reach
// site by the time the customer actually asked for ("required at site"),
// based on the site's distance from the plant.
//
// There's no real travel-time/traffic data anywhere in this app yet (no maps
// API, no per-route history) — sites only carry a straight-line
// `distance_from_plant_km` (already used elsewhere for trip allowance
// brackets). So this is a deliberately simple, transparent estimate: an
// assumed average speed for a loaded mixer truck in mixed local traffic,
// plus a fixed plant preparation buffer before the truck can actually leave.
// It's offered to the person filling the form as a starting suggestion they
// can freely override — never applied automatically or silently. If this
// assumption turns out wrong in practice (routes that are unusually slow or
// fast for their distance), the two constants below are the only things
// that would need adjusting.
export const ASSUMED_AVERAGE_SPEED_KMPH = 25;
export const BATCHING_PREP_BUFFER_MINUTES = 15;

export function estimateTravelMinutes(distanceKm) {
  const d = Number(distanceKm);
  if (!d || d <= 0) return null;
  return Math.round((d / ASSUMED_AVERAGE_SPEED_KMPH) * 60);
}

// Returns "HH:MM" (or null if there isn't enough info to compute one).
export function suggestBatchingTime(requiredAtSiteTime, distanceKm) {
  const travelMinutes = estimateTravelMinutes(distanceKm);
  if (!requiredAtSiteTime || travelMinutes === null) return null;
  const [h, m] = requiredAtSiteTime.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  let total = h * 60 + m - travelMinutes - BATCHING_PREP_BUFFER_MINUTES;
  if (total < 0) total = 0; // don't wrap into "the day before" — just floor at midnight
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
