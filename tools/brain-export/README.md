# Cortex export

Offline tooling only. These Python dependencies are not app/runtime dependencies; create the environment in a scratch directory outside this repository.

```sh
python3 -m venv /tmp/lucid-brain-export
/tmp/lucid-brain-export/bin/pip install -r tools/brain-export/requirements.txt
/tmp/lucid-brain-export/bin/python tools/brain-export/export_fs6.py /tmp/fs6-source.bin --cache /tmp/nilearn
node tools/brain-export/bake-cortex.ts /tmp/fs6-source.bin public/models/fsaverage6.bin.gz
```

Node 26 executes the framework-free TypeScript directly. The first stage downloads FreeSurfer fsaverage6 via Nilearn and quantizes pial/inflated coordinates, indices, and sulcal depth. The second stage runs the same default deformation as the Worker, bakes final positions and cavity, then gzip-compresses the asset. Next serves it with `Content-Encoding: gzip`, so browser fetch transparently decodes it. Re-bake after changing the geometry algorithm; a unit test checks bake/runtime agreement within quantization error.

The modified dataset's provenance and full licence are in `public/models/FREESURFER-LICENSE.txt`.
