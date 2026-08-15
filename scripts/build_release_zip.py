#!/usr/bin/env python3
"""Build and verify the self-contained Japan Weather Atlas release bundle."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "japan-weather-atlas.zip"
PREFIX = "japan-weather-atlas/"
RELEASE_FILES = (
    "README.md",
    "index.html",
    "japan_weather_jma.html",
    "japan_disaster_jma.html",
    "jma_cities.js",
    "jma_pressure.js",
    "hko_tctrack.js",
    "jma_nankai.js",
    "jma_early.js",
    "jma_phenology.js",
    "jma_typhoon_history.js",
    # Vendored map library — without these the unzipped atlas has no map at
    # all, which would silently reintroduce the CDN dependency the vendoring
    # removed.
    "vendor/leaflet.js",
    "vendor/leaflet.css",
    "vendor/leaflet-heat.js",
    "vendor/images/marker-icon.png",
    "vendor/images/marker-icon-2x.png",
    "vendor/images/marker-shadow.png",
    "vendor/images/layers.png",
    "vendor/images/layers-2x.png",
)
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def zip_info(name: str, mode: int = 0o100644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, ZIP_TIME)
    info.create_system = 3
    info.external_attr = mode << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def build() -> None:
    missing = [name for name in RELEASE_FILES if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit("release inputs missing: " + ", ".join(missing))

    payloads = {name: (ROOT / name).read_bytes() for name in RELEASE_FILES}
    checksums = "".join(
        f"{hashlib.sha256(payloads[name]).hexdigest()}  {name}\n"
        for name in RELEASE_FILES
    ).encode()

    temporary = OUTPUT.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            archive.writestr(zip_info(PREFIX, 0o40755), b"")
            archive.writestr(zip_info(PREFIX + "vendor/", 0o40755), b"")
            archive.writestr(zip_info(PREFIX + "vendor/images/", 0o40755), b"")
            archive.writestr(zip_info(PREFIX + ".nojekyll"), b"")
            archive.writestr(zip_info(PREFIX + "RELEASE.sha256"), checksums)
            for name in RELEASE_FILES:
                archive.writestr(zip_info(PREFIX + name), payloads[name])
        os.replace(temporary, OUTPUT)
    finally:
        temporary.unlink(missing_ok=True)

    with zipfile.ZipFile(OUTPUT) as archive:
        if archive.testzip() is not None:
            raise SystemExit("release ZIP failed its CRC check")
        for name, expected in payloads.items():
            if archive.read(PREFIX + name) != expected:
                raise SystemExit(f"release ZIP differs from source: {name}")

    print(f"Built and verified {OUTPUT.name} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
