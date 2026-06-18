"""
WSGI config for core project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/
"""

import os
from pathlib import Path

# decouple lee .env para settings pero no rellena os.environ; ddtrace solo usa el entorno del proceso.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
except ImportError:
    pass

# Datadog APM + App and API Protection (RASP / exploit prevention) cuando DD_TRACE_ENABLED o DD_APPSEC_ENABLED.
if os.environ.get("DD_TRACE_ENABLED", "").lower() in ("1", "true", "yes") or os.environ.get(
    "DD_APPSEC_ENABLED", ""
).lower() in ("1", "true", "yes"):
    try:
        import ddtrace.auto  # noqa: F401 — instrumentación al importar
    except ImportError:
        pass

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')

application = get_wsgi_application()
