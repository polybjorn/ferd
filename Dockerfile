# Ferd - self-hosted Leaflet map for places and GPX trails.
# Stdlib-only Python; no pip install step.

FROM python:3.12-slim

LABEL org.opencontainers.image.title="Ferd" \
      org.opencontainers.image.description="Self-hosted personal map for places and GPX trails." \
      org.opencontainers.image.source="https://github.com/polybjorn/ferd" \
      org.opencontainers.image.licenses="MIT"

# tini gives clean signal handling. gosu drops privileges in the entrypoint
# after handling PUID/PGID. No bash; gpx-manifest.sh is POSIX sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini gosu \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. UID/GID 1000 by default; overridable via PUID/PGID
# env vars handled in docker-entrypoint.sh.
RUN useradd --uid 1000 --home /app --shell /usr/sbin/nologin ferd

WORKDIR /app
COPY --chown=ferd:ferd . /app

# Make /app/site-config.json a symlink into the data volume. The frontend
# fetches it as a static asset, the API writes it through data_dir, so they
# must resolve to the same file. _serve_static follows symlinks by design.
RUN rm -f /app/site-config.json \
 && ln -s /data/site-config.json /app/site-config.json \
 && rm -f /app/tools/config.json \
 && install -d -o ferd -g ferd /data \
 && install -m 0755 /app/deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 8090

ENV FERD_BIND=0.0.0.0:8090 \
    FERD_DB_PATH=/data/app.db \
    FERD_DATA_DIR=/data \
    FERD_STATIC_DIR=/app \
    FERD_MANIFEST_CMD=/app/scripts/gpx-manifest.sh \
    FERD_SECURE_COOKIES=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/', timeout=3)" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python3", "tools/api.py"]
