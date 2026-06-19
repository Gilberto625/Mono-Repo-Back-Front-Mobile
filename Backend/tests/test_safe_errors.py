import ast
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.db import DatabaseError
from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from core.views import CitasView


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class SafeErrorTests(SimpleTestCase):
    def test_responses_do_not_serialize_exception_objects(self):
        violations = []
        for relative in ("core/views.py", "core/admin_views.py", "core/public_views.py"):
            source = (BACKEND_ROOT / relative).read_text(encoding="utf-8")
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                name = getattr(node.func, "id", "") or getattr(node.func, "attr", "")
                if name != "Response":
                    continue
                response_source = ast.get_source_segment(source, node) or ""
                if any(token in response_source for token in ("str(exc)", "repr(exc)", "traceback", "{exc}")):
                    violations.append((relative, node.lineno))
        self.assertEqual(violations, [])

    def test_database_failure_returns_generic_message(self):
        request = APIRequestFactory().post(
            "/api/citas/",
            {"barbero_id": 7, "servicio_id": 3, "fecha": "2026-06-08", "hora": "10:00"},
            format="json",
        )
        force_authenticate(
            request,
            user=SimpleNamespace(is_authenticated=True, username="cliente", email="cliente@example.test"),
        )
        technical_detail = "password authentication failed for user neon_owner"
        with (
            patch.object(CitasView, "_resolver_usuario_negocio_id", return_value=42),
            patch("core.views.timezone.localdate", return_value=__import__("datetime").date(2026, 6, 1)),
            patch("core.views.transaction", SimpleNamespace(atomic=lambda: nullcontext())),
            patch(
                "core.views.connection",
                SimpleNamespace(cursor=lambda: (_ for _ in ()).throw(DatabaseError(technical_detail))),
            ),
        ):
            response = CitasView.as_view()(request)
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.data["error"], "No se pudo crear la cita.")
        self.assertNotIn(technical_detail, str(response.data))
