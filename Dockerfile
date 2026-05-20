# Atlas - private self-hosted Leaflet map.
# Stdlib-only Python; no pip install step.

FROM python:3.12-slim

# bash is needed by gpx-manifest.sh; tini gives clean signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. UID 1000 matches a typical host user so bind-mounted
# data ends up owned by you on the host.
RUN useradd --system --uid 1000 --home /app --shell /usr/sbin/nologin atlas

WORKDIR /app
COPY --chown=atlas:atlas . /app

# Make /app/site-config.json a symlink into the data volume. The frontend
# fetches it as a static asset, the API writes it through data_dir, so they
# must resolve to the same file. _serve_static follows symlinks by design.
RUN rm -f /app/site-config.json \
 && ln -s /data/site-config.json /app/site-config.json \
 && rm -f /app/tools/config.json \
 && install -d -o atlas -g atlas /data

USER atlas
EXPOSE 8090

ENV ATLAS_BIND=0.0.0.0:8090 \
    ATLAS_DB_PATH=/data/atlas.db \
    ATLAS_DATA_DIR=/data \
    ATLAS_STATIC_DIR=/app \
    ATLAS_MANIFEST_CMD=/app/gpx-manifest.sh \
    ATLAS_SECURE_COOKIES=true

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "tools/api.py"]
