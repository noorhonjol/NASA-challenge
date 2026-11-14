import gzip
import numpy as np
import pytest

from scripts.prepare_mosaic81 import compressed,encode,mask_coverage,COVERAGE_RADIUS


def test_display_encoding_round_trip_preserves_nodata_and_height_error_bound(tmp_path):
    source=np.array([[1234.12,-9456.24,np.nan],[0,50.13,-60.4]],dtype=np.float32)
    encoded=encode(source)
    path=tmp_path/'chunk.gz'
    compressed(path,encoded)
    with gzip.open(path,'rb') as file:
        delta=np.frombuffer(file.read(),dtype='<i2').reshape(source.shape)
    actual=np.cumsum(delta,axis=1,dtype=np.int32).astype('<i2')
    np.testing.assert_array_equal(actual,encoded)
    valid=np.isfinite(source)
    assert np.max(np.abs(actual[valid]*.5-source[valid]))<=.25
    assert actual[0,2]==-32768


def test_unrepresentable_source_height_fails_instead_of_wrapping():
    with pytest.raises(ValueError):encode(np.array([[20000.]],dtype=np.float32))


def test_pixels_outside_87_degree_circle_and_source_nodata_are_masked():
    source=np.array([[10,-9999],[20,30]],dtype=np.float32)
    near=mask_coverage(source.copy(),-5,5,5,-9999)
    assert near[0,0]==10 and np.isnan(near[0,1])
    outside=mask_coverage(source.copy(),COVERAGE_RADIUS+100,5,5,-9999)
    assert np.isnan(outside).all()
