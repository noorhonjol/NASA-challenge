from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse

from .. import terrain

router = APIRouter(prefix="/api/terrain", tags=["terrain"])


@router.get("/browser-manifest")
def get_browser_manifest():
    try:
        return terrain.public_browser_manifest()
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


def static_asset(kind: str, region_id: int | None, version: str | None):
    try:
        m = terrain.browser_manifest()
        if version is not None and version != m["version"]:
            raise HTTPException(409, "Terrain data changed; refresh the viewer")
        if region_id is None:
            relative = m["baseline"]["file"]
        else:
            region = next((r for r in m["regions"] if r["id"] == region_id), None)
            if region is None:
                raise HTTPException(404, "prepared terrain region not found")
            relative = region["grid_file" if kind == "grid" else "imagery_file"]
        path = terrain.local_path(terrain.data_root(), relative)
        if not path.is_file():
            raise HTTPException(503, "Prepared terrain asset is missing")
        headers = {"Cache-Control": "public, max-age=31536000, immutable" if version else "no-cache"}
        if kind == "grid":
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        return FileResponse(path, media_type="application/octet-stream" if kind == "grid" else "image/png", headers=headers)
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get("/assets/global.bin")
def global_asset(v: str | None = Query(default=None)):
    return static_asset("grid", None, v)


@router.get("/assets/regions/{region_id}/grid.bin")
def region_asset(region_id: int, v: str | None = Query(default=None)):
    return static_asset("grid", region_id, v)


@router.get("/assets/regions/{region_id}/relief.png")
def region_relief(region_id: int, v: str | None = Query(default=None)):
    return static_asset("image", region_id, v)


@router.get("/assets/mosaics/{region_id}/chunks/{row}/{col}.bin")
def mosaic_chunk(region_id: int, row: int, col: int, v: str | None = Query(default=None)):
    try:
        m=terrain.browser_manifest()
        if v is not None and v!=m["version"]:
            raise HTTPException(409,"Terrain data changed; refresh the viewer")
        region=next((r for r in m["regions"] if r["id"]==region_id),None)
        chunks=region.get("chunks") if region else None
        if chunks is None or row<0 or col<0 or f"{row}/{col}" not in chunks["available"]:
            raise HTTPException(404,"mosaic detail chunk not found")
        path=terrain.local_path(terrain.data_root(),chunks["file_pattern"].format(row=row,col=col))
        if not path.is_file():raise HTTPException(503,"Prepared detail chunk is missing")
        return FileResponse(path,media_type="application/octet-stream",headers={
            "Content-Encoding":"gzip","Vary":"Accept-Encoding",
            "Cache-Control":"public, max-age=31536000, immutable" if v else "no-cache",
        })
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503,str(exc)) from exc


def validate_tile(level, x, y):
    if not (0 <= level <= 20 and 0 <= x < 2 ** (level+1) and 0 <= y < 2 ** level):
        raise HTTPException(404, "terrain tile outside tiling scheme")


@router.get("/manifest")
def get_manifest():
    try:
        return terrain.public_manifest()
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get("/tiles/{level}/{x}/{y}.bin")
def get_tile(level: int, x: int, y: int, v: str | None = Query(default=None)):
    validate_tile(level, x, y)
    try:
        m = terrain.manifest()
        if v is not None and v != m["version"]:
            raise HTTPException(409, "Terrain data changed; refresh the viewer")
        data, minimum, maximum = terrain.heightmap(level, x, y)
        return Response(data, media_type="application/octet-stream", headers={
            "Cache-Control": "public, max-age=86400, immutable" if v else "no-cache",
            "ETag": f'"{m["version"]}-{level}-{x}-{y}"',
            "X-Terrain-Min": str(minimum), "X-Terrain-Max": str(maximum),
        })
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get("/imagery/{level}/{x}/{y}.png")
def get_hillshade(level: int, x: int, y: int, v: str | None = Query(default=None)):
    validate_tile(level, x, y)
    try:
        m = terrain.manifest()
        if v is not None and v != m["version"]:
            raise HTTPException(409, "Terrain data changed; refresh the viewer")
        return Response(terrain.hillshade(level, x, y), media_type="image/png", headers={
            "Cache-Control": "public, max-age=86400, immutable" if v else "no-cache",
            "ETag": f'"shade-{m["version"]}-{level}-{x}-{y}"',
        })
    except terrain.TerrainUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
