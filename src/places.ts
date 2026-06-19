import type { LngLat } from "./engine/pathfinder";

/**
 * Famous Bengaluru landmarks used for the one-click demo routes. Coordinates are
 * approximate [lng, lat] centres; the app snaps each to the nearest graph node,
 * so they don't need to sit exactly on a road.
 */
export interface Place {
  name: string;
  coord: LngLat;
}

export const PLACES: Record<string, Place> = {
  electronicCity: { name: "Electronic City", coord: [77.6603, 12.8452] },
  whitefield: { name: "Whitefield", coord: [77.7499, 12.9698] },
  koramangala: { name: "Koramangala", coord: [77.6245, 12.9352] },
  manyata: { name: "Manyata Tech Park", coord: [77.6206, 13.044] },
  majestic: { name: "Majestic", coord: [77.5712, 12.9767] },
  indiranagar: { name: "Indiranagar", coord: [77.6408, 12.9719] },
};

export interface QuickRoute {
  label: string;
  from: Place;
  to: Place;
}

/** The instant-demo buttons in the control panel. */
export const QUICK_ROUTES: QuickRoute[] = [
  {
    label: "Electronic City → Whitefield",
    from: PLACES.electronicCity,
    to: PLACES.whitefield,
  },
  {
    label: "Koramangala → Manyata Tech Park",
    from: PLACES.koramangala,
    to: PLACES.manyata,
  },
  {
    label: "Majestic → Indiranagar",
    from: PLACES.majestic,
    to: PLACES.indiranagar,
  },
];
