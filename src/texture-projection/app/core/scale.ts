import * as THREE from "three";

import type { Level } from "./scene.js";

/**
 * The real-world distances a paint prompt and the vision check are anchored to (PRD-916 phase 2c):
 * the camera's height above the ground, and how far the surface in the middle of the frame is. An
 * image model that is told only "cobblestone paving" paints cobbles at whatever size fits the frame,
 * so views of the same floor came back at wildly different real sizes (huge blurry stones next to
 * fine ones, with a seam where the views meet). The numbers come from the level's own geometry.
 */
export interface ScaleAnchor {
  /** Metres from the camera down to the ground under it. */
  readonly cameraHeight: number;
  /** Metres from the camera along the view direction to the surface at the image centre. */
  readonly centreDistance: number;
}

/** The parts of a `ViewSpec` the anchor needs, so this module stays independent of the renderer. */
export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly fov: number;
}

/** The way a view looks: yaw 0 down -Z, pitch up from the horizon (the renderer's own convention). */
function direction(yaw: number, pitch: number): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
}

/**
 * Measure one view's anchors by raycasting the level (no render, no model call). A centre ray that
 * misses (sky above a wall top) falls back to the nearest surface inside half the frame, then to the
 * level's own bounding box along that ray, so the number is always a distance in the scene.
 */
export function measureScaleAnchor(level: Level, pose: CameraPose): ScaleAnchor {
  const origin = new THREE.Vector3(...pose.position);
  const down = level.bvh.raycastFirst(new THREE.Ray(origin.clone(), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
  const cameraHeight = Math.max(0.1, down?.distance ?? origin.y - level.bounds.min.y);

  const centre = new THREE.Ray(origin.clone(), direction(pose.yaw, pose.pitch));
  const direct = level.bvh.raycastFirst(centre, THREE.DoubleSide);
  if (direct && direct.distance > 0.05) return { cameraHeight, centreDistance: direct.distance };

  // Sky at the centre: the nearest surface inside half the frame is what the middle of the view shows.
  const half = THREE.MathUtils.degToRad(pose.fov) / 2;
  let nearest = Infinity;
  for (const a of [-0.5, -0.25, 0, 0.25, 0.5]) {
    for (const b of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const hit = level.bvh.raycastFirst(
        new THREE.Ray(origin.clone(), direction(pose.yaw + a * half, pose.pitch + b * half)),
        THREE.DoubleSide,
      );
      if (hit && hit.distance > 0.05 && hit.distance < nearest) nearest = hit.distance;
    }
  }
  if (Number.isFinite(nearest)) return { cameraHeight, centreDistance: nearest };

  const box = centre.intersectBox(level.bounds, new THREE.Vector3());
  return { cameraHeight, centreDistance: box === null ? 20 : Math.max(0.1, origin.distanceTo(box)) };
}
