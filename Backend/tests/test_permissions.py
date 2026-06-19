from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from core.admin_views import AdminDashboardView
from core.views import ClipPagoIntentarView, MeView, SecretariaDashboardView


def authenticated_user(username="cliente"):
    return SimpleNamespace(
        is_authenticated=True,
        username=username,
        email=f"{username}@example.test",
        is_staff=False,
        is_superuser=False,
    )


class PermissionRegressionTests(SimpleTestCase):
    def setUp(self):
        self.factory = APIRequestFactory()

    def test_private_endpoint_rejects_anonymous_user(self):
        response = MeView.as_view()(self.factory.get("/api/auth/me/"))
        self.assertIn(response.status_code, {401, 403})

    def test_admin_endpoint_rejects_non_admin_role(self):
        request = self.factory.get("/api/admin/dashboard/")
        force_authenticate(request, user=authenticated_user())
        with patch("core.permissions.get_business_role", return_value="cliente"):
            response = AdminDashboardView.as_view()(request)
        self.assertEqual(response.status_code, 403)

    def test_secretary_endpoint_rejects_client_and_barber(self):
        for role in ("cliente", "barbero"):
            with self.subTest(role=role):
                request = self.factory.get("/api/secretaria/dashboard/")
                force_authenticate(request, user=authenticated_user(role))
                with patch("core.permissions.get_business_role", return_value=role):
                    response = SecretariaDashboardView.as_view()(request)
                self.assertEqual(response.status_code, 403)

    def test_client_cannot_request_another_clients_order_payment(self):
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.__exit__.return_value = False
        cursor.fetchone.return_value = None
        request = self.factory.post(
            "/api/pagos/clip/intentar/",
            {"tipo": "pedido", "pedido_id": 77, "monto": "0.01"},
            format="json",
        )
        force_authenticate(request, user=authenticated_user())
        view = ClipPagoIntentarView.as_view()
        with (
            patch.object(ClipPagoIntentarView, "_cargar_clip_config", return_value={"clip_habilitado": True}),
            patch.object(ClipPagoIntentarView, "_get_negocio_usuario_id", return_value=42),
            patch("core.views.connection", SimpleNamespace(cursor=lambda: cursor)),
        ):
            response = view(request)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(cursor.execute.call_args.args[1], [77, 42])
