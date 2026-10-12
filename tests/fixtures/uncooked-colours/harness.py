"""Synthetic geometry -> StaticMesh -> GLB driver for the uncooked vertex-colour and UV patch tests.

Builds MeshDescription dicts shaped like the real parser's output, runs the patched ``extract_geometry``
and the patched ``StaticMesh.from_package``/``export_glb`` (a reduced writer stand-in), and writes a GLB.

The vertex-instance ids are sparse and *ascending* (``_allocated_indices`` yields them in bit order), and
the ``Color`` attribute is a ``TArray`` indexed by vertex-instance ID with its holes retained: the
serialized array spans the allocated slots (including trailing holes), not the live instances. Modes
therefore exercise a valid sparse buffer, its absence, a wrong attribute type and a truncated array.

The ``uv-*`` modes exercise the TextureCoordinate arrays the same way: one array per UV channel, each
indexed by vertex-instance ID over the allocated slots. A refused export prints ``{"error": ...}`` instead
of writing a GLB, so the caller can assert on the refusal rather than on a crash.

The ``uv-none-*`` modes carry no UV channel at all, so only the position path can refuse their bad instance or mapping.

There is deliberately no sparse-channel mode (channels 0, 1 and 7 with 2..6 absent). The native
``TMeshAttributeArraySet`` stores its channels as one dense array (``ArrayForChannels``, UE 5.8.3
``MeshAttributeArray.h``), so a producer cannot express a hole in the channel index space; the C# writer
test covers supplied indices instead.
"""

import json
import struct
import sys

import upstream
import writer

UV_SLOTS = 12
UV_CHANNELS = 8


def attr(kind, per_elem, num_elements, values):
    data = struct.pack('<%df' % len(values), *values)
    entry = {'type': kind, 'arrays': [{'data': data, 'count': len(values) // per_elem, 'elem_size': per_elem * 4}]}
    if num_elements is not None:
        entry['num_elements'] = num_elements
    return entry


def colour_attr(slots):
    """A Color (FVector4) entry whose serialized array is indexed by vertex-instance ID."""
    return attr(0, 4, len(slots), [channel for slot in slots for channel in slot])


def uv_attr(channels):
    """A TextureCoordinate entry: one array per UV channel, each a FVector2 per allocated vertex instance."""
    arrays = []
    for values in channels:
        data = struct.pack('<%df' % len(values), *values)
        arrays.append({'data': data, 'count': len(values) // 2, 'elem_size': 8})
    return {'type': 2, 'arrays': arrays}


def channel_values(channel, slots):
    """Distinct, exactly representable (multiples of 1/64) coordinates for every channel and slot."""
    values = []
    for slot in range(slots):
        values += [(channel * 16 + slot) / 64.0, (slot * 4 + channel) / 64.0]
    return values


def build_desc(mode):
    # Live vertex-instance ids are sparse and ascending, e.g. [2, 5, 9]. Instance -> vertex id is
    # shuffled so a decoder that indexed colour by vertex rather than by vertex instance would differ.
    vi_ids = [2, 5, 9]
    vi_elems = [1, 0, 2]

    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    vi_attrs = {
        'Normal': attr(1, 3, None, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
        # A UV channel is serialized over every allocated slot, as Normal and Color are; 12 covers the sparse ids.
        'TextureCoordinate': attr(2, 2, None, [0.0, 0.0] * 12),
    }
    triangles = [{'vi': (vi_ids[0], vi_ids[1], vi_ids[2]), 'polygon_id': 0}]
    if mode.startswith('uv-'):
        return uv_desc(mode)
    if mode == 'colour':
        # Allocated slots 0..11 (trailing holes after the last live id 9). Only indices 2, 5 and 9 are
        # live; the holes keep the default so a mis-indexed read lands on white, never on a live colour.
        slots = [(1.0, 1.0, 1.0, 1.0) for _ in range(12)]
        slots[2] = (1.0, 0.5, 0.0, 0.7)
        slots[5] = (0.0, 1.0, 0.25, 0.5)
        slots[9] = (0.2, 0.4, 0.6, 0.9)
        vi_attrs['Color'] = colour_attr(slots)
    elif mode == 'dense':
        # A dense source (live ids 0,1,2) must keep working.
        vi_ids = [0, 1, 2]
        vi_elems = [1, 2, 0]
        vi_attrs['Color'] = colour_attr([(1.0, 0.5, 0.0, 0.7), (0.0, 1.0, 0.25, 0.5), (0.2, 0.4, 0.6, 0.9)])
        triangles = [{'vi': (vi_ids[0], vi_ids[1], vi_ids[2]), 'polygon_id': 0}]
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
        'triangles': triangles,
        'material_slot_names': ['SlotA'],
    }


def uv_desc(mode):
    """MeshDescriptions for the UV channel modes. Live instances are [2, 5, 9] in 12 slots unless noted."""
    vi_ids, vi_elems, slots = [2, 5, 9], [1, 0, 2], UV_SLOTS
    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    normals = [0.0, 0.0, 1.0] * slots
    channels = [channel_values(channel, slots) for channel in range(UV_CHANNELS)]
    triangles = [{'vi': (2, 5, 9), 'polygon_id': 0}]

    if mode == 'uv-seam':
        # Instances 0 and 3 sit on the same vertex with the same normal and UV0, and differ only in UV1.
        vi_ids, vi_elems, slots = [0, 1, 2, 3], [0, 1, 2, 0], 4
        normals = [0.0, 0.0, 1.0] * slots
        uv0 = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        uv1 = [0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.5]
        texcoords = uv_attr([uv0, uv1])
        triangles = [{'vi': (0, 1, 2), 'polygon_id': 0}, {'vi': (3, 2, 1), 'polygon_id': 0}]
    elif mode == 'uv-full':
        texcoords = uv_attr(channels)
    elif mode == 'uv-two':
        texcoords = uv_attr(channels[:2])
    elif mode == 'uv-none':
        texcoords = {'type': 2, 'arrays': []}
    elif mode == 'uv-hole-nan':
        # Slot 0 is a hole (live ids are 2, 5, 9): a non-finite value there is never read, so it is not refused.
        holed = [list(channels[0]), list(channels[1])]
        holed[1][0] = float('nan')
        holed[1][1] = float('nan')
        texcoords = uv_attr(holed)
    elif mode == 'uv-excess':
        texcoords = uv_attr([channel_values(channel, slots) for channel in range(UV_CHANNELS + 1)])
    elif mode == 'uv-short':
        # Channel 1 covers slots 0..5 only, so live instance 9 has no coordinate there.
        texcoords = uv_attr([channels[0], channels[1][:12]])
    elif mode == 'uv-negative':
        # A triangle corner reads -1, which the parser's signed index can carry from a corrupt table. Python would
        # read it from the end of each channel, so the export must refuse rather than substitute the last sample.
        triangles = [{'vi': (2, 5, -1), 'polygon_id': 0}]
        texcoords = uv_attr(channels)
    elif mode == 'uv-none-negative':
        # No UV reader runs, so the position path alone must refuse an instance of -1 (Python would read vi_to_vertex[-1]).
        triangles = [{'vi': (2, 5, -1), 'polygon_id': 0}]
        texcoords = {'type': 2, 'arrays': []}
    elif mode == 'uv-none-above':
        # One past the map (instances 0..9): the writer would otherwise zero-fill its position.
        triangles = [{'vi': (2, 5, 10), 'polygon_id': 0}]
        texcoords = {'type': 2, 'arrays': []}
    elif mode == 'uv-none-map-negative':
        # Instance 9 maps to vertex -1, which Python would read as the last vertex.
        vi_elems = [1, 0, -1]
        texcoords = {'type': 2, 'arrays': []}
    elif mode == 'uv-none-map-above':
        # Instance 9 maps to vertex 3 of 3, past the end of the position array.
        vi_elems = [1, 0, 3]
        texcoords = {'type': 2, 'arrays': []}
    elif mode == 'uv-nonfinite':
        # Channel 1 at live instance 5 (slot 5, value index 10) is NaN.
        bad = list(channels[1])
        bad[10] = float('nan')
        texcoords = uv_attr([channels[0], bad])
    else:
        raise SystemExit('unknown uv mode ' + mode)

    return {
        'vertex_ids': [0, 1, 2],
        'vertex_instance_ids': vi_ids,
        'vertex_instance_elements': vi_elems,
        'vertex_attributes': {'attributes': {'Position': attr(1, 3, None, positions)}},
        'vertex_instance_attributes': {'attributes': {'Normal': attr(1, 3, None, normals), 'TextureCoordinate': texcoords}},
        'triangles': triangles,
        'material_slot_names': ['SlotA'],
    }


def main():
    mode, target = sys.argv[1], sys.argv[2]
    geo = upstream.extract_geometry(build_desc(mode))
    mesh = writer.StaticMesh.from_package(geo)
    try:
        writer.export_glb(mesh, target)
    except ValueError as error:
        print(json.dumps({'error': str(error)}))
        return
    print(json.dumps({'colors': len(mesh.colors), 'vertices': len(mesh.vertices), 'uv_channels': len(mesh.uvs)}))


if __name__ == '__main__':
    main()
