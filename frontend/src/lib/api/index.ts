import { KAKAO_KEY, searchKakaoPlaces } from "../kakao";
import { supabase } from "../supabase";
import * as mock from "./mock";
import * as remote from "./remote";

// Real Supabase RPCs when NEXT_SUPABASE_* are set, local mock data otherwise.
// ?state=loading|empty|error|stale in the URL always previews with mock data.
function source() {
  if (!supabase) return mock;
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("state")) {
    return mock;
  }
  return remote;
}

export const nearbyShelters: typeof mock.nearbyShelters = (...a) => source().nearbyShelters(...a);
export const placeDetail: typeof mock.placeDetail = (...a) => source().placeDetail(...a);
export const quietRoutes: typeof mock.quietRoutes = (...a) => source().quietRoutes(...a);
export const bestTimes: typeof mock.bestTimes = (...a) => source().bestTimes(...a);
export const mapLayers: typeof mock.mapLayers = (...a) => source().mapLayers(...a);
export const dataStatus: typeof mock.dataStatus = (...a) => source().dataStatus(...a);

export const searchPlaces = KAKAO_KEY ? searchKakaoPlaces : mock.searchPlaces;
