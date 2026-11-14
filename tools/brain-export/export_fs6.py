from nilearn.datasets import fetch_surf_fsaverage
import nibabel as nib
import numpy as np
from pathlib import Path
import struct, gzip, argparse
parser=argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--cache", required=True)
args=parser.parse_args()

folder=Path(args.cache)
data=fetch_surf_fsaverage('fsaverage6',data_dir=folder)
meshes={}
for side in ['left','right']:
    p=nib.load(data['pial_'+side]);v=p.darrays[0].data.astype(float);f=p.darrays[1].data.astype(int)
    s=nib.load(data['sulc_'+side]).darrays[0].data.astype(float)
    meshes[side]=(v,f,s)
allv=np.vstack([m[0] for m in meshes.values()]);lo=allv.min(0);hi=allv.max(0)
center=(lo+hi)/2;scale=np.array([68.,76.,60.])/((hi-lo)/2)
fitted={side:((v-center)*scale+np.array([0,0,8]),f,s) for side,(v,f,s) in meshes.items()}
shrink=min(1.,77/max(np.linalg.norm(v,axis=1).max() for v,f,s in fitted.values()))
output=bytearray(b'LUCIDFS6')
for side,(v,f,s) in fitted.items():
    v*=shrink;n=len(v)
    inflated=nib.load(data['infl_'+side]).darrays[0].data.astype(float)
    inflated=(inflated-inflated.mean(0))*((v.max(0)-v.min(0))/(inflated.max(0)-inflated.min(0)))+v.mean(0)
    bounds=np.vstack([v,inflated]);low=bounds.min(0);high=bounds.max(0);extent=high-low
    s=np.clip((s-np.percentile(s,2))/(np.percentile(s,98)-np.percentile(s,2)),0,1)
    output+=struct.pack('<II6f',n,len(f),*low,*extent)
    for points in [v,inflated]:output+=np.round((points-low)/extent*65535).astype('<u2').tobytes()
    output+=f.astype('<u2').tobytes();output+=np.round(s*255).astype('u1').tobytes()
    if len(output)%4: output+=bytes(4-len(output)%4)
path=Path(args.output);path.write_bytes(output)
print('bytes',len(output),'gzip',len(gzip.compress(output,compresslevel=9)),flush=True)
