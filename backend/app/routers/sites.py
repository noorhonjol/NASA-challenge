from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from ..db import get_session
from ..models import Site
from ..schemas import SiteOut

router = APIRouter(prefix="/api/sites", tags=["sites"])


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="database unavailable")


@router.get("", response_model=list[SiteOut])
def list_sites(session: Session = Depends(get_session)):
    try:
        return session.exec(select(Site).order_by(Site.name)).all()
    except SQLAlchemyError:
        raise _unavailable()


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: int, session: Session = Depends(get_session)):
    try:
        site = session.get(Site, site_id)
    except SQLAlchemyError:
        raise _unavailable()
    if site is None:
        raise HTTPException(status_code=404, detail="site not found")
    return site
