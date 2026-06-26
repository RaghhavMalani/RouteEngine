import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";

/**
 * The stage: a blank dark canvas + deck.gl model, NOT a map.
 *
 * MapLibre is given an empty style (just a dark background) so there are no tiles
 * and no labels — only the deck.gl road model we draw ourselves. It is kept purely
 * as the camera/projection engine; deck.gl runs INTERLEAVED so the elevated search
 * composites with correct depth.
 *
 * CAMERA — it should feel like a film, not a static tilt:
 *   • a slow continuous orbit at rest (a lit display table);
 *   • a punch-IN fly to each endpoint as it's chosen (so you see where you clicked);
 *   • a curved fly-OUT that frames the whole route on Build.
 * The orbit pauses during any scripted move and during user drags, then resumes.
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
  token: number; // bump to (re)trigger the framing fly-out
}

interface Focus {
  coord: [number, number];
  token: number; // bump to (re)trigger a punch-in to this point
}

interface FramePath {
  min: [number, number];
  max: [number, number];
  token: number; // bump to zoom-fit the finished route
}

interface MapViewProps {
  layers: Layer[];
  frameRoute: FrameRoute | null;
  focus: Focus | null;
  framePath: FramePath | null;
  onMapClick: (lng: number, lat: number) => void;
}

export default function MapView({ layers, frameRoute, focus, framePath, onMapClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const orbitRef = useRef(true);
  const draggingRef = useRef(false);
  const idleTimer = useRef<number>(0);
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

    // While the user is interacting (zoom/pan to aim), stop the auto-orbit so
    // their target doesn't drift; resume after a few seconds of stillness.
    const pauseOrbit = () => {
      orbitRef.current = false;
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        orbitRef.current = true;
      }, 5000);
    };
    map.on("mousedown", pauseOrbit);
    map.on("wheel", pauseOrbit);
    map.on("touchstart", pauseOrbit);

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Continuous slow orbit (paused during scripted moves / drags).
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

  // Punch-IN: fly close to the endpoint the moment it's chosen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    orbitRef.current = false;
    map.flyTo({
      center: focus.coord,
      zoom: 13.6,
      pitch: 62,
      duration: 1400,
      curve: 1.7,
      essential: true,
    });
    const resume = () => {
      orbitRef.current = true;
      map.off("moveend", resume);
    };
    map.on("moveend", resume);
    return () => {
      map.off("moveend", resume);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  // Fly-OUT: a curved cinematic move that frames source + destination on Build.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !frameRoute) return;

    const bounds = new maplibregl.LngLatBounds(frameRoute.source, frameRoute.source);
    bounds.extend(frameRoute.dest);

    orbitRef.current = false;
    const cam = map.cameraForBounds(bounds, {
      padding: 170,
      pitch: 52,
      bearing: map.getBearing(),
      maxZoom: 13.5,
    });
    if (cam) {
      map.flyTo({
        center: cam.center as maplibregl.LngLatLike,
        zoom: (cam.zoom as number) ?? map.getZoom(),
        pitch: 52,
        duration: 2200,
        curve: 1.5,
        speed: 0.8,
        essential: true,
      });
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

  // Zoom-IN to the finished route: ease to fit the path tightly, at a gentler
  // pitch so the line reads clearly, then resume the slow orbit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !framePath) return;

    const bounds = new maplibregl.LngLatBounds(framePath.min, framePath.min);
    bounds.extend(framePath.max);

    orbitRef.current = false;
    const cam = map.cameraForBounds(bounds, {
      padding: 80,
      pitch: 35,
      bearing: map.getBearing(),
      maxZoom: 16,
    });
    if (cam) {
      map.flyTo({
        center: cam.center as maplibregl.LngLatLike,
        zoom: (cam.zoom as number) ?? map.getZoom(),
        pitch: 35,
        duration: 1700,
        curve: 1.4,
        essential: true,
      });
      const resume = () => {
        orbitRef.current = true;
        map.off("moveend", resume);
      };
      map.on("moveend", resume);
    } else {
      orbitRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framePath?.token]);

  return <div className="map-root" ref={containerRef} />;
}
