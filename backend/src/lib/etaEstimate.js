// Round 120, item 3e — ETA-to-site for a truck currently in transit.
//
// Decided approach (hybrid, per discussion): once a truck has left the plant,
// prefer a LIVE estimate from its most recent GPS ping (straight-line
// distance remaining to the site, divided by that ping's own speed) —
// refining automatically every 30s as new pings arrive, since both
// CustomerTracking.jsx and CustomerPortal.jsx already poll the tracking
// payload every 20s. If there's no usable ping yet (just left, GPS gap, or a
// site with no lat/long on file), fall back to the same distance/assumed-speed
// estimate `frontend/src/lib/travelEstimate.js` already uses for the
// suggested batching time, anchored from the actual left-plant time — same
// idea, same constant, duplicated here because the frontend and backend are
// separate packages (see that file's own comment for why 25 km/h was chosen,
// and why it's a transparent estimate rather than real routing data).
export const ASSUMED_AVERAGE_SPEED_KMPH = 25;

// A ping's reported speed below this is treated as "stopped/idling" (traffic
// light, waiting to unload, GPS jitter while stationary) rather than a real
// travel speed — using it directly would swing the ETA wildly or make it
// climb toward infinity. Falls back to the assumed average instead.
const MIN_TRUSTED_SPEED_KMPH = 5;

// A ping older than this is treated as stale (backgrounded app, dead zone) —
// same fallback as having no ping at all, rather than trusting a position
// that's no longer where the truck actually is.
const MAX_PING_AGE_MINUTES = 10;

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) return null;
  const R = 6371;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns an ISO timestamp string for the estimated arrival, or null if
// there's not enough information (no site GPS/distance on file at all, or
// this truck hasn't left the plant yet). `truck` needs left_plant_at plus the
// last-ping fields orderTracking.js's query attaches; `site` needs
// latitude/longitude and/or distance_from_plant_km. `plant` (optional) is the
// active plant_locations row, {latitude, longitude}.
export function estimateEtaAt(truck, site, plant) {
  if (!truck.left_plant_at || truck.reached_site_at) return null; // not in transit

  const pingAgeMinutes = truck.last_ping_at ? (Date.now() - new Date(truck.last_ping_at).getTime()) / 60000 : Infinity;
  const hasFreshPing = pingAgeMinutes <= MAX_PING_AGE_MINUTES && truck.last_ping_latitude != null && truck.last_ping_longitude != null;

  if (hasFreshPing && site.latitude != null && site.longitude != null) {
    const remainingKm = haversineKm(truck.last_ping_latitude, truck.last_ping_longitude, site.latitude, site.longitude);
    if (remainingKm !== null) {
      const speed = Number(truck.last_ping_speed_kmh) > MIN_TRUSTED_SPEED_KMPH ? Number(truck.last_ping_speed_kmh) : ASSUMED_AVERAGE_SPEED_KMPH;
      const minutesRemaining = (remainingKm / speed) * 60;
      return new Date(Date.now() + minutesRemaining * 60000).toISOString();
    }
  }

  // Fallback (no fresh GPS yet): a distance-based estimate anchored from when
  // the truck actually left the plant. This is written as "left_plant_at +
  // total travel time," but it's mathematically the same figure as "total
  // travel time minus elapsed-since-plant-out, added to now" — ETA = now +
  // (total - elapsed) = now + total - (now - left_plant_at) = left_plant_at +
  // total. Writing it anchored from left_plant_at (rather than from "now")
  // just means the ETA doesn't quietly drift forward every time this
  // function is called again with no new information.
  //
  // Round 121, item 1 — distance itself now prefers a real plant→site
  // haversine distance (using the plant's saved geofence-anchor coordinate
  // and the site's best-known coordinate — the Site Supervisor's own
  // site-ready GPS tap when there is one and it isn't flagged suspect, else
  // the site's saved lat/long) over the site's manually-entered
  // distance_from_plant_km, since straight-line-from-real-coordinates is a
  // more accurate number than a typed-in estimate. Only falls back to the
  // manual figure when a real distance can't be computed at all (no active
  // plant location, or no site coordinate on file).
  const computedDistanceKm = plant?.latitude != null && plant?.longitude != null
    ? haversineKm(plant.latitude, plant.longitude, site.latitude, site.longitude)
    : null;
  const distanceKm = computedDistanceKm !== null ? computedDistanceKm : Number(site.distance_from_plant_km);
  if (distanceKm > 0) {
    const minutes = (distanceKm / ASSUMED_AVERAGE_SPEED_KMPH) * 60;
    return new Date(new Date(truck.left_plant_at).getTime() + minutes * 60000).toISOString();
  }

  return null;
}
