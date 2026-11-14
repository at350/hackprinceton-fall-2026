# Cortex export

Offline tooling only. Install these Python dependencies in a scratch environment outside the repository; none are app/runtime dependencies.

```sh
python3 -m venv /tmp/lucid-brain-export
/tmp/lucid-brain-export/bin/pip install -r tools/brain-export/requirements.txt
/tmp/lucid-brain-export/bin/python tools/brain-export/export_fs6.py /tmp/closed-cortex.json --cache /tmp/nilearn
node tools/brain-export/bake-cortex.ts /tmp/closed-cortex.json public/models/fsaverage6.bin.gz
```

The exporter downloads the real FreeSurfer fsaverage6 pial hemispheres through Nilearn, fits the head coordinate frame, voxelizes each closed surface, applies morphological closing, extracts a watertight surface with marching cubes, and decimates it. Alternating smoothing removes voxel-scale steps without introducing a new fold pattern. The original hemisphere bounds and asymmetry are retained. Export rejects open, inward-facing, self-intersecting or oversized meshes.

Node 26 executes the TypeScript baker directly. It maps final positions into dashboard coordinates, computes smooth normals and local cavity occlusion, then packs final positions and triangle indices as uint16 plus cavity as uint8. There are no source meshes, procedural seeds, inflation targets, or runtime deformation fields in the shipped payload. Next serves the file with `Content-Encoding: gzip`, which browser fetch transparently decodes.

The `LUCIDC01` layout is an 8-byte magic followed by two hemispheres. Each has uint32 vertex/triangle counts, six float32 bounds (minimum xyz, extent xyz), quantized xyz positions, triangle indices, one cavity byte per vertex, then padding to a 4-byte boundary. Tests validate decoding and require every edge in the shipped mesh to belong to exactly two triangles.

The modified dataset's provenance and full licence are in `public/models/FREESURFER-LICENSE.txt`.
