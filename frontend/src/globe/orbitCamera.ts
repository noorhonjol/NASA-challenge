import * as Cesium from "cesium";
import { centerFrame, grabScale, lookFrame, magnitude, orbitFrame, rollFrame, type CameraFrame } from "./orbitCameraMath";
import {
  ARRIVAL_PITCH, ENTER_ALTITUDE_M, EXIT_ALTITUDE_M, EYE_HEIGHT_M, RUN_SPEED_M_S, WALK_SPEED_M_S,
  cameraFrame, easeInOut, facing, fromCamera, headingDeg, horizontal, look, normalize, travel, walk,
  type Surface, type Vec,
} from "./surfaceView";

/** What the surface-view overlay shows; null when back in orbit mode. */
export type SurfaceStatus = {
  headingDeg: number | null; pitchDeg: number; latitude: number; longitude: number; groundM: number;
  fovDeg: number; moving: boolean; transition: "enter" | "exit" | "travel" | null;
  /** 0–1: how far a deliberate scroll-out has got toward leaving surface view. */
  exitProgress?: number;
};

export type OrbitCameraOptions = {
  /** Terrain height (m) where the globe has none (the polar cap); falls back to the globe's tiles. */
  groundHeight?: (cartographic: Cesium.Cartographic) => number | undefined;
  /** Surface point under a canvas pixel, for click-to-travel in surface view. */
  pickSurface?: (position: Cesium.Cartesian2) => Cesium.Cartographic | undefined;
  /** Whether surface view may be entered (Moon only). */
  surfaceAllowed?: () => boolean;
  /** Whether a click in surface view travels (off while placing pins or drawing a region). */
  clickTravelEnabled?: () => boolean;
  onSurface?: (status: SurfaceStatus | null) => void;
};

type Transition =
  | { kind: "enter"; t0: number; duration: number; from: Surface; h0: number }
  | { kind: "exit"; t0: number; duration: number; from: Surface; h0: number; fov0: number }
  | { kind: "travel"; t0: number; duration: number; path: ReturnType<typeof travel>; metres: number; jumped: boolean };

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyA: [0, -1], ArrowLeft: [0, -1], KeyD: [0, 1], ArrowRight: [0, 1],
};
const MIN_FOV = 15 * Math.PI / 180;
const EXIT_PITCH = -60 * Math.PI / 180;
const CLICK_PIXELS = 6, CLICK_MS = 400;
/** Click-to-move is a quick jump: fade out, move, fade in (seconds; the move happens at JUMP_AT). */
const JUMP_SECONDS = 0.45, JUMP_AT = 0.4;
/** Scrolling out at the normal lens must add up to this much (wheel deltaY, ~12 notches) to leave. */
const EXIT_SCROLL = 1200, EXIT_SCROLL_IDLE_MS = 800;

/**
 * Orbit mode: fixed-radius body-centred orbit; free-look and roll never translate the camera.
 * Surface mode (zoom in below ENTER_ALTITUDE_M): street-view controls at eye height.
 */
export function setupOrbitCamera(viewer: Cesium.Viewer, ellipsoid: Cesium.Ellipsoid, options: OrbitCameraOptions = {}) {
  const { camera, scene } = viewer;
  const canvas = scene.canvas;
  const bodyRadius = ellipsoid.maximumRadius;
  const minAltitude = 40;
  const maxAltitude = ellipsoid === Cesium.Ellipsoid.MOON ? 1_000_000_000 : 40_000_000;
  const nativeControls = scene.screenSpaceCameraController;
  // Disable native movement permanently so it cannot add translation, terrain
  // pivoting or inertia after our exact spherical movement.
  nativeControls.enableRotate = false;
  nativeControls.enableTranslate = false;
  nativeControls.enableTilt = false;
  nativeControls.enableLook = false;
  nativeControls.enableZoom = false;
  nativeControls.inertiaSpin = nativeControls.inertiaTranslate = nativeControls.inertiaZoom = 0;
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const oldTouchAction = canvas.style.touchAction;
  const oldTabIndex = canvas.getAttribute("tabindex");
  canvas.style.touchAction = "none";
  canvas.tabIndex = 0;
  const pointers = new Map<number, { x: number; y: number; button: number; x0: number; y0: number; t0: number }>();
  const frustum = () => camera.frustum as Cesium.PerspectiveFrustum;
  const defaultFov = frustum().fov ?? Math.PI / 3;
  // Black veil over the globe for the jump's fade; it never takes pointer input.
  const veil = document.createElement("div");
  Object.assign(veil.style, { position: "absolute", inset: "0", background: "#000", opacity: "0", pointerEvents: "none", zIndex: "1" });
  canvas.parentElement?.appendChild(veil);
  let exitPush = 0, lastExitPush = 0;

  /** Ground height (m above the sphere) at a cartographic position, 0 where nothing is known. */
  const groundAt = (c: Cesium.Cartographic) => options.groundHeight?.(c) ?? scene.globe.getHeight(c) ?? 0;
  const groundUnder = (p: Vec) => {
    const c = ellipsoid.cartesianToCartographic(new Cesium.Cartesian3(p.x, p.y, p.z));
    return c ? groundAt(c) : 0;
  };
  const minimumAltitudeAt = (position: Vec) => groundUnder(position) + minAltitude;

  const read = (): CameraFrame => ({
    position: Cesium.Cartesian3.clone(camera.positionWC),
    direction: Cesium.Cartesian3.clone(camera.directionWC),
    up: Cesium.Cartesian3.clone(camera.upWC),
  });
  const apply = (frame: CameraFrame) => {
    // Keep the public Cartesian basis directly. setView converts direction/up
    // through heading/pitch/roll, which loses precision near a nadir view and
    // can turn a pure roll into an unwanted change in look direction.
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    Cesium.Cartesian3.fromElements(frame.position.x, frame.position.y, frame.position.z, camera.position);
    Cesium.Cartesian3.fromElements(frame.direction.x, frame.direction.y, frame.direction.z, camera.direction);
    Cesium.Cartesian3.normalize(camera.direction, camera.direction);
    Cesium.Cartesian3.fromElements(frame.up.x, frame.up.y, frame.up.z, camera.up);
    Cesium.Cartesian3.cross(camera.direction, camera.up, camera.right);
    Cesium.Cartesian3.normalize(camera.right, camera.right);
    Cesium.Cartesian3.cross(camera.right, camera.direction, camera.up);
    scene.requestRender();
  };

  // ---------------------------------------------------------------- surface view
  let surface: Surface | null = null;
  let transition: Transition | null = null;
  const keys = new Set<string>();
  let running = false;
  let lastTick = performance.now(), lastStatus = 0;

  const placeOnSurface = (s: Surface, aboveGround: number) => {
    const ground = groundUnder(s.up);
    apply(cameraFrame(s, bodyRadius + ground + aboveGround));
  };
  const status = (force = false) => {
    const now = performance.now();
    if (!options.onSurface || (!force && now - lastStatus < 100)) return;
    lastStatus = now;
    if (!surface) { options.onSurface(null); return; }
    const c = ellipsoid.cartesianToCartographic(new Cesium.Cartesian3(surface.up.x * bodyRadius, surface.up.y * bodyRadius, surface.up.z * bodyRadius));
    options.onSurface({
      headingDeg: headingDeg(surface) ?? null, pitchDeg: surface.pitch * 180 / Math.PI,
      latitude: c ? Cesium.Math.toDegrees(c.latitude) : NaN, longitude: c ? Cesium.Math.toDegrees(c.longitude) : NaN,
      groundM: groundUnder(surface.up),
      fovDeg: (frustum().fov ?? defaultFov) * 180 / Math.PI,
      moving: [...keys].some(k => k in MOVE_KEYS), transition: transition?.kind ?? null,
      exitProgress: Math.min(1, exitPush / EXIT_SCROLL),
    });
  };

  /** Descend from the current view to eye height, turning to face the horizon. */
  const enterSurface = (at?: Cesium.Cartographic) => {
    if (options.surfaceAllowed && !options.surfaceAllowed()) return;
    camera.cancelFlight();
    const f = read();
    let s = fromCamera(f.position, f.direction, f.up);
    if (at) {
      const p = ellipsoid.cartographicToCartesian(new Cesium.Cartographic(at.longitude, at.latitude, 0));
      const up = normalize(p);
      s = { up, fwd: horizontal(s.fwd, up) ?? horizontal(f.up, up) ?? s.fwd, pitch: s.pitch };
    }
    const h0 = Math.max(EYE_HEIGHT_M, magnitude(f.position) - bodyRadius - groundUnder(s.up));
    const duration = Math.min(2.2, Math.max(1.2, 0.9 + 0.3 * Math.log10(h0 / EYE_HEIGHT_M)));
    surface = s;
    transition = { kind: "enter", t0: performance.now(), duration, from: s, h0 };
    status(true);
  };

  /** Rise back to orbit view; `animate=false` switches at once (before a programmed flight). */
  const exitSurface = (animate = true) => {
    if (!surface) return;
    exitPush = 0; veil.style.opacity = "0";
    if (!animate) {
      surface = null; transition = null; keys.clear();
      frustum().fov = defaultFov;
      status(true);
      return;
    }
    if (transition?.kind === "exit") return;
    const h0 = Math.max(EYE_HEIGHT_M, magnitude(camera.positionWC) - bodyRadius - groundUnder(surface.up));
    transition = { kind: "exit", t0: performance.now(), duration: 1.2, from: surface, h0, fov0: frustum().fov ?? defaultFov };
    status(true);
  };

  const travelTo = (target: Cesium.Cartographic) => {
    if (!surface) return;
    const p = ellipsoid.cartographicToCartesian(new Cesium.Cartographic(target.longitude, target.latitude, 0));
    const path = travel(surface, p);
    const metres = path.angle * bodyRadius;
    if (metres < 0.5) return;
    transition = { kind: "travel", t0: performance.now(), duration: JUMP_SECONDS, path, metres, jumped: false };
    status(true);
  };

  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (!surface) return;
    if (transition) {
      const f = Math.min(1, (now - transition.t0) / (transition.duration * 1000)), e = easeInOut(f);
      if (transition.kind === "enter") {
        const { from, h0 } = transition;
        surface = { ...from, pitch: from.pitch + (ARRIVAL_PITCH - from.pitch) * e };
        placeOnSurface(surface, Math.exp(Math.log(h0) + (Math.log(EYE_HEIGHT_M) - Math.log(h0)) * e));
      } else if (transition.kind === "exit") {
        const { from, h0, fov0 } = transition;
        surface = { ...from, pitch: from.pitch + (EXIT_PITCH - from.pitch) * e };
        frustum().fov = fov0 + (defaultFov - fov0) * e;
        placeOnSurface(surface, Math.exp(Math.log(h0) + (Math.log(EXIT_ALTITUDE_M) - Math.log(h0)) * e));
      } else {
        // A quick jump, like a street-level panorama: fade out, move, fade in. The view direction
        // is carried along the ground; looking around meanwhile is kept.
        if (!transition.jumped && f >= JUMP_AT) {
          transition.jumped = true;
          surface = { ...transition.path.at(1), pitch: surface.pitch };
        }
        veil.style.opacity = String(f < JUMP_AT ? f / JUMP_AT : 1 - (f - JUMP_AT) / (1 - JUMP_AT));
        placeOnSurface(surface, EYE_HEIGHT_M);
        if (f >= 1) veil.style.opacity = "0";
      }
      if (f >= 1) {
        const finished = transition.kind;
        transition = null;
        if (finished === "exit") { surface = null; status(true); return; }
      }
      status(f >= 1);
      return;
    }
    let forward = 0, right = 0;
    for (const k of keys) { const m = MOVE_KEYS[k]; if (m) { forward += m[0]; right += m[1]; } }
    const norm = Math.hypot(forward, right);
    if (norm > 0) {
      const step = (running ? RUN_SPEED_M_S : WALK_SPEED_M_S) * dt / norm;
      surface = walk(surface, forward * step, right * step, bodyRadius);
    }
    // Re-seat every frame: terrain detail under the camera can refine after arrival.
    placeOnSurface(surface, EYE_HEIGHT_M);
    status();
  };
  scene.preRender.addEventListener(tick);

  // ---------------------------------------------------------------- input
  const center = () => { exitSurface(false); camera.cancelFlight(); apply(centerFrame(read().position)); };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    camera.cancelFlight();
    if (transition?.kind === "travel" && !transition.jumped) { transition = null; veil.style.opacity = "0"; } // grabbing the view cancels a jump
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    // Input timestamps: when the user pressed, not when a busy page got round to handling it.
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button,
      x0: event.clientX, y0: event.clientY, t0: event.timeStamp });
  };
  const pointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    const height = Math.max(canvas.clientHeight, 1);
    if (surface) {
      if (transition?.kind === "enter" || transition?.kind === "exit") return;
      if (event.pointerType === "touch" && pointers.size === 2) {
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        if (before > 1 && after > 1) zoomLens(Math.log(before / after) / 0.0015);
      } else {
        // Grab the view: the ground follows the pointer, as in a street-level panorama.
        const perPixel = (frustum().fovy ?? defaultFov) / height;
        surface = look(surface, -dx * perPixel, dy * perPixel);
        placeOnSurface(surface, EYE_HEIGHT_M);
        status();
      }
      pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
      return;
    }
    const frame = read();
    const angularScale = Math.PI / height;
    if (event.pointerType === "touch" && pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (before > 1 && after > 1) zoomBy(before / after);
    } else if (previous.button === 2) {
      apply(event.shiftKey ? rollFrame(frame, dx * angularScale) : lookFrame(frame, dx * angularScale, dy * angularScale));
    } else {
      const radius = magnitude(frame.position);
      // Grab and spin the Moon: the ground under the pointer follows it, in both directions.
      // One pixel spans 2·tan(fovy/2)/height of the view at the ground below, which is a
      // rotation of that distance / bodyRadius about the Moon's centre.
      const above = Math.max(minAltitude, radius - bodyRadius - groundUnder(frame.position));
      const scale = grabScale(frustum().fovy ?? defaultFov, height, above, bodyRadius);
      const next = orbitFrame(frame, -dx * scale, -dy * scale);
      // Preserve the shell radius: stop at a loaded mountain instead of
      // raising or translating the camera while the user is orbiting.
      if (magnitude(next.position) >= bodyRadius + minimumAltitudeAt(next.position)) apply(next);
    }
    pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
  };
  const pointerEnd = (event: PointerEvent) => {
    const press = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    // A short, still press in surface view is a click: travel there.
    if (event.type !== "pointerup" || !press || !surface || transition || press.button !== 0 || pointers.size) return;
    if (Math.hypot(event.clientX - press.x0, event.clientY - press.y0) > CLICK_PIXELS || event.timeStamp - press.t0 > CLICK_MS) return;
    if (options.clickTravelEnabled && !options.clickTravelEnabled()) return;
    const rect = canvas.getBoundingClientRect();
    const target = options.pickSurface?.(new Cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top));
    if (target) travelTo(target);
  };

  /** Orbit zoom, measured from the ground below; zooming in past ENTER_ALTITUDE_M stands on the surface. */
  const zoomBy = (factor: number) => {
    const frame = read();
    const ground = groundUnder(frame.position);
    const above = magnitude(frame.position) - bodyRadius - ground;
    const next = Math.max(minAltitude, Math.min(maxAltitude, Math.max(above, minAltitude) * factor));
    if (factor < 1 && next < ENTER_ALTITUDE_M && (!options.surfaceAllowed || options.surfaceAllowed())) {
      enterSurface();
      return;
    }
    const unit = Cesium.Cartesian3.normalize(Cesium.Cartesian3.clone(camera.positionWC), new Cesium.Cartesian3());
    apply({ ...frame, position: Cesium.Cartesian3.multiplyByScalar(unit, bodyRadius + ground + next, new Cesium.Cartesian3()) });
  };
  /** Surface zoom: narrow the lens; widening past the normal lens rises back to orbit view. */
  const zoomLens = (delta: number) => {
    const fov = frustum().fov ?? defaultFov;
    const now = performance.now();
    if (now - lastExitPush > EXIT_SCROLL_IDLE_MS) exitPush = 0;      // a pause starts the count again
    if (delta < 0) { exitPush = 0; frustum().fov = Math.max(MIN_FOV, fov * Math.exp(delta * 0.0015)); }
    else if (fov < defaultFov * 0.999) frustum().fov = Math.min(defaultFov, fov * Math.exp(delta * 0.0015));
    else {
      // At the normal lens, only a long, deliberate scroll out leaves (or the button, or Esc).
      exitPush += delta; lastExitPush = now;
      if (exitPush >= EXIT_SCROLL) { exitSurface(); return; }
    }
    status(true);
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    camera.cancelFlight();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    if (surface) { if (!transition || transition.kind === "travel") zoomLens(delta); return; }
    zoomBy(Math.exp(delta * 0.0015));
  };
  const contextMenu = (event: Event) => event.preventDefault();
  const keyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (surface) {
      running = event.shiftKey;
      if (event.code in MOVE_KEYS) { event.preventDefault(); keys.add(event.code); if (transition?.kind === "travel" && !transition.jumped) { transition = null; veil.style.opacity = "0"; } status(true); }
      else if (event.key === "Escape") { event.preventDefault(); exitSurface(); }
      return;
    }
    if (event.key.toLowerCase() === "r") { event.preventDefault(); center(); }
  };
  const keyUp = (event: KeyboardEvent) => { running = event.shiftKey; keys.delete(event.code); status(true); };
  const blur = () => { keys.clear(); running = false; };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerEnd);
  canvas.addEventListener("pointercancel", pointerEnd);
  canvas.addEventListener("lostpointercapture", pointerEnd);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", contextMenu);
  canvas.addEventListener("keydown", keyDown);
  canvas.addEventListener("keyup", keyUp);
  canvas.addEventListener("blur", blur);

  return {
    center,
    /** Stand on the surface below the camera, or at `at`. */
    enterSurface,
    exitSurface,
    isSurface: () => surface !== null,
    /** In surface view, turn to face an azimuth/elevation (degrees); ignored during transitions. */
    lookAt(azimuthDeg: number, elevationDeg: number) {
      if (!surface || (transition && transition.kind !== "travel")) return;
      surface = facing(surface, azimuthDeg, elevationDeg);
      placeOnSurface(surface, EYE_HEIGHT_M);
      status();
    },
    destroy() {
      scene.preRender.removeEventListener(tick);
      for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pointers.clear();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerEnd);
      canvas.removeEventListener("pointercancel", pointerEnd);
      canvas.removeEventListener("lostpointercapture", pointerEnd);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("contextmenu", contextMenu);
      canvas.removeEventListener("keydown", keyDown);
      canvas.removeEventListener("keyup", keyUp);
      canvas.removeEventListener("blur", blur);
      veil.remove();
      canvas.style.touchAction = oldTouchAction;
      if (oldTabIndex === null) canvas.removeAttribute("tabindex"); else canvas.setAttribute("tabindex", oldTabIndex);
    },
  };
}
