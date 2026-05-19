#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PYEOF'
import json, os, xml.etree.ElementTree as ET

GPX_DIR = "gpx"
METADATA_FILE = "metadata.json"
OUTPUT_FILE = "routes.json"

metadata = {}
if os.path.exists(METADATA_FILE):
    with open(METADATA_FILE) as f:
        metadata = json.load(f)

def has_elevation(path):
    try:
        for _, elem in ET.iterparse(path, events=("end",)):
            if elem.tag.endswith("}ele") or elem.tag == "ele":
                return True
            elem.clear()
    except ET.ParseError:
        pass
    return False

def get_tracks_info(path):
    ns = "{http://www.topografix.com/GPX/1/1}"
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        trks = root.findall(f"{ns}trk") or root.findall("trk")
        names = []
        for trk in trks:
            name_el = trk.find(f"{ns}name")
            if name_el is None:
                name_el = trk.find("name")
            names.append(name_el.text if name_el is not None and name_el.text else f"Track {len(names)+1}")
        return len(trks), names
    except ET.ParseError:
        return 1, []

routes = {}

for root, _, files in os.walk(GPX_DIR):
    for fname in files:
        if not fname.endswith(".gpx"):
            continue
        rel = os.path.relpath(os.path.join(root, fname), GPX_DIR)
        region = os.path.dirname(rel)
        if not region:
            continue

        is_planned = fname.endswith(".planned.gpx")
        if is_planned:
            base = os.path.join(region, fname.removesuffix(".planned.gpx"))
        else:
            base = os.path.join(region, fname.removesuffix(".gpx"))

        if base not in routes:
            routes[base] = {"key": base, "region": region, "name": os.path.basename(base)}

        if is_planned:
            routes[base]["plannedFile"] = rel
        else:
            routes[base]["walkedFile"] = rel

for key, route in routes.items():
    walked = route.get("walkedFile")
    planned = route.get("plannedFile")
    route["completed"] = walked is not None
    route["file"] = walked or planned

    primary_path = os.path.join(GPX_DIR, route["file"])
    route["hasElevation"] = has_elevation(primary_path)

    track_count, track_names = get_tracks_info(primary_path)
    if track_count > 1:
        route["trackCount"] = track_count
        route["trackNames"] = track_names

    meta = metadata.get(key, {})
    if "source" in meta:
        route["source"] = meta["source"]

REGION_NAMES = {
    "Tyrkia": "Turkey",
}

regions = {}
for route in routes.values():
    rname = REGION_NAMES.get(route["region"], route["region"])
    if rname not in regions:
        regions[rname] = {"name": rname, "routes": []}

    entry = {"key": route["key"], "file": route["file"], "name": route["name"],
             "hasElevation": route["hasElevation"], "completed": route["completed"]}
    if "plannedFile" in route:
        entry["plannedFile"] = route["plannedFile"]
    if "trackCount" in route:
        entry["trackCount"] = route["trackCount"]
        entry["trackNames"] = route["trackNames"]
    if "source" in route:
        entry["source"] = route["source"]
    regions[rname]["routes"].append(entry)

output = {"regions": sorted(regions.values(), key=lambda r: r["name"])}
for region in output["regions"]:
    region["routes"].sort(key=lambda r: r["name"])

with open(OUTPUT_FILE, "w") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

total = sum(len(r["routes"]) for r in output["regions"])
completed = sum(1 for r in output["regions"] for rt in r["routes"] if rt["completed"])
print(f"Generated {OUTPUT_FILE}: {total} routes ({completed} completed) across {len(output['regions'])} regions")
PYEOF
