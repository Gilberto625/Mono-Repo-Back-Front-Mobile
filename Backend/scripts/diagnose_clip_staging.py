"""
Diagnóstico Clip staging — solo nombres de variables, sin valores secretos.
Ejecutar: USE_LOCAL_DB=False python scripts/diagnose_clip_staging.py
"""
import os
import sys

import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.conf import settings
from django.db import connection

from core.views import ClipPagoIntentarView

CLIP_ENV_VARS = [
    "CLIP_API_KEY",
    "CLIP_API_SECRET",
    "CLIP_AUTH_TOKEN",
    "CLIP_API_BASE_URL",
    "CLIP_API_BASE_URL_ALT",
    "CLIP_CHECKOUT_CREATE_PATH",
    "CLIP_CHECKOUT_CREATE_URL",
    "CLIP_PAYMENTS_URL",
    "CLIP_PAYMENTS_URL_ALT",
    "CLIP_WEBHOOK_URL",
    "CLIP_WEBHOOK_SECRET",
    "CLIP_RETURN_SUCCESS_URL",
    "CLIP_RETURN_CANCEL_URL",
    "CLIP_HTTP_USER_AGENT",
]


def mask_present(value) -> str:
    s = str(value or "").strip()
    return "SET" if s else "MISSING"


def main():
    print("=== Clip staging diagnosis (no secret values) ===")
    for name in CLIP_ENV_VARS:
        val = getattr(settings, name, None)
        print(f"ENV_{name}={mask_present(val)}")

    view = ClipPagoIntentarView()
    clip_cfg = view._cargar_clip_config()
    print(f"DB_clip_habilitado={clip_cfg.get('clip_habilitado')}")
    print(f"DB_clip_url={'SET' if clip_cfg.get('clip_url') else 'MISSING'}")
    print(f"DB_clip_api_key={mask_present(clip_cfg.get('clip_api_key'))}")
    print(f"DB_clip_api_secret={mask_present(clip_cfg.get('clip_api_secret'))}")
    print(f"DB_clip_auth_token={mask_present(clip_cfg.get('clip_auth_token'))}")

    api_key, api_secret = view._clip_resolve_api_credentials(clip_cfg)
    print(f"RESOLVED_api_key={mask_present(api_key)}")
    print(f"RESOLVED_api_secret={mask_present(api_secret)}")

    if api_key and api_secret:
        token = view._clip_oauth_access_token(api_key, api_secret)
        print(f"OAUTH_access_token={'OK' if token else 'FAILED'}")
    else:
        print("OAUTH_access_token=SKIPPED (missing key/secret)")

    base = str(getattr(settings, "CLIP_API_BASE_URL", "") or "").strip()
    path = str(getattr(settings, "CLIP_CHECKOUT_CREATE_PATH", "") or "").strip()
    checkout_url_setting = str(getattr(settings, "CLIP_CHECKOUT_CREATE_URL", "") or "").strip()
    print(f"CHECKOUT_endpoint_primary={'SET' if checkout_url_setting else f'{base}{path}' if base else 'MISSING'}")
    print(f"PAYMENTS_url={'SET' if getattr(settings, 'CLIP_PAYMENTS_URL', '') else 'MISSING'}")

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT EXISTS (
                    SELECT 1 FROM negocio.red_social_negocio
                    WHERE plataforma = 'otro' AND activa = TRUE
                )
                """
            )
            print(f"DB_config_extra_row={'OK' if cursor.fetchone()[0] else 'MISSING'}")
    except Exception as exc:
        print(f"DB_config_extra_row=ERROR:{type(exc).__name__}")


if __name__ == "__main__":
    main()
