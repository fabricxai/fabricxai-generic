# Postgres 16 + pgvector + pgBackRest.
#
# WHY this image exists at all, when everything else in the stack is pulled by digest:
# `archive_command` is executed by Postgres itself, as a child of the postmaster, inside
# the postgres container. There is no arrangement in which a sidecar can archive WAL —
# a sidecar that copies from a shared spool directory would have to tell Postgres the
# segment was archived BEFORE it reached the repository, and a segment Postgres believes
# is archived is a segment it will recycle. That is silent data loss with a green
# dashboard, which is the exact failure this whole layer exists to prevent.
#
# So pgbackrest has to be in this image. The cost is one `docker compose build postgres`
# on first bring-up and after a base-image bump; docs/runbooks/deploy.md §3 says so.
#
# The base already carries the PGDG apt repository (it is how the official postgres
# images install the server), so pgbackrest comes from the same source Postgres does and
# stays version-compatible with it.
FROM pgvector/pgvector:pg16

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends pgbackrest; \
    rm -rf /var/lib/apt/lists/*; \
    pgbackrest version

# Owned by postgres, because that is the uid both the archive_command (inside this
# container) and the `backup` service (a second container from this same image, running
# as postgres) write them as. Named volumes mount over these paths and inherit the
# ownership set here — which is the only reason the first archive-push does not fail
# with a permission error on a directory root created.
RUN install -d -o postgres -g postgres -m 0750 \
      /var/log/pgbackrest \
      /var/spool/pgbackrest \
      /etc/pgbackrest

# Inherits the base image's ENTRYPOINT (docker-entrypoint.sh) and CMD (postgres)
# deliberately: this is the same database server, with one more binary on the PATH.
