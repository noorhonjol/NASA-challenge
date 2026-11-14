"""Remove product 78 local files only after a verified product 81 replacement exists.

Run after mosaic preparation and frontend verification. Requires explicit --delete.
Only directories recorded in the prior product 78 manifest are eligible for deletion.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.settings import get_settings


def targets(root):
    root=root.resolve()
    current=json.loads((root/'browser-manifest.json').read_text())
    if len(current['regions'])!=1 or current['regions'][0].get('product_id')!=81:
        raise RuntimeError('Product 81 must be the active prepared terrain before deleting product 78')
    mosaic=current['regions'][0]
    if not (root/mosaic['original']).is_file() or not (root/mosaic['grid_file']).is_file():
        raise RuntimeError('Replacement assets are missing')
    plan=json.loads((root/'legacy-78-cleanup.json').read_text())
    result=[]
    for region in plan['regions']:
        if not region.get('catalog_key','').startswith('pgda-78:'):
            raise RuntimeError('Cleanup plan includes a non-product-78 dataset')
        name=region['region_id']
        if not name.isalnum() or name.lower() in ('global','mosaic81'):
            raise RuntimeError('Unsafe legacy directory name')
        path=(root/name).resolve()
        if path.parent!=root or path==root:
            raise RuntimeError('Resolved delete target is outside the terrain directory')
        if path.exists():result.append(path)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delete',action='store_true')
    args=parser.parse_args()
    root=Path(get_settings().terrain_data_dir).resolve()
    directories=targets(root)
    print('Verified legacy directories:',*[str(p) for p in directories],sep='\n')
    if not args.delete:
        print('Dry run only. Supply --delete to remove the listed directories.');return
    for path in directories:
        shutil.rmtree(path)
        print('Removed',path.name,flush=True)
    print(f'Removed {len(directories)} legacy product 78 directories. Global baseline and Mosaic81 retained.')


if __name__=='__main__':main()
