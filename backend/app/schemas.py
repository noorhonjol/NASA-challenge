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
