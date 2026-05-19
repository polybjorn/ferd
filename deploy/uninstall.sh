#!/bin/sh
# Atlas uninstaller. Stops the service, removes the systemd units, and
# optionally removes the system user and install prefix. Data files
# (places.json, gpx/, atlas.db, config.json) are NEVER auto-removed; the
# script tells you what to delete by hand if you want a full wipe.
#
# Usage:
#   sudo ./uninstall.sh                # interactive
#   sudo ./uninstall.sh --yes          # remove units + user, keep prefix and data
#   sudo ./uninstall.sh --purge --yes  # also remove the entire prefix (DESTRUCTIVE)

set -eu

PREFIX="/srv/atlas"
SVC_USER="atlas"
ASSUME_YES="no"
PURGE="no"

for arg in "$@"; do
    case "$arg" in
        --prefix=*) PREFIX="${arg#*=}" ;;
        --user=*)   SVC_USER="${arg#*=}" ;;
        --yes|-y)   ASSUME_YES="yes" ;;
        --purge)    PURGE="yes" ;;
        -h|--help)  sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Re-run with sudo." >&2
    exit 1
fi

confirm() {
    if [ "$ASSUME_YES" = "yes" ]; then return 0; fi
    printf '%s [y/N] ' "$1"
    read -r reply
    case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

echo "Atlas uninstall plan:"
echo "  prefix:  $PREFIX"
echo "  user:    $SVC_USER"
echo "  purge:   $PURGE"
echo

echo "[1/4] stop and disable atlas-api.socket and atlas-api.service"
if confirm "  proceed?"; then
    systemctl disable --now atlas-api.socket  2>/dev/null || true
    systemctl disable --now atlas-api.service 2>/dev/null || true
fi

echo "[2/4] remove unit files from /etc/systemd/system/"
if confirm "  proceed?"; then
    rm -f /etc/systemd/system/atlas-api.service /etc/systemd/system/atlas-api.socket
    systemctl daemon-reload
fi

echo "[3/4] remove system user '$SVC_USER'"
if id "$SVC_USER" >/dev/null 2>&1; then
    if confirm "  proceed?"; then
        userdel "$SVC_USER" || true
    fi
else
    echo "  user does not exist, skipping"
fi

echo "[4/4] $PREFIX"
if [ "$PURGE" = "yes" ]; then
    echo "  --purge: will recursively delete $PREFIX (INCLUDING places.json, gpx/, atlas.db)"
    if confirm "  REALLY proceed? this is destructive"; then
        rm -rf "$PREFIX"
    fi
else
    echo "  kept. To remove data manually:"
    echo "    rm -rf $PREFIX"
fi

echo
echo "Done. Reverse-proxy config (nginx site, Caddyfile) was not touched; remove it by hand."
