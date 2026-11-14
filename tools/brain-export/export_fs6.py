"""Offline-only FreeSurfer fsaverage6 pial closing and watertight remeshing."""
import argparse
import json
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import pymeshlab
import trimesh
from nilearn.datasets import fetch_surf_fsaverage
from scipy import ndimage, sparse
from skimage.measure import marching_cubes
from skimage.morphology import ball

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output")
parser.add_argument("--cache", required=True)
parser.add_argument("--pitch", type=float, default=0.8)
parser.add_argument("--closing", type=float, default=6.0)
parser.add_argument("--expansion", type=float, default=1.6)
args = parser.parse_args()
if args.pitch <= 0 or args.closing < 0 or args.expansion < 0:
    parser.error("Pitch must be positive; closing and expansion must be nonnegative")
started = time.perf_counter()
data = fetch_surf_fsaverage("fsaverage6", data_dir=Path(args.cache))
meshes = {}
for side in ["left", "right"]:
    pial = nib.load(data["pial_" + side])
    meshes[side] = (pial.darrays[0].data.astype(float), pial.darrays[1].data.astype(int))
all_points = np.vstack([v for v, _ in meshes.values()])
center = (all_points.min(0) + all_points.max(0)) / 2
scale = np.array([68.0, 76.0, 60.0]) / ((all_points.max(0) - all_points.min(0)) / 2)
fitted = {side: ((v - center) * scale + [0, 0, 8], f) for side, (v, f) in meshes.items()}
shrink = min(1.0, 77 / max(np.linalg.norm(v, axis=1).max() for v, _ in fitted.values()))
output = {}
for side, (vertices, faces) in fitted.items():
    vertices *= shrink
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    if not mesh.is_watertight:
        raise ValueError("Source cortex is not closed")
    voxels = mesh.voxelized(pitch=args.pitch).fill()
    padding = int(np.ceil((args.closing + args.expansion) / args.pitch)) + 3
    solid = np.pad(voxels.matrix, padding)
    # Operate on one solid, never offset individual intersecting surface sheets.
    solid = ndimage.distance_transform_edt(~solid) * args.pitch <= args.expansion
    solid = ndimage.binary_closing(solid, structure=ball(int(round(args.closing / args.pitch))))
    field = ndimage.gaussian_filter(solid.astype(np.float32), sigma=1.2)
    points, indices, _, _ = marching_cubes(field, level=0.5, spacing=(args.pitch,) * 3, allow_degenerate=False)
    points += voxels.transform[:3, 3] - padding * args.pitch
    # marching_cubes returns inward winding for the inside-positive volume.
    indices = indices[:, ::-1]
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(points.astype(float), indices.astype(np.int32)))
    ms.apply_filter("meshing_decimation_quadric_edge_collapse", targetfacenum=100000, preservenormal=True, preservetopology=True, optimalplacement=True)
    result = ms.current_mesh()
    points, indices = result.vertex_matrix(), result.face_matrix()
    # Alternating Taubin steps remove voxel-scale stair steps without shrinking
    # the rounded crowns or changing the anatomical sulcal layout.
    row = np.concatenate([indices[:, 0], indices[:, 1], indices[:, 2], indices[:, 1], indices[:, 2], indices[:, 0]])
    col = np.concatenate([indices[:, 1], indices[:, 2], indices[:, 0], indices[:, 0], indices[:, 1], indices[:, 2]])
    adjacent = sparse.coo_matrix((np.ones(len(row)), (row, col)), shape=(len(points), len(points))).tocsr()
    adjacent.data[:] = 1
    average = sparse.diags(1 / np.asarray(adjacent.sum(1)).ravel()) @ adjacent
    for _ in range(10):
        points += 0.5 * (average @ points - points)
        points -= 0.53 * (average @ points - points)
    # Preserve source dimensions after closing, including hemispheric asymmetry.
    points = (points - points.min(0)) / np.ptp(points, axis=0) * np.ptp(vertices, axis=0) + vertices.min(0)
    validation = pymeshlab.MeshSet()
    validation.add_mesh(pymeshlab.Mesh(points, indices))
    validation.apply_filter("compute_selection_by_self_intersections_per_face")
    if validation.current_mesh().selected_face_number():
        raise ValueError("Closed cortex contains intersecting triangles")
    closed = trimesh.Trimesh(points, indices, process=False)
    if not closed.is_watertight or closed.volume <= 0 or len(points) > 65535:
        raise ValueError("Export must be closed, outward-facing and uint16-addressable")
    output[side] = {"vertices": points.reshape(-1).tolist(), "faces": indices.reshape(-1).tolist()}
    print(json.dumps({"side": side, "vertices": len(points), "faces": len(indices), "watertight": closed.is_watertight, "seconds": time.perf_counter() - started}), flush=True)
Path(args.output).write_text(json.dumps(output, separators=(",", ":")))
