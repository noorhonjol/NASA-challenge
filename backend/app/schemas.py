from datetime import datetime
from typing import Any

from pydantic import ConfigDict
from sqlmodel import SQLModel


class SiteOut(SQLModel):
    """API representation of a site; snake_case fields mirror the columns."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    name: str
    lat_deg: float
    lon_deg: float
    elevation_m: float | None
    frame: str
    is_fictional: bool
    notes: str | None


class TerrainDatasetOut(SQLModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    catalog_key: str | None
    name: str
    product: str | None
    file_uri: str | None
    crs: str | None
    resolution_m: float | None
    source: str | None
    retrieved_at: datetime | None
    license: str | None
    notes: str | None
    provenance: dict[str, Any]
