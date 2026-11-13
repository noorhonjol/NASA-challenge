from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    Index,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Column, Field, Relationship, SQLModel


class Site(SQLModel, table=True):
    """A lunar observation site. Coordinates are selenographic (frame in `frame`)."""

    __tablename__ = "sites"
    __table_args__ = (
        CheckConstraint("lat_deg BETWEEN -90 AND 90", name="sites_lat_deg_check"),
        CheckConstraint("lon_deg BETWEEN -180 AND 180", name="sites_lon_deg_check"),
    )

    id: int | None = Field(
        default=None, sa_column=Column(BigInteger, primary_key=True)
    )
    slug: str = Field(sa_column=Column(Text, nullable=False, unique=True))
    name: str = Field(sa_column=Column(Text, nullable=False))
    lat_deg: float = Field(sa_column=Column(Double, nullable=False))
    lon_deg: float = Field(sa_column=Column(Double, nullable=False))
    elevation_m: float | None = Field(default=None, sa_column=Column(Double))
    frame: str = Field(sa_column=Column(Text, nullable=False))
    is_fictional: bool = Field(
        default=True, sa_column=Column(Boolean, nullable=False, server_default="true")
    )
    notes: str | None = Field(default=None, sa_column=Column(Text))
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=False, server_default=func.now()),
    )

    analysis_runs: list["AnalysisRun"] = Relationship(back_populates="site")


class TerrainDataset(SQLModel, table=True):
    """Provenance record for a DEM or imagery product. `file_uri` is metadata, not a raster."""

    __tablename__ = "terrain_datasets"

    id: int | None = Field(
        default=None, sa_column=Column(BigInteger, primary_key=True)
    )
    name: str = Field(sa_column=Column(Text, nullable=False))
    product: str | None = Field(default=None, sa_column=Column(Text))
    file_uri: str | None = Field(default=None, sa_column=Column(Text))
    crs: str | None = Field(default=None, sa_column=Column(Text))
    resolution_m: float | None = Field(default=None, sa_column=Column(Double))
    source: str | None = Field(default=None, sa_column=Column(Text))
    retrieved_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime(timezone=True))
    )
    license: str | None = Field(default=None, sa_column=Column(Text))
    notes: str | None = Field(default=None, sa_column=Column(Text))


class AnalysisRun(SQLModel, table=True):
    __tablename__ = "analysis_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="analysis_runs_status_check",
        ),
        Index("ix_analysis_runs_site_id", "site_id"),
    )

    id: int | None = Field(
        default=None, sa_column=Column(BigInteger, primary_key=True)
    )
    site_id: int = Field(
        sa_column=Column(
            BigInteger, ForeignKey("sites.id", ondelete="CASCADE"), nullable=False
        )
    )
    terrain_dataset_id: int | None = Field(
        default=None,
        sa_column=Column(BigInteger, ForeignKey("terrain_datasets.id")),
    )
    label: str | None = Field(default=None, sa_column=Column(Text))
    status: str = Field(
        default="pending",
        sa_column=Column(Text, nullable=False, server_default="pending"),
    )
    config: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default="{}"),
    )
    provenance: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default="{}"),
    )
    started_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime(timezone=True))
    )
    finished_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime(timezone=True))
    )
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=False, server_default=func.now()),
    )

    site: Site | None = Relationship(back_populates="analysis_runs")
    visibility_windows: list["VisibilityWindow"] = Relationship(
        back_populates="analysis_run"
    )


class VisibilityWindow(SQLModel, table=True):
    __tablename__ = "visibility_windows"
    __table_args__ = (
        CheckConstraint("end_utc > start_utc", name="visibility_windows_check"),
        Index("ix_visibility_windows_analysis_run_id", "analysis_run_id"),
    )

    id: int | None = Field(
        default=None, sa_column=Column(BigInteger, primary_key=True)
    )
    analysis_run_id: int = Field(
        sa_column=Column(
            BigInteger,
            ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    kind: str = Field(sa_column=Column(Text, nullable=False))
    start_utc: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    end_utc: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    confidence: float | None = Field(default=None, sa_column=Column(Double))
    notes: str | None = Field(default=None, sa_column=Column(Text))

    analysis_run: AnalysisRun | None = Relationship(back_populates="visibility_windows")
