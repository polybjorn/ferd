# Screenshots

Images referenced by the project README and docs. Suggested set for launch:

- `map.png` - unified map view with both place pins and a route visible (referenced by the project `README.md`).
- `filters.png` - filter panel open, showing category toggles and visited / want chips.
- `route.png` - route detail with elevation profile.
- `history.png` - History tab with entries across at least two years.
- `sign-in.png` - sign-in dialog.
- `mobile.png` - mobile chrome / map view.

Use PNG, 1600x1080 to match `map.png`. Crop tight. Each screenshot is one image split by a diagonal: light mode in the top-left half, dark mode in the bottom-right half, same view in both. See [Light/dark composite](#lightdark-composite).

## Demo data

Capture from a throwaway instance loaded with the demo dataset, never from a real account. `scripts/demo-data.py` writes an import zip with invented places, four synthetic routes with elevation (one planned, three completed), and visit and completion dates across 2023-2025 so History has several years. Nothing in it is real geography beyond the base map it sits on.

From the repo root:

```sh
D=/tmp/ferd-demo; mkdir -p "$D"
cat > "$D/config.json" <<EOF
{
  "bind": "127.0.0.1:8092",
  "db_path": "$D/app.db",
  "data_dir": "$D",
  "static_dir": "$PWD",
  "manifest_cmd": "$PWD/scripts/gpx-manifest.sh",
  "initial_user": "demo",
  "initial_password": "demo-password-1",
  "secure_cookies": false
}
EOF
[ -f site-config.json ] || cp site-config.example.json site-config.json
python3 scripts/demo-data.py -o "$D/demo.zip"
python3 tools/api.py --config "$D/config.json" &

curl -s -c "$D/jar" -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo-password-1"}' http://127.0.0.1:8092/api/login
curl -s -b "$D/jar" -H 'Content-Type: application/zip' \
  --data-binary @"$D/demo.zip" 'http://127.0.0.1:8092/api/me/import?mode=replace'
```

The import answers with `"places": 8, "gpx": 4` and `"manifest": {"ran": true, ...}`. Open http://127.0.0.1:8092, sign in as `demo`, and set the browser window so the page is 1600x1080.

- `route.png`: Ridge Climb's detail page (`#/routes/route/Demo%20Highlands%2FRidge%20Climb`), which shows its elevation profile.
- `history.png`: the History tab (`#/history`).

The demo user stays local and unpublished. When done, stop the server and `rm -rf /tmp/ferd-demo`.

## Light/dark composite

Take the same view twice, once with Settings > Mode on Light and once on Dark, without moving the map in between. Save them as `light.png` and `dark.png`, both 1600x1080. Then, with ImageMagick 7:

```sh
magick -size 1600x1080 xc:black -fill white -draw "polygon 1600,0 1600,1080 0,1080" mask.png
magick light.png dark.png mask.png -composite route.png
```

The mask's white triangle (bottom-right) takes the dark capture, the black one keeps the light capture. On ImageMagick 6, use `convert` in place of `magick`.
