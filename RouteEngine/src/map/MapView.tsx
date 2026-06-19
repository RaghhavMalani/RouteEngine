import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";

/**
 * The stage: a blank dark canvas + deck.gl model, NOT a map.
 *
 * We deliberately give MapLibre an empty style (just a dark background layer) so
 * there are no tiles, no town/village labels, no roads-from-tiles — nothing but
 * the deck.gl road model we draw ourselves. MapLibre is kept purely as the camera
 * and projection engine (so [lng,lat] still works and deck stays perfectly
 * synced); deck.gl runs INTERLEAVED so the elevated search composites with correct
 * depth.
 *
 * The camera holds a fixed pitch and slowly, continuously orbits — giving the
 * "architectural massing model" feel. The orbit pauses while the user is dragging
 * and during the framing fly-in triggered on Build.
 */

const BENGALURU_CENTER: [number, number] = [77.5946, 12.9716];
const ORBIT_DEG_PER_FRAME = 0.02; // ~1.2°/s at 60fps — slow and premium

const BLANK_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: "stage-bg",
      type: "background" as const,
      paint: { "background-color": "#070a0e" },
    },
  ],
};

interface FrameRoute {
  source: [number, number];
  dest: [number, number];
  token: number; // bump to (re)trigger the framing fly-in
}

interface MapViewProps {
  layers: Layer[];
  frameRoute: FrameRoute | null;
  onMapClick: (lng: number, lat: number) => void;
}

export default function MapView({ layers, frameRoute, onMapClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const orbitRef = useRef(true); // is the auto-orbit currently running?
  const draggingRef = useRef(false);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  // Create the map exactly once.
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BLANK_STYLE as maplibregl.StyleSpecification,
      center: BENGALURU_CENTER,
      zoom: 10.6,
      pitch: 55,
      bearing: -20,
      attributionControl: false,
      antialias: true,
    });

    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);

    map.on("click", (e) => clickRef.current(e.lngLat.lng, e.lngLat.lat));
    map.on("dragstart", () => (draggingRef.current = true));
    map.on("dragend", () => (draggingRef.current = false));
    map.on("load", () => (map.getCanvas().style.cursor = "crosshair"));

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Continuous slow orbit. We read mapRef inside the loop so it survives any
  // StrictMode remount, and pause while dragging or framing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const map = mapRef.current;
      if (map && orbitRef.current && !draggingRef.current) {
        map.setBearing(map.getBearing() + ORBIT_DEG_PER_FRAME);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Push new deck layers to the overlay whenever they change.
  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  // Frame the route on Build: ease to fit source+destination, then resume orbit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !frameRoute) return;

    const bounds = new maplibregl.LngLatBounds(frameRoute.source, frameRoute.source);
    bounds.extend(frameRoute.dest);

    orbitRef.current = false;
    const cam = map.cameraForBounds(bounds, {
      padding: 140,
      pitch: 55,
      bearing: map.getBearing(),
      maxZoom: 14,
    });
    if (cam) {
      map.easeTo({ ...cam, pitch: 55, duration: 1300, essential: true });
      const resume = () => {
        orbitRef.current = true;
        map.off("moveend", resume);
      };
      map.on("moveend", resume);
    } else {
      orbitRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRoute?.token]);

  return <div className="map-root" ref={containerRef} />;
}
