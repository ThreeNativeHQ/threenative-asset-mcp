"""Reduced stand-in for the upstream ``uasset/mesh.py`` colour transport and ``export_glb``.

The installed converter is GPL and absent on a CI host, so this fixture mirrors the exact regions the
exported ``patchUncookedMeshColorExport`` anchors on and writes a real GLB without pygltflib. Keep the
anchor lines byte-for-byte identical to the installed source; the patch's ``replaceRequired`` throws if
they drift.
"""

import json
import struct
from typing import Dict, List, Optional, Tuple

import numpy as np


class _Accessor:
    def __init__(self, **kwargs):
        self.bufferView = kwargs.get('bufferView')
        self.byteOffset = kwargs.get('byteOffset', 0)
        self.componentType = kwargs.get('componentType')
        self.count = kwargs.get('count')
        self.type = kwargs.get('type')
        self.normalized = kwargs.get('normalized', False)
        self.min = kwargs.get('min')
        self.max = kwargs.get('max')


class _Attributes:
    def __init__(self):
        self.POSITION = None
        self.NORMAL = None
        self.TEXCOORD_0 = None
        self.COLOR_0 = None


class _Primitive:
    def __init__(self):
        self.attributes = _Attributes()
        self.indices = None


class StaticMesh:
    def __init__(self):
        self.vertices: List[Tuple[float, float, float]] = []
        self.normals: List[Tuple[float, float, float]] = []
        self.uvs: List[List[Tuple[float, float]]] = []  # list of UV channels
        self.triangles: List[Tuple[int, int, int, int]] = []
        self.vi_to_vertex: List[int] = []
        self.material_slot_names: Optional[List[Optional[str]]] = None

    @classmethod
    def from_package(cls, geo):
        mesh = cls()
        if geo is not None and geo.get('vertices'):
            try:
                mesh.vertices = geo['vertices']
                mesh.vi_to_vertex = geo['vi_to_vertex']
                mesh.normals = geo['normals']
                mesh.uvs = geo['uvs']
                mesh.triangles = geo['triangles']
                mesh.material_slot_names = geo.get('material_slot_names')
                return mesh
            except Exception:
                pass
        return mesh


def _jsonable(value):
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items() if item is not None}
    return value


def export_glb(mesh: StaticMesh, filepath: str):
    binary = bytearray()
    buffer_views: list = []
    accessors: list = []
    primitives: list = []

    def _pad4():
        rem = len(binary) % 4
        if rem:
            binary.extend(bytes(4 - rem))

    def _add_buffer_view(data: bytes, target=None) -> int:
        _pad4()
        offset = len(binary)
        binary.extend(data)
        view = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)}
        if target is not None:
            view['target'] = target
        buffer_views.append(view)
        return len(buffer_views) - 1

    def _add_accessor(bv_idx: int, component_type: int, count: int,
                      acc_type: str, min_vals=None, max_vals=None) -> int:
        accessors.append(_Accessor(bufferView=bv_idx, byteOffset=0, componentType=component_type,
                                   count=count, type=acc_type, min=min_vals, max=max_vals))
        return len(accessors) - 1

    ARRAY_BUFFER = 34962
    ELEMENT_ARRAY_BUFFER = 34963
    COMP_FLOAT = 5126
    COMP_UNSIGNED_SHORT = 5123
    COMP_UNSIGNED_INT = 5125

    uvs = mesh.uvs[0] if mesh.uvs else []
    has_normals = bool(mesh.normals)
    has_uvs = bool(uvs)

    for _mat_idx in [0]:
        tris = mesh.triangles
        vi_to_local: dict = {}
        local_verts: list = []
        indices: list = []

        for tri in tris:
            for vi in (tri[0], tri[1], tri[2]):
                if vi not in vi_to_local:
                    v_idx = mesh.vi_to_vertex[vi] if vi < len(mesh.vi_to_vertex) else vi
                    pos = mesh.vertices[v_idx] if v_idx < len(mesh.vertices) else (0.0, 0.0, 0.0)
                    px, py, pz = pos[1], pos[2], -pos[0]

                    if has_normals and vi < len(mesh.normals):
                        n = mesh.normals[vi]
                        nx, ny, nz = n[1], n[2], -n[0]
                    else:
                        nx, ny, nz = 0.0, 1.0, 0.0

                    if has_uvs and vi < len(uvs):
                        u, v = uvs[vi]
                    else:
                        u, v = 0.0, 0.0

                    local_verts.append((px, py, pz, nx, ny, nz, u, v))
                    vi_to_local[vi] = len(local_verts) - 1

                indices.append(vi_to_local[vi])

        if not local_verts:
            continue

        num_verts = len(local_verts)
        pos_arr = np.array([(v[0], v[1], v[2]) for v in local_verts], dtype=np.float32)
        norm_arr = np.array([(v[3], v[4], v[5]) for v in local_verts], dtype=np.float32)
        uv_arr = np.array([(v[6], v[7]) for v in local_verts], dtype=np.float32)

        idx_arr = np.array(indices, dtype=np.uint16)

        prim = _Primitive()
        pos_bv = _add_buffer_view(pos_arr.tobytes(), target=ARRAY_BUFFER)
        pos_acc = _add_accessor(pos_bv, COMP_FLOAT, num_verts, "VEC3",
                                pos_arr.min(axis=0).tolist(), pos_arr.max(axis=0).tolist())
        prim.attributes.POSITION = pos_acc

        norm_acc = None
        if has_normals:
            norm_bv = _add_buffer_view(norm_arr.tobytes(), target=ARRAY_BUFFER)
            norm_acc = _add_accessor(norm_bv, COMP_FLOAT, num_verts, "VEC3")
            prim.attributes.NORMAL = norm_acc

        # UV accessor
        uv_acc = None
        if has_uvs:
            uv_bv = _add_buffer_view(uv_arr.tobytes(), target=ARRAY_BUFFER)
            uv_acc = _add_accessor(uv_bv, COMP_FLOAT, num_verts, "VEC2")

        # Index accessor
        idx_bv = _add_buffer_view(idx_arr.tobytes(), target=ELEMENT_ARRAY_BUFFER)
        idx_acc = _add_accessor(idx_bv, COMP_UNSIGNED_SHORT, len(indices), "SCALAR")

        if uv_acc is not None:
            prim.attributes.TEXCOORD_0 = uv_acc
        prim.indices = idx_acc

        primitives.append(prim)

    gltf = {
        'asset': {'version': '2.0'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [
            {'attributes': _jsonable(prim.attributes.__dict__), 'indices': prim.indices}
            for prim in primitives
        ]}],
        'accessors': [prim_acc for prim_acc in (_jsonable(acc.__dict__) for acc in accessors)],
        'bufferViews': buffer_views,
        'buffers': [{'byteLength': len(binary)}],
    }

    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_bytes += b' ' * ((4 - len(json_bytes) % 4) % 4)
    bin_bytes = bytes(binary)
    bin_bytes += bytes((4 - len(bin_bytes) % 4) % 4)

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with open(filepath, 'wb') as handle:
        handle.write(struct.pack('<III', 0x46546C67, 2, total))
        handle.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
        handle.write(json_bytes)
        handle.write(struct.pack('<II', len(bin_bytes), 0x004E4942))
        handle.write(bin_bytes)
