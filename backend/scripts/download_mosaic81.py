"""Resumable, bounded-memory download of NASA PGDA product 81's elevation GeoTIFF."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from app.settings import get_settings

URL = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif"
EXPECTED_SIZE = 3465285714
ROOT = Path(get_settings().terrain_data_dir).resolve() / "Mosaic81"
PART_SIZE = 64 * 1024 * 1024


def part(index):
    start = index * PART_SIZE
    end = min(EXPECTED_SIZE, start+PART_SIZE)-1
    path = ROOT / "parts" / f"{index:04d}.part"
    if path.is_file() and path.stat().st_size == end-start+1:
        return path
    temporary = path.with_suffix(".partial")
    for attempt in range(6):
        try:
            with httpx.Client(timeout=httpx.Timeout(240, connect=45), follow_redirects=True) as client:
                offset=temporary.stat().st_size if temporary.is_file() else 0
                if offset>end-start+1:temporary.unlink();offset=0
                if offset==end-start+1:
                    temporary.replace(path);return path
                request_start=start+offset
                with client.stream("GET", URL, headers={"Range": f"bytes={request_start}-{end}"}) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or response.headers.get("content-range") != f"bytes {request_start}-{end}/{EXPECTED_SIZE}":
                        raise ValueError("Server did not honor the requested byte range")
                    with temporary.open("ab") as output:
                        for data in response.iter_bytes(1024*1024):
                            output.write(data)
            if temporary.stat().st_size != end-start+1:
                raise ValueError("Incomplete download part")
            temporary.replace(path)
            return path
        except (httpx.HTTPError, ValueError) as exc:
            print(f"Part {index}: retry {attempt+1}: {exc}", flush=True)
            if attempt == 5:
                raise
            time.sleep(min(30, 3*(attempt+1)))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers',type=int,default=8,choices=range(1,9))
    args=parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    target = ROOT / "surface.tif"
    if target.is_file() and target.stat().st_size == EXPECTED_SIZE:
        print("Product 81 GeoTIFF already downloaded", flush=True)
        return
    (ROOT/"parts").mkdir(exist_ok=True)
    count = (EXPECTED_SIZE+PART_SIZE-1)//PART_SIZE
    completed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks = [pool.submit(part, i) for i in range(count)]
        for task in as_completed(tasks):
            task.result(); completed += 1
            print(f"Product 81: {completed}/{count} parts ({100*completed/count:.0f}%)", flush=True)
    print("Assembling verified byte ranges...", flush=True)
    temporary = target.with_suffix(".tif.partial")
    h = hashlib.sha256()
    with temporary.open("wb") as output:
        for i in range(count):
            with (ROOT/"parts"/f"{i:04d}.part").open("rb") as source:
                for data in iter(lambda: source.read(1024*1024), b""):
                    output.write(data); h.update(data)
    if temporary.stat().st_size != EXPECTED_SIZE:
        raise ValueError("Assembled size mismatch")
    temporary.replace(target)
    (ROOT/"download.json").write_text(json.dumps({"source": URL,"size_bytes":EXPECTED_SIZE,"sha256":h.hexdigest()},indent=2))
    # Delete only this script's explicitly named parts after successful assembly.
    for i in range(count):
        path = ROOT/"parts"/f"{i:04d}.part"
        if not path.resolve().is_relative_to(ROOT):
            raise ValueError("Part path escaped the mosaic directory")
        path.unlink()
    print(f"Product 81 downloaded: {EXPECTED_SIZE} bytes, SHA-256 {h.hexdigest()}",flush=True)


if __name__ == "__main__":
    main()
