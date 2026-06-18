"""
ASGI config for core project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/
"""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
except ImportError:
    pass

if os.environ.get("DD_TRACE_ENABLED", "").lower() in ("1", "true", "yes") or os.environ.get(
    "DD_APPSEC_ENABLED", ""
).lower() in ("1", "true", "yes"):
    try:
        import ddtrace.auto  # noqa: F401
    except ImportError:
        pass

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')

application = get_asgi_application()
