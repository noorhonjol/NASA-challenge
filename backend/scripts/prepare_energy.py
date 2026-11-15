"""Install pinned NAIF kernels and optionally warm horizon caches. Run from backend."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.energy_v1.ephemeris import KERNELS, SHA256
from app.terrain import data_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--horizons",
        type=Path,
        help="Optional JSON file containing a list of Location objects to precompute",
    )
    args = parser.parse_args()
    root = data_root().parent / "spice"
    root.mkdir(parents=True, exist_ok=True)
    records = {}
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for name, relative in KERNELS.items():
            path = root / name
            url = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/" + relative
            if not path.is_file():
                temporary = path.with_suffix(path.suffix + ".partial")
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with temporary.open("wb") as output:
                        for block in response.iter_bytes():
                            output.write(block)
                temporary.replace(path)
            records[name] = {
                "source": url,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            if records[name]["sha256"] != SHA256[name]:
                raise ValueError(f"Kernel checksum mismatch: {name}")
            print(name, records[name]["sha256"], flush=True)
    (root / "manifest.json").write_text(json.dumps(records, indent=2))
    if args.horizons:
        from app.energy_v1.schemas import Location
        from app.energy_v1.terrain import get_surface

        surface = get_surface()
        locations = [
            Location.model_validate(value)
            for value in json.loads(args.horizons.read_text())
        ]
        for location in locations:
            enriched, _ = surface.location(location)
            surface.horizons(location, enriched["elevation_m"])
            print("Prepared horizon", location.model_dump(), flush=True)


if __name__ == "__main__":
    main()
