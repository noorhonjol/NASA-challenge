import json
from pathlib import Path
import pytest
from scripts.remove_legacy78 import targets


def setup_plan(root:Path,name='Site04',product=81):
    (root/'Mosaic81').mkdir(exist_ok=True)
    (root/'Mosaic81/surface.tif').touch();(root/'Mosaic81/overview.gz').touch()
    (root/'browser-manifest.json').write_text(json.dumps({'regions':[{'product_id':product,'original':'Mosaic81/surface.tif','grid_file':'Mosaic81/overview.gz'}]}))
    (root/'legacy-78-cleanup.json').write_text(json.dumps({'regions':[{'catalog_key':'pgda-78:'+name,'region_id':name}]}))


def test_cleanup_lists_only_verified_legacy_children(tmp_path):
    setup_plan(tmp_path)
    (tmp_path/'Site04').mkdir();(tmp_path/'global').mkdir()
    assert targets(tmp_path)==[(tmp_path/'Site04').resolve()]
    assert (tmp_path/'Mosaic81').is_dir() and (tmp_path/'global').is_dir()


@pytest.mark.parametrize('name',['../outside','global','Mosaic81'])
def test_cleanup_rejects_escape_and_retained_data(tmp_path,name):
    setup_plan(tmp_path,name)
    with pytest.raises(RuntimeError):targets(tmp_path)


def test_cleanup_requires_active_mosaic(tmp_path):
    setup_plan(tmp_path,product=78)
    with pytest.raises(RuntimeError):targets(tmp_path)
