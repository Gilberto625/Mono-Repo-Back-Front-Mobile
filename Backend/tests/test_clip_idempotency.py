import hashlib
import hmac
import json
from contextlib import nullcontext
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory

from core.views import ClipPagoIntentarView, ClipWebhookView


class ClipCursor:
    def __init__(self, notes):
        self.notes = notes
        self.query = ""

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=None):
        self.query = " ".join(str(query).split()).lower()
        if self.query.startswith("update negocio.pedido set notas"):
            self.notes = params[0]

    def fetchone(self):
        if "select coalesce(notas" in self.query:
            return (self.notes,)
        raise AssertionError(f"fetchone inesperado: {self.query}")


def expected_note(reference="SBC-PED-7-1", amount="100.00", payment_request_id="pr-1"):
    payload = {
        "reference": reference,
        "monto_cobrar": amount,
        "payment_request_id": payment_request_id,
    }
    return f"[CLIP_PAGO_REGISTRO]{json.dumps(payload)}"


class ClipIdempotencyTests(SimpleTestCase):
    def setUp(self):
        self.view = ClipPagoIntentarView()
        self.reference = "SBC-PED-7-1"

    def _process(self, cursor, *, status="completed", amount="100.00", amount_present=True, identity=None, source="webhook"):
        identity = identity or {
            "reference": self.reference,
            "payment_request_id": "pr-1",
            "transaction_id": "tx-1",
            "receipt_no": "receipt-1",
        }
        with (
            patch("core.views.transaction", SimpleNamespace(atomic=lambda: nullcontext())),
            patch("core.views.connection", SimpleNamespace(cursor=lambda: cursor)),
            patch.object(self.view, "_descontar_stock_pedido_si_no_aplicado", return_value=(True, "")) as stock,
        ):
            result = self.view._process_clip_payment_once(
                tipo="pedido",
                target_id=7,
                actor_id=42,
                reference=self.reference,
                status_value=status,
                identity=identity,
                received_amount=Decimal(amount),
                amount_present=amount_present,
                source=source,
            )
        return result, stock

    def test_payment_id_alone_does_not_confirm_without_amount_or_trusted_match(self):
        cursor = ClipCursor(expected_note(payment_request_id=""))
        result, stock = self._process(
            cursor,
            amount="0",
            amount_present=False,
            identity={"reference": "", "payment_request_id": "", "transaction_id": "tx-only", "receipt_no": ""},
        )
        self.assertEqual(result["result"], "pending")
        stock.assert_not_called()

    def test_only_success_statuses_confirm(self):
        for status in ("created", "pending", "declined", "cancelled"):
            with self.subTest(status=status):
                result, stock = self._process(ClipCursor(expected_note()), status=status)
                self.assertEqual(result["result"], "pending")
                stock.assert_not_called()
        for status in ("approved", "paid", "completed"):
            with self.subTest(status=status):
                result, stock = self._process(ClipCursor(expected_note()), status=status)
                self.assertEqual(result["result"], "confirmed")
                stock.assert_called_once()

    def test_repeated_direct_and_webhook_processing_is_idempotent(self):
        cursor = ClipCursor(expected_note())
        first, first_stock = self._process(cursor, source="consulta_directa")
        second, second_stock = self._process(cursor, source="webhook")
        self.assertEqual(first["result"], "confirmed")
        self.assertEqual(second["result"], "idempotent")
        first_stock.assert_called_once()
        second_stock.assert_not_called()
        self.assertEqual(cursor.notes.count("[CLIP_PAGO_CONFIRMADO]"), 1)

    def test_amount_mismatch_is_marked_inconsistent_without_confirmation(self):
        cursor = ClipCursor(expected_note())
        result, stock = self._process(cursor, amount="99.99")
        self.assertEqual(result, {"result": "suspicious", "reason": "amount_mismatch"})
        stock.assert_not_called()
        self.assertIn("[CLIP_PAGO_INCONSISTENTE]", cursor.notes)
        self.assertNotIn("[CLIP_PAGO_CONFIRMADO]", cursor.notes)

    def test_missing_amount_confirms_only_with_trusted_reference_or_request(self):
        trusted_cursor = ClipCursor(expected_note())
        trusted, trusted_stock = self._process(trusted_cursor, amount="0", amount_present=False)
        self.assertEqual(trusted["result"], "confirmed")
        trusted_stock.assert_called_once()

        untrusted_cursor = ClipCursor(expected_note())
        untrusted, untrusted_stock = self._process(
            untrusted_cursor,
            amount="0",
            amount_present=False,
            identity={"reference": "", "payment_request_id": "other", "transaction_id": "tx-2", "receipt_no": ""},
        )
        self.assertEqual(untrusted["result"], "suspicious")
        untrusted_stock.assert_not_called()

    @override_settings(CLIP_WEBHOOK_SECRET="unit-test-webhook-secret")
    def test_signed_repeated_webhook_returns_idempotent_without_second_persistence(self):
        payload = {
            "status": "completed",
            "reference": self.reference,
            "payment_request_id": "pr-1",
            "transaction_id": "tx-1",
            "amount": "100.00",
        }
        factory = APIRequestFactory()

        def signed_request():
            request = factory.post("/api/pagos/clip/webhook/", payload, format="json")
            signature = hmac.new(
                b"unit-test-webhook-secret", request.body, hashlib.sha256
            ).hexdigest()
            request.META["HTTP_X_CLIP_SIGNATURE"] = signature
            return request

        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.__exit__.return_value = False
        cursor.fetchone.return_value = (42,)
        processing = [
            {"result": "confirmed", "expected_amount": Decimal("100.00")},
            {"result": "idempotent", "expected_amount": Decimal("100.00")},
        ]
        with (
            patch("core.views.connection", SimpleNamespace(cursor=lambda: cursor)),
            patch.object(ClipPagoIntentarView, "_process_clip_payment_once", side_effect=processing) as process,
            patch.object(ClipPagoIntentarView, "_save_external_payment_if_available", return_value=True) as save,
        ):
            first = ClipWebhookView.as_view()(signed_request())
            second = ClipWebhookView.as_view()(signed_request())

        self.assertEqual(first.status_code, 200)
        self.assertFalse(first.data["idempotente"])
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.data["idempotente"])
        self.assertEqual(process.call_count, 2)
        save.assert_called_once()
