"""Download Zhejiang province full OSM PBF from Geofabrik (unbuffered)."""
import os, time
import urllib.request
from pathlib import Path

# 锚定项目根：scripts/tools/zhejiang-osm/ → 项目根，数据产物统一入 docs/data/zhejiang-osm/
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "docs" / "data" / "zhejiang-osm"
DATA_DIR.mkdir(parents=True, exist_ok=True)

URL = "https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf"
DEST = str(DATA_DIR / "zhejiang-latest.osm.pbf")
TMP = DEST + ".part"

req = urllib.request.Request(URL, headers={"User-Agent": "road-network-research/1.0"})
t0 = time.time()
with urllib.request.urlopen(req, timeout=300) as resp:
    total = int(resp.headers.get("content-length", 0))
    done = 0
    fd = os.open(TMP, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            os.write(fd, chunk)
            done += len(chunk)
            if done % (10 * 1024 * 1024) < 256 * 1024:
                print(f"{done/1e6:.1f}/{total/1e6:.1f} MB {done/max(total,1)*100:.0f}% {time.time()-t0:.0f}s", flush=True)
    finally:
        os.close(fd)
os.rename(TMP, DEST)
print(f"DONE {done/1e6:.1f} MB in {time.time()-t0:.0f}s", flush=True)
