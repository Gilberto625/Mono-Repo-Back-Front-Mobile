from contextlib import nullcontext
from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from core.views import CitasView, _appointment_policy, _minimum_booking_date


class SequenceCursor:
    def __init__(self, rows):
        self.rows = iter(rows)

    def execute(self, _query, _params=None):
        return None

    def fetchone(self):
        return next(self.rows)


class AppointmentCursor:
    def __init__(self, final_conflict=False):
        self.query = ""
        self.params = []
        self.occupied_reads = 0
        self.final_conflict = final_conflict
        self.insert_params = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=None):
        self.query = " ".join(str(query).split()).lower()
        self.params = list(params or [])
        if "insert into negocio.cita (" in self.query:
            self.insert_params = self.params

    def fetchone(self):
        query = self.query
        if "from negocio.empleado e" in query:
            return (7, 1)
        if "from negocio.servicio s" in query:
            return (Decimal("100.00"), 60, True)
        if "from negocio.barbero_servicio" in query:
            return (1,)
        if "from negocio.horario_negocio" in query:
            return (True, time(9, 0), time(18, 0))
        if "from negocio.empleado_horario_dia" in query:
            return (True, time(9, 0), time(18, 0))
        if "from negocio.empleado_dia_libre" in query or "from negocio.empleado_vacacion" in query:
            return None
        if "from negocio.estado_cita" in query:
            return (4,)
        if "insert into negocio.cita (" in query:
            return (99,)
        if "to_char((c.fecha_hora" in query:
            return ("2026-06-08", "10:00")
        raise AssertionError(f"fetchone inesperado: {query}")

    def fetchall(self):
        if "from negocio.empleado_descanso" in self.query:
            return []
        if "from negocio.cita c" in self.query and "fecha_hora" in self.query:
            self.occupied_reads += 1
            if self.final_conflict and self.occupied_reads == 2:
                return [(time(10, 0), 60)]
            return []
        raise AssertionError(f"fetchall inesperado: {self.query}")


def policy(requires_deposit=False):
    return {
        "primera_cita": not requires_deposit,
        "penalizado": requires_deposit,
        "total_inasistencias": int(requires_deposit),
        "requiere_anticipo": requires_deposit,
        "porcentaje_anticipo": 50 if requires_deposit else 0,
        "citas_restantes_penalizacion": 10 if requires_deposit else 0,
        "citas_penalizacion_total": 10,
    }


class AppointmentRuleTests(SimpleTestCase):
    def setUp(self):
        self.factory = APIRequestFactory()
        self.user = SimpleNamespace(is_authenticated=True, username="cliente", email="cliente@example.test")

    def _create(self, cursor, appointment_policy, **untrusted):
        payload = {
            "cliente_id": 999,
            "barbero_id": 7,
            "servicio_id": 3,
            "fecha": "2026-06-08",
            "hora": "10:00",
            "precio_total": "0.01",
            "descuento": "99.99",
            "anticipo_monto": "0.01",
            **untrusted,
        }
        request = self.factory.post("/api/citas/", payload, format="json")
        force_authenticate(request, user=self.user)
        with (
            patch.object(CitasView, "_resolver_usuario_negocio_id", return_value=42),
            patch.object(CitasView, "_resolve_service_discount", return_value=(Decimal("0.00"), None, "")),
            patch.object(CitasView, "_registrar_desfase_horario_si_aplica"),
            patch("core.views._appointment_policy", return_value=appointment_policy),
            patch("core.views.timezone.localdate", return_value=date(2026, 6, 1)),
            patch("core.views.transaction", SimpleNamespace(atomic=lambda: nullcontext())),
            patch("core.views.connection", SimpleNamespace(cursor=lambda: cursor)),
        ):
            return CitasView.as_view()(request)

    def test_first_appointment_ignores_frontend_amounts_and_has_no_deposit(self):
        cursor = AppointmentCursor()
        response = self._create(cursor, policy(False))
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["precio_total"], 100.0)
        self.assertEqual(response.data["descuento"], 0.0)
        self.assertEqual(response.data["anticipo_requerido"], 0.0)
        self.assertEqual(response.data["monto_restante"], 100.0)
        self.assertEqual(cursor.insert_params[0], 42)
        self.assertEqual(cursor.insert_params[6], Decimal("100.00"))

    def test_penalized_client_requires_fifty_percent_deposit(self):
        response = self._create(AppointmentCursor(), policy(True))
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["requiere_anticipo"])
        self.assertEqual(response.data["porcentaje_anticipo"], 50)
        self.assertEqual(response.data["anticipo_requerido"], 50.0)
        self.assertEqual(response.data["monto_restante"], 50.0)

    def test_penalty_is_released_after_ten_completed_appointments(self):
        last_no_show = (5, date(2026, 1, 1))
        cursor = SequenceCursor([(12,), last_no_show, (1,), (10,)])
        result = _appointment_policy(cursor, 42)
        self.assertFalse(result["penalizado"])
        self.assertFalse(result["requiere_anticipo"])

    def test_policy_marks_first_appointment_without_deposit(self):
        result = _appointment_policy(SequenceCursor([(0,), None, (0,)]), 42)
        self.assertTrue(result["primera_cita"])
        self.assertFalse(result["requiere_anticipo"])

    def test_policy_keeps_penalty_until_ten_completed_appointments(self):
        last_no_show = (5, date(2026, 1, 1))
        result = _appointment_policy(SequenceCursor([(11,), last_no_show, (1,), (9,)]), 42)
        self.assertTrue(result["penalizado"])
        self.assertEqual(result["porcentaje_anticipo"], 50)
        self.assertEqual(result["citas_restantes_penalizacion"], 1)

    def test_booking_advance_is_three_days_on_high_demand_and_one_otherwise(self):
        with patch("core.views.timezone.localdate", return_value=date(2026, 6, 1)):
            for appointment_date in (date(2026, 6, 5), date(2026, 6, 6), date(2026, 6, 7)):
                self.assertEqual(_minimum_booking_date(appointment_date), (date(2026, 6, 4), 3))
            for appointment_date in (date(2026, 6, 8), date(2026, 6, 9), date(2026, 6, 10), date(2026, 6, 11)):
                self.assertEqual(_minimum_booking_date(appointment_date), (date(2026, 6, 2), 1))

    def test_final_revalidation_rejects_double_booking(self):
        cursor = AppointmentCursor(final_conflict=True)
        response = self._create(cursor, policy(False))
        self.assertEqual(response.status_code, 409)
        self.assertIn("otra reserva", response.data["error"])
        self.assertIsNone(cursor.insert_params)
