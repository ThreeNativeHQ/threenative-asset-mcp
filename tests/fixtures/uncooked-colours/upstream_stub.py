"""Reduced stand-in for the upstream ``uasset/uncooked_mesh.py`` ``extract_geometry``.

The uncooked converter is GPL and installed at provision time, so a CI host has no copy. This fixture
mirrors the exact regions the exported patch functions anchor on, so the test can apply the real patch
code and run the decoder without provisioning the converter. Keep the anchor comments and the return
dict's ``normals``/``uvs`` lines byte-for-byte identical to the installed source; the patch's
``replaceRequired`` throws if they drift.
"""

import struct
from typing import List


def _bulk_floats(entry, per_elem):
    arr = entry['arrays'][0]
    raw = arr['data']
    count = arr['count']
    fmt = '<%df' % (count * per_elem)
    flat = struct.unpack(fmt, raw[:count * per_elem * 4])
    return [tuple(flat[i * per_elem:(i + 1) * per_elem]) for i in range(count)]


def extract_geometry(desc):
    if desc is None:
        return None

    v_attrs = desc['vertex_attributes']['attributes']
    vi_attrs = desc['vertex_instance_attributes']['attributes']

    positions = []
    pos_entry = v_attrs.get('Position')
    if pos_entry is None or pos_entry['type'] != 1 or not pos_entry['arrays']:
        return None
    positions = _bulk_floats(pos_entry, 3)

    vi_ids = desc['vertex_instance_ids']
    vi_elems = desc['vertex_instance_elements']
    max_vi = (max(vi_ids) + 1) if vi_ids else 0
    vi_to_vertex: List[int] = [0] * max_vi
    for sparse_id, v in zip(vi_ids, vi_elems):
        vi_to_vertex[sparse_id] = v

    # --- Normals (per vertex instance, FVector) ---
    normals = []
    normal_entry = vi_attrs.get('Normal')
    if normal_entry and normal_entry['type'] == 1 and normal_entry['arrays']:
        normals = _bulk_floats(normal_entry, 3)

    # --- UV channels (per vertex instance, FVector2D) ---
    uv_channels = []
    uv_entry = vi_attrs.get('TextureCoordinate')
    if uv_entry and uv_entry['type'] == 2 and uv_entry['arrays']:
        for idx_arr in uv_entry['arrays']:
            raw = idx_arr['data']
            count = idx_arr['count']
            flat = struct.unpack_from('<%df' % (count * 2), raw[:count * 8])
            uv_channels.append([(flat[i * 2], flat[i * 2 + 1]) for i in range(count)])

    triangles = [(t['vi'][0], t['vi'][1], t['vi'][2], 0) for t in desc.get('triangles') or []]

    return {
        'vertices': positions,
        'vi_to_vertex': vi_to_vertex,
        'normals': normals,
        'uvs': uv_channels,
        'triangles': triangles,
        'material_slot_names': desc.get('material_slot_names') or [],
    }
