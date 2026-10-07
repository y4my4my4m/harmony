/**
 * Crop geometry for ImageCropper.
 *
 * Coordinates are image pixels. The "turned" image is the source rotated
 * clockwise by `rotation`; the crop rect lives in turned space and keeps the
 * frame aspect. Zoom 1 is the largest such rect inside the turned image, so
 * the crop never leaves the image and the output has no empty borders.
 */

/** Clockwise, degrees. */
export type Rotation = 0 | 90 | 180 | 270

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** (cx, cy): crop centre in turned-image pixels. */
export interface CropState {
  rotation: Rotation
  zoom: number
  cx: number
  cy: number
}

export const MAX_ZOOM = 10

export function normalizeRotation(degrees: number): Rotation {
  const r = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360
  return r as Rotation
}

export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height }
}

/** Source point to turned point. `size` is the unturned source. */
export function toRotated(p: Point, size: Size, rotation: Rotation): Point {
  switch (rotation) {
    case 90: return { x: size.height - p.y, y: p.x }
    case 180: return { x: size.width - p.x, y: size.height - p.y }
    case 270: return { x: p.y, y: size.width - p.x }
    default: return { x: p.x, y: p.y }
  }
}

/** Turned point to source point. `size` is the unturned source. */
export function fromRotated(p: Point, size: Size, rotation: Rotation): Point {
  switch (rotation) {
    case 90: return { x: p.y, y: size.height - p.x }
    case 180: return { x: size.width - p.x, y: size.height - p.y }
    case 270: return { x: size.width - p.y, y: p.x }
    default: return { x: p.x, y: p.y }
  }
}

/** Crop size at zoom 1: the largest `aspect` (width / height) rect inside `turned`. */
export function baseCropSize(turned: Size, aspect: number): Size {
  const width = Math.min(turned.width, turned.height * aspect)
  return { width, height: width / aspect }
}

/** Crop rect in turned-image pixels. */
export function cropRect(state: CropState, size: Size, aspect: number): Rect {
  const base = baseCropSize(rotatedSize(size, state.rotation), aspect)
  const width = base.width / state.zoom
  const height = base.height / state.zoom
  return { x: state.cx - width / 2, y: state.cy - height / 2, width, height }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Zoom within [1, maxZoom]; centre such that the crop stays inside the turned image. */
export function clampCrop(state: CropState, size: Size, aspect: number, maxZoom = MAX_ZOOM): CropState {
  const turned = rotatedSize(size, state.rotation)
  const zoom = clampNumber(Number.isFinite(state.zoom) ? state.zoom : 1, 1, Math.max(1, maxZoom))
  const base = baseCropSize(turned, aspect)
  const halfW = base.width / zoom / 2
  const halfH = base.height / zoom / 2
  const cx = turned.width - 2 * halfW <= 0 ? turned.width / 2 : clampNumber(state.cx, halfW, turned.width - halfW)
  const cy = turned.height - 2 * halfH <= 0 ? turned.height / 2 : clampNumber(state.cy, halfH, turned.height - halfH)
  return { rotation: state.rotation, zoom, cx, cy }
}

export function initialCrop(size: Size, rotation: Rotation = 0): CropState {
  const turned = rotatedSize(size, rotation)
  return { rotation, zoom: 1, cx: turned.width / 2, cy: turned.height / 2 }
}

/**
 * Largest zoom that keeps the crop at least `minCropWidth` source pixels wide,
 * within [1, MAX_ZOOM].
 */
export function maxZoomFor(size: Size, aspect: number, minCropWidth: number, rotation: Rotation = 0): number {
  const base = baseCropSize(rotatedSize(size, rotation), aspect)
  return clampNumber(base.width / Math.max(1, minCropWidth), 1, MAX_ZOOM)
}

/**
 * Drags the image by (dx, dy) frame pixels; the image follows the pointer.
 * `framePxPerImagePx` is the frame width over the crop width.
 */
export function panCrop(
  state: CropState,
  dx: number,
  dy: number,
  framePxPerImagePx: number,
  size: Size,
  aspect: number,
  maxZoom = MAX_ZOOM,
): CropState {
  const scale = framePxPerImagePx > 0 ? framePxPerImagePx : 1
  return clampCrop({ ...state, cx: state.cx - dx / scale, cy: state.cy - dy / scale }, size, aspect, maxZoom)
}

/**
 * Sets the zoom keeping the image point under `anchor` fixed. `anchor` is in
 * frame units: (0, 0) top-left, (1, 1) bottom-right.
 */
export function zoomCrop(
  state: CropState,
  zoom: number,
  anchor: Point,
  size: Size,
  aspect: number,
  maxZoom = MAX_ZOOM,
): CropState {
  const before = cropRect(state, size, aspect)
  const target = clampNumber(zoom, 1, Math.max(1, maxZoom))
  const px = before.x + anchor.x * before.width
  const py = before.y + anchor.y * before.height
  const width = before.width * (state.zoom / target)
  const height = before.height * (state.zoom / target)
  const next = {
    rotation: state.rotation,
    zoom: target,
    cx: px - anchor.x * width + width / 2,
    cy: py - anchor.y * height + height / 2,
  }
  return clampCrop(next, size, aspect, maxZoom)
}

/** Turns by `delta` degrees; the image point at the crop centre stays at the centre where it fits. */
export function rotateCrop(
  state: CropState,
  delta: 90 | -90,
  size: Size,
  aspect: number,
  maxZoom = MAX_ZOOM,
): CropState {
  const rotation = normalizeRotation(state.rotation + delta)
  const source = fromRotated({ x: state.cx, y: state.cy }, size, state.rotation)
  const centre = toRotated(source, size, rotation)
  return clampCrop({ rotation, zoom: state.zoom, cx: centre.x, cy: centre.y }, size, aspect, maxZoom)
}

/** Crop rect in unturned source pixels; quarter turns keep it axis-aligned. */
export function sourceRect(state: CropState, size: Size, aspect: number): Rect {
  const r = cropRect(state, size, aspect)
  const a = fromRotated({ x: r.x, y: r.y }, size, state.rotation)
  const b = fromRotated({ x: r.x + r.width, y: r.y + r.height }, size, state.rotation)
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/**
 * Output pixel size. `target` fixes the size and is scaled down to the crop
 * when the crop has fewer pixels (no upscaling); without a target the crop's
 * own size is used, long edge capped at `maxEdge`.
 */
export function outputSize(crop: Size, target: Size | null, maxEdge = 4096): Size {
  const box = target ?? crop
  const scale = Math.min(1, crop.width / box.width, maxEdge / Math.max(box.width, box.height))
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
  }
}

/** True when the crop is the whole unturned image. */
export function isIdentityCrop(state: CropState, size: Size, aspect: number): boolean {
  if (state.rotation !== 0 || Math.abs(state.zoom - 1) > 1e-6) return false
  const r = cropRect(state, size, aspect)
  return Math.abs(r.width - size.width) < 0.5 && Math.abs(r.height - size.height) < 0.5
}

/** Turned-image point to crop-relative units: (0, 0) top-left, (1, 1) bottom-right of the crop. */
export function toCropUnits(p: Point, state: CropState, size: Size, aspect: number): Point {
  const r = cropRect(state, size, aspect)
  return { x: (p.x - r.x) / r.width, y: (p.y - r.y) / r.height }
}

/** Crop-relative units to a turned-image point. */
export function fromCropUnits(p: Point, state: CropState, size: Size, aspect: number): Point {
  const r = cropRect(state, size, aspect)
  return { x: r.x + p.x * r.width, y: r.y + p.y * r.height }
}

/**
 * A point in crop units of one crop expressed in crop units of another crop
 * of the same source, clamped to the new crop.
 */
export function remapCropUnits(
  p: Point,
  size: Size,
  from: { state: CropState; aspect: number },
  to: { state: CropState; aspect: number },
): Point {
  const turned = fromCropUnits(p, from.state, size, from.aspect)
  const source = fromRotated(turned, size, from.state.rotation)
  const next = toCropUnits(toRotated(source, size, to.state.rotation), to.state, size, to.aspect)
  return { x: clampNumber(next.x, 0, 1), y: clampNumber(next.y, 0, 1) }
}

/**
 * Canvas transform that draws the unturned source at (0, 0) so the crop fills
 * a `dest` box: [a, b, c, d, e, f] for setTransform.
 */
export function cropDrawMatrix(
  state: CropState,
  size: Size,
  aspect: number,
  dest: Size,
): [number, number, number, number, number, number] {
  const r = cropRect(state, size, aspect)
  const scale = dest.width / r.width
  const centre = fromRotated({ x: state.cx, y: state.cy }, size, state.rotation)
  const theta = (state.rotation * Math.PI) / 180
  const cos = Math.round(Math.cos(theta))
  const sin = Math.round(Math.sin(theta))
  const a = cos * scale
  const b = sin * scale
  const c = -sin * scale
  const d = cos * scale
  return [a, b, c, d, dest.width / 2 - (a * centre.x + c * centre.y), dest.height / 2 - (b * centre.x + d * centre.y)]
}
