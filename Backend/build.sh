#!/usr/bin/env bash
# Render: Build Command (Root Directory = backend): bash build.sh
set -o errexit
# NO usar apt-get aquí: en Render el runtime "Python" monta el build en un FS donde
# /var/lib/apt/lists no es escribible → falla "Read-only file system".
# Para respaldos con pg_dump/pg_dumpall despliega con Docker usando backend/Dockerfile
# (incluye postgresql-client). En Dashboard: Settings → cambiar a Docker o nuevo servicio Docker.
pip install -r requirements.txt
python manage.py collectstatic --noinput
python manage.py migrate --noinput
