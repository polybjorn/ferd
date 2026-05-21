#!/bin/sh
# Atlas installer. Lays out files, creates a system user, installs the
# socket-activated systemd units. Reverse-proxy setup (Caddy or nginx) is
# manual; this script only prints next steps for it.
#
# Run from the unpacked Atlas source tree (the directory containing
# index.html, tools/, deploy/, ...). Re-running is safe; each step checks
# whether it has already been done.
#
# Usage:
#   sudo ./deploy/install.sh                # interactive, prompts before each step
#   sudo ./deploy/install.sh --yes          # non-interactive
#   sudo ./deploy/install.sh --prefix=/opt/atlas --user=atlas --yes
#
# No network calls. No curl, no apt, no pip. Read the script before running.

set -eu

PREFIX="/srv/atlas"
SVC_USER="atlas"
ASSUME_YES="no"

for arg in "$@"; do
    case "$arg" in
        --prefix=*) PREFIX="${arg#*=}" ;;
        --user=*)   SVC_USER="${arg#*=}" ;;
        --yes|-y)   ASSUME_YES="yes" ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "This script needs to write to /etc/systemd and create a system user." >&2
    echo "Re-run with sudo." >&2
    exit 1
fi

for cmd in python3 systemctl useradd install; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "missing required command: $cmd" >&2
        exit 1
    fi
done

confirm() {
    if [ "$ASSUME_YES" = "yes" ]; then return 0; fi
    printf '%s [y/N] ' "$1"
    read -r reply
    case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

echo
echo "Atlas install plan:"
echo "  source:  $SRC_DIR"
echo "  prefix:  $PREFIX"
echo "  user:    $SVC_USER"
echo

# 1. System user.
if id "$SVC_USER" >/dev/null 2>&1; then
    echo "[1/4] user '$SVC_USER' already exists, skipping"
else
    echo "[1/4] will create system user '$SVC_USER' (home=$PREFIX, shell=nologin)"
    if confirm "  proceed?"; then
        useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SVC_USER"
    else
        echo "  skipped"
    fi
fi

# 2. File layout.
echo "[2/4] will copy application files to $PREFIX"
if [ -e "$PREFIX" ]; then
    echo "  $PREFIX exists. Files with the same name will be OVERWRITTEN."
    echo "  Files already present and not in the source tree are kept (users/,"
    echo "  tools/atlas.db, tools/config.json, site-config.json)."
fi
if confirm "  proceed?"; then
    install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX"
    install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX/tools" "$PREFIX/deploy" "$PREFIX/gpx"

    for f in index.html favicon.svg gpx-manifest.sh site-config.example.json LICENSE; do
        if [ -f "$SRC_DIR/$f" ]; then
            install -m 0644 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/$f" "$PREFIX/$f"
        fi
    done
    # gpx-manifest.sh needs to be executable.
    if [ -f "$PREFIX/gpx-manifest.sh" ]; then chmod 0755 "$PREFIX/gpx-manifest.sh"; fi

    install -m 0644 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/tools/api.py" "$PREFIX/tools/api.py"
    install -m 0644 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/tools/config.example.json" "$PREFIX/tools/config.example.json"

    for f in atlas-api.service atlas-api.socket nginx.example.conf Caddyfile.example; do
        if [ -f "$SRC_DIR/deploy/$f" ]; then
            install -m 0644 "$SRC_DIR/deploy/$f" "$PREFIX/deploy/$f"
        fi
    done

    # Seed config files only if missing. Never clobber admin-edited config.
    if [ ! -f "$PREFIX/tools/config.json" ]; then
        cp "$SRC_DIR/tools/config.example.json" "$PREFIX/tools/config.json"
        chown "$SVC_USER:$SVC_USER" "$PREFIX/tools/config.json"
        chmod 0640 "$PREFIX/tools/config.json"
        echo "  seeded $PREFIX/tools/config.json from example. Edit it before starting the service."
    fi
    if [ ! -f "$PREFIX/site-config.json" ] && [ -f "$SRC_DIR/site-config.example.json" ]; then
        cp "$SRC_DIR/site-config.example.json" "$PREFIX/site-config.json"
        chown "$SVC_USER:$SVC_USER" "$PREFIX/site-config.json"
        echo "  seeded $PREFIX/site-config.json from example."
    fi
else
    echo "  skipped"
fi

# 3. systemd units. Substitute /srv/atlas in the shipped units if PREFIX differs.
echo "[3/4] will install systemd units to /etc/systemd/system/"
if confirm "  proceed?"; then
    tmp_svc="$(mktemp)"
    tmp_sock="$(mktemp)"
    trap 'rm -f "$tmp_svc" "$tmp_sock"' EXIT

    sed \
        -e "s|/srv/atlas|$PREFIX|g" \
        -e "s|^User=atlas$|User=$SVC_USER|" \
        -e "s|^Group=atlas$|Group=$SVC_USER|" \
        "$SRC_DIR/deploy/atlas-api.service" > "$tmp_svc"
    cp "$SRC_DIR/deploy/atlas-api.socket" "$tmp_sock"

    install -m 0644 "$tmp_svc"  /etc/systemd/system/atlas-api.service
    install -m 0644 "$tmp_sock" /etc/systemd/system/atlas-api.socket
    systemctl daemon-reload
else
    echo "  skipped"
fi

# 4. Enable + start the socket.
echo "[4/4] will enable and start atlas-api.socket"
if confirm "  proceed?"; then
    systemctl enable --now atlas-api.socket
    systemctl status --no-pager atlas-api.socket || true
else
    echo "  skipped (start later with: systemctl enable --now atlas-api.socket)"
fi

echo
echo "Done. Next steps:"
echo "  1. Edit $PREFIX/tools/config.json (paths, secure_cookies, initial_user)."
echo "  2. Pick a reverse proxy:"
echo "       Caddy:  cp $PREFIX/deploy/Caddyfile.example /etc/caddy/Caddyfile  (then edit + reload)"
echo "       nginx:  see $PREFIX/deploy/nginx.example.conf"
echo "  3. Open the site and register the first account. They become the admin."
echo "     Each user manages their own places/trails through the in-browser UI;"
echo "     any pre-existing $PREFIX/places.json or $PREFIX/gpx/ is auto-migrated"
echo "     into that admin's $PREFIX/users/<admin>/ folder on first start."
echo
echo "Logs:    journalctl -u atlas-api.service -f"
echo "Uninstall: $PREFIX/deploy/uninstall.sh"
