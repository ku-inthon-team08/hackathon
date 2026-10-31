import { KAKAO_KEY, searchKakaoPlaces } from "../kakao";
import { searchPlaces as searchSamplePlaces } from "./mock";

export { bestTimes, dataStatus, mapLayers, nearbyShelters, placeDetail, quietRoutes } from "./mock";

export const searchPlaces = KAKAO_KEY ? searchKakaoPlaces : searchSamplePlaces;
