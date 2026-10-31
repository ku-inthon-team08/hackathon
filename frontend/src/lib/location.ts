import type { Bounds, LatLng } from "./api/types";

// Mapo-gu, the extent of data/road_network. Routes and load data only exist inside it.
export const MAP_BOUNDS: Bounds = {
  min_lat: 37.5326,
  min_lng: 126.8534,
  max_lat: 37.5934,
  max_lng: 126.967,
};

function inServiceArea({ lat, lng }: LatLng) {
  const b = MAP_BOUNDS;
  return lat >= b.min_lat && lat <= b.max_lat && lng >= b.min_lng && lng <= b.max_lng;
}


// Rejects outside Mapo-gu too, so callers ask for a start point instead of routing from there.
export function getPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const here = { lat: coords.latitude, lng: coords.longitude };
        if (inServiceArea(here)) resolve(here);
        else reject(new Error("outside the service area"));
      },
      reject,
      { timeout: 8000, maximumAge: 60000 },
    );
  });
}
