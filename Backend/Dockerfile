# Backend Django para despliegue en contenedor (alineado con el plan RASP en nube + Docker).
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=core.settings

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-rasp.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-rasp.txt gunicorn

COPY . .

# collectstatic en build (WhiteNoise sirve staticfiles/ en runtime). SECRET_KEY solo para esta fase;
# en Render define SECRET_KEY en Environment (sustituye al arrancar el contenedor).
ENV SECRET_KEY=collectstatic-build-only-not-secret
RUN python manage.py collectstatic --noinput

# Render (y otros PaaS) inyectan PORT; en local docker run sin PORT usa 8000.
EXPOSE 8000

# Datadog: no fijar DD_* ni API keys aquí. En producción configúralas en el orquestador / secretos
# (lista en backend/env.rasp.example). Si tu cuenta es US5: DD_SITE=us5.datadoghq.com
CMD ["sh", "-c", "gunicorn core.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers 3"]
