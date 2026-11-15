from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from .db import get_session
from .routers import sites, positions, terrain_datasets, terrain, energy_v1, earth_link, sun, mission


def create_app() -> FastAPI:
    app = FastAPI(title="Lunar Planner API")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health(session: Session = Depends(get_session)):
        try:
            session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            return JSONResponse(
                status_code=503,
                content={"status": "error", "database": "unavailable"},
            )
        return {"status": "ok", "database": "ok"}

    app.include_router(energy_v1.router)
    app.include_router(sites.router)
    app.include_router(positions.router)
    app.include_router(terrain_datasets.router)
    app.include_router(terrain.router)
    app.include_router(earth_link.router)
    app.include_router(sun.router)
    app.include_router(mission.router)

    return app


app = create_app()
