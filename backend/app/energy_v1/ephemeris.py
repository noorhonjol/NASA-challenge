"""Pinned DE440 vectors, serialized because CSPICE's kernel pool is process-global."""

from functools import lru_cache
import hashlib
from threading import RLock
import numpy as np
import spiceypy as spice
from ..terrain import data_root
from .errors import EnergyError

KERNELS = {
    "naif0012.tls": "lsk/naif0012.tls",
    "de440s.bsp": "spk/planets/de440s.bsp",
    "moon_pa_de440_200625.bpc": "pck/moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf": "fk/satellites/moon_de440_250416.tf",
}
SHA256 = {
    "naif0012.tls": "678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b",
    "de440s.bsp": "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2",
    "moon_pa_de440_200625.bpc": "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f",
    "moon_de440_250416.tf": "a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768",
}
LOCK = RLock()
_loaded = None


@lru_cache(maxsize=100000)
def vectors(iso):
    global _loaded
    root = data_root().parent / "spice"
    with LOCK:
        try:
            if _loaded != root:
                files = [root / name for name in KERNELS]
                if not all(p.is_file() for p in files):
                    raise EnergyError(
                        "DATA_UNAVAILABLE",
                        "Run backend/scripts/prepare_energy.py to install DE440 kernels",
                        status=503,
                    )
                for path in files:
                    if (
                        hashlib.sha256(path.read_bytes()).hexdigest()
                        != SHA256[path.name]
                    ):
                        raise EnergyError(
                            "DATA_UNAVAILABLE",
                            f"SPICE kernel checksum mismatch: {path.name}",
                            status=503,
                        )
                for path in files:
                    spice.furnsh(str(path))
                _loaded = root
            et = spice.str2et(iso.replace("+00:00", ""))
            return (
                np.array(
                    [
                        spice.spkpos(body, et, "MOON_ME", "LT+S", "MOON")[0]
                        for body in ("SUN", "EARTH")
                    ]
                )
                * 1000
            )
        except (OSError, spice.utils.exceptions.SpiceyError) as exc:
            raise EnergyError(
                "DATA_UNAVAILABLE",
                "DE440 kernels cannot evaluate the requested epoch",
                status=503,
            ) from exc
