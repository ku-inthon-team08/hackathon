import type { Bounds, LatLng } from "./api/types";

// Anam, the BE's sample coordinates. The rough map stays here until Kakao Map is in.
export const MAP_BOUNDS: Bounds = {
  min_lat: 37.578,
  min_lng: 127.02,
  max_lat: 37.6,
  max_lng: 127.044,
};

export function getPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
      reject,
      { timeout: 8000, maximumAge: 60000 },
    );
  });
}
