/**
 * Minimal public Polyfork metadata fixtures, shaped like live `/api/assets` and
 * `/api/assets/{id}` responses (2026-11-07). They are tiny public metadata rows,
 * not downloaded assets, and are used only to pin the provider contract.
 */
export const POLYFORK_FIXTURE_ID = "cueca-musician-d71a2e";

export function polyforkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POLYFORK_FIXTURE_ID,
    title: "Cueca Musician",
    class: "character",
    triangles: 4055,
    kit: "chile-fiestas-patrias-87e847",
    free: true,
    plan: "free",
    price_usd: 0,
    price_note: "free: every low poly model is.",
    owned: true,
    page: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
    thumbnail: `https://polyfork.dev/files/${POLYFORK_FIXTURE_ID}/renders/hero.png`,
    preview_glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-preview.glb`,
    hd: null,
    preview_triangles: 4055,
    preview_fidelity: 1,
    has_rig: true,
    remixable: true,
    has_night: false,
    has_decals: false,
    has_ik: false,
    ik_type: null,
    has_skeleton: true,
    size_m: { x: 1.61, y: 1.72, z: 0.87 },
    origin_y: 0,
    mass_kg: 65,
    download: {
      glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      mjs: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.mjs`,
      auth: "none",
    },
    ...overrides,
  };
}

export function polyforkDetailPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...polyforkRow(),
    description: "A cantora in a dark floral blouse and long skirt.",
    license:
      "Mesh files (GLB, FBX, USD, OBJ): CC BY 4.0 with the line in `credit`, or the Polyfork licence with no credit and no redistribution, your choice.",
    license_url: null,
    credit: `Cueca Musician by Polyfork (https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}), CC BY 4.0`,
    published_at: "2026-11-07 01:11:56",
    clips: [{ name: "Walk", seconds: 0.97 }],
    clips_note: "inside the .glb and its preview",
    skeleton: {
      bones: 31,
      naming: "Mixamo: Hips, Spine, ...",
      binding: "rigid: one bone per vertex at weight 1",
    },
    rigged_parts: { Head: { axis: "y", range: [0, 35] } },
    materials: 1,
    draw_calls: 8,
    style: "low-poly, flat-shaded vertex colors, no textures",
    origin: "ground level (minY = 0)",
    renders: [
      `https://polyfork.dev/files/${POLYFORK_FIXTURE_ID}/renders/hero.png`,
      `https://polyfork.dev/files/${POLYFORK_FIXTURE_ID}/renders/front.png`,
    ],
    export_formats: {
      fbx: {
        url: `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}.fbx`,
        for: "Unity, Unreal, Maya, 3ds Max",
        available: true,
      },
    },
    access: {
      as: "anonymous",
      remix_bakes_per_hour: 40,
      remix_bakes_left_this_hour: 40,
      a_free_account_adds: { how: "Authorization: Bearer <key>" },
      pro_adds: { url: "https://polyfork.dev/pricing", usd_per_year: 149 },
    },
    ...overrides,
  };
}

export function polyforkSearchPage(
  assets: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { total: assets.length, page: 1, per_page: 24, assets, ...overrides };
}
