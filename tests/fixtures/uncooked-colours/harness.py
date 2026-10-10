"""Synthetic geometry -> StaticMesh -> GLB driver for the uncooked vertex-colour patch test.

Builds MeshDescription dicts shaped like the real parser's output, runs the patched ``extract_geometry``
and the patched ``StaticMesh.from_package``/``export_glb`` (a reduced writer stand-in), and writes a GLB.

The vertex-instance ids are sparse and *ascending* (``_allocated_indices`` yields them in bit order), and
the ``Color`` attribute is a ``TArray`` indexed by vertex-instance ID with its holes retained: the
serialized array spans the allocated slots (including trailing holes), not the live instances. Modes
therefore exercise a valid sparse buffer, its absence, a wrong attribute type and a truncated array.
"""

import json
import struct
import sys

import upstream
import writer


def attr(kind, per_elem, num_elements, values):
    data = struct.pack('<%df' % len(values), *values)
    entry = {'type': kind, 'arrays': [{'data': data, 'count': len(values) // per_elem, 'elem_size': per_elem * 4}]}
    if num_elements is not None:
        entry['num_elements'] = num_elements
    return entry


def colour_attr(slots):
    """A Color (FVector4) entry whose serialized array is indexed by vertex-instance ID."""
    return attr(0, 4, len(slots), [channel for slot in slots for channel in slot])


def build_desc(mode):
    # Live vertex-instance ids are sparse and ascending, e.g. [2, 5, 9]. Instance -> vertex id is
    # shuffled so a decoder that indexed colour by vertex rather than by vertex instance would differ.
    vi_ids = [2, 5, 9]
    vi_elems = [1, 0, 2]

    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    vi_attrs = {
        'Normal': attr(1, 3, None, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
        'TextureCoordinate': attr(2, 2, None, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
    }
    if mode == 'colour':
        # Allocated slots 0..11 (trailing holes after the last live id 9). Only indices 2, 5 and 9 are
        # live; the holes keep the default so a mis-indexed read lands on white, never on a live colour.
        slots = [(1.0, 1.0, 1.0, 1.0) for _ in range(12)]
        slots[2] = (1.0, 0.5, 0.0, 0.7)
        slots[5] = (0.0, 1.0, 0.25, 0.35)
        slots[9] = (0.2, 0.4, 0.6, 0.9)
        vi_attrs['Color'] = colour_attr(slots)
    elif mode == 'dense':
        # A dense source (live ids 0,1,2) must keep working.
        vi_ids = [0, 1, 2]
        vi_elems = [1, 2, 0]
        vi_attrs['Color'] = colour_attr([(1.0, 0.5, 0.0, 0.7), (0.0, 1.0, 0.25, 0.35), (0.2, 0.4, 0.6, 0.9)])
    elif mode == 'wrong-type':
        # FVector (3 floats), not the FVector4 the color path requires.
        vi_attrs['Color'] = attr(1, 3, 12, [0.0, 0.0, 0.0] * 12)
    elif mode == 'wrong-count':
        # Declared 12 allocated slots but only 3 serialized: a truncated source, not one to guess at.
        vi_attrs['Color'] = attr(0, 4, 12, [1.0, 1.0, 1.0, 1.0] * 3)

    return {
        'vertex_ids': [0, 1, 2],
        'vertex_instance_ids': vi_ids,
        'vertex_instance_elements': vi_elems,
        'vertex_attributes': {'attributes': {'Position': attr(1, 3, None, positions)}},
        'vertex_instance_attributes': {'attributes': vi_attrs},
        'triangles': [{'vi': (vi_ids[0], vi_ids[1], vi_ids[2]), 'polygon_id': 0}],
        'material_slot_names': ['SlotA'],
    }


def main():
    mode, target = sys.argv[1], sys.argv[2]
    geo = upstream.extract_geometry(build_desc(mode))
    mesh = writer.StaticMesh.from_package(geo)
    writer.export_glb(mesh, target)
    print(json.dumps({'colors': len(mesh.colors), 'vertices': len(mesh.vertices)}))


if __name__ == '__main__':
    main()
