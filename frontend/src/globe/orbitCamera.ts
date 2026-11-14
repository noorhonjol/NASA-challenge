import * as Cesium from "cesium";
import { centerFrame, lookFrame, magnitude, orbitFrame, rollFrame, zoomFrame, type CameraFrame } from "./orbitCameraMath";

/** Fixed-radius body-centered orbit; free-look and roll never translate the camera. */
export function setupOrbitCamera(viewer: Cesium.Viewer, ellipsoid: Cesium.Ellipsoid) {
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
  const pointers = new Map<number, { x: number; y: number; button: number }>();
  const minimumAltitudeAt = (position: {x: number; y: number; z: number}) => {
    const cartographic = ellipsoid.cartesianToCartographic(new Cesium.Cartesian3(position.x, position.y, position.z));
    const ground = cartographic ? scene.globe.getHeight(cartographic) : undefined;
    return Math.max(minAltitude, (ground ?? 0) + 40);
  };

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
  const center = () => { camera.cancelFlight(); apply(centerFrame(read().position)); };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    camera.cancelFlight();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
  };
  const pointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    const frame = read();
    const height = Math.max(canvas.clientHeight, 1);
    const angularScale = Math.PI / height;
    if (event.pointerType === "touch" && pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (before > 1 && after > 1) apply(zoomFrame(frame, before / after, bodyRadius, minimumAltitudeAt(frame.position), maxAltitude));
    } else if (previous.button === 2) {
      apply(event.shiftKey ? rollFrame(frame, dx * angularScale) : lookFrame(frame, dx * angularScale, dy * angularScale));
    } else {
      const radius = magnitude(frame.position);
      // Scale orbit sensitivity by altitude, keeping close-up motion controllable.
      const scale = angularScale * Math.max(0.00002, Math.min(1, (radius - bodyRadius) / radius));
      const next = orbitFrame(frame, dx * scale, dy * scale);
      // Preserve the shell radius: stop at a loaded mountain instead of
      // raising or translating the camera while the user is orbiting.
      if (magnitude(next.position) >= bodyRadius + minimumAltitudeAt(next.position)) apply(next);
    }
    pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
  };
  const pointerEnd = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    camera.cancelFlight();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    const frame = read();
    apply(zoomFrame(frame, Math.exp(delta * 0.0015), bodyRadius, minimumAltitudeAt(frame.position), maxAltitude));
  };
  const contextMenu = (event: Event) => event.preventDefault();
  const keyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); center();
    }
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerEnd);
  canvas.addEventListener("pointercancel", pointerEnd);
  canvas.addEventListener("lostpointercapture", pointerEnd);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", contextMenu);
  canvas.addEventListener("keydown", keyDown);

  return { center, destroy() {
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
    canvas.style.touchAction = oldTouchAction;
    if (oldTabIndex === null) canvas.removeAttribute("tabindex"); else canvas.setAttribute("tabindex", oldTabIndex);
  } };
}
