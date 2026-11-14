"""Read the database terrain catalog; raster downloads are not proxied by this API."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from ..db import get_session
from ..models import TerrainDataset
from ..schemas import TerrainDatasetOut

router = APIRouter(prefix="/api/terrain-datasets", tags=["terrain"])


@router.get("", response_model=list[TerrainDatasetOut])
def list_datasets(session: Session = Depends(get_session)):
    try:
        return session.exec(select(TerrainDataset).order_by(TerrainDataset.name)).all()
    except SQLAlchemyError:
        raise HTTPException(503, "database unavailable")


@router.get("/{dataset_id}", response_model=TerrainDatasetOut)
def get_dataset(dataset_id: int, session: Session = Depends(get_session)):
    try:
        dataset = session.get(TerrainDataset, dataset_id)
    except SQLAlchemyError:
        raise HTTPException(503, "database unavailable")
    if dataset is None:
        raise HTTPException(404, "terrain dataset not found")
    return dataset
