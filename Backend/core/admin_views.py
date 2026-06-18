import json
import logging
import re
import math
import hashlib
import base64
import csv
import io
import secrets
import zipfile
import os
import subprocess
import tempfile
import shutil
from datetime import date, timedelta
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from django.core.cache import cache
from core.mail_utils import build_otp_email_pair, send_stylo_transactional
from core.upload_utils import is_allowed_image_upload
from django.core.signing import TimestampSigner

import cloudinary
import cloudinary.uploader
from cryptography.fernet import Fernet, InvalidToken
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.conf import settings
from django.db import DatabaseError, connection, transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from decouple import config

try:
    from psycopg.sql import SQL, Identifier
except ImportError:
    from psycopg2.sql import SQL, Identifier

from .public_views import db_structure_error_response

logger = logging.getLogger(__name__)


def _clip_cipher() -> Fernet:
    # Deriva una llave simétrica desde SECRET_KEY para cifrar credenciales Clip en BD.
    seed = hashlib.sha256(str(getattr(settings, "SECRET_KEY", "")).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(seed))


def _clip_encrypt(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return _clip_cipher().encrypt(raw.encode("utf-8")).decode("utf-8")


def _clip_decrypt(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    try:
        return _clip_cipher().decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return ""


class AdminSillasView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return str(row[0] or "") if row else ""

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def _get_empresa_id(self) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT empresa_id
                FROM negocio.empresa
                ORDER BY empresa_id ASC
                LIMIT 1
                """
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            empresa_id = self._get_empresa_id()
            if not empresa_id:
                return Response({"detail": "No existe empresa configurada."}, status=404)

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        s.silla_id,
                        s.numero,
                        COALESCE(s.nombre, ''),
                        s.activa,
                        e.empleado_id,
                        TRIM(
                            CONCAT(
                                COALESCE(pp.nombres, ''),
                                ' ',
                                COALESCE(pp.apellido_paterno, ''),
                                ' ',
                                COALESCE(pp.apellido_materno, '')
                            )
                        ) AS empleado_nombre,
                        COALESCE(u.username, '')
                    FROM negocio.silla s
                    LEFT JOIN LATERAL (
                        SELECT em.empleado_id, em.usuario_id
                        FROM negocio.empleado em
                        WHERE em.silla_id = s.silla_id
                          AND em.activo = TRUE
                        ORDER BY em.empleado_id DESC
                        LIMIT 1
                    ) e ON TRUE
                    LEFT JOIN negocio.usuario u
                      ON u.usuario_id = e.usuario_id
                    LEFT JOIN negocio.perfil_persona pp
                      ON pp.usuario_id = u.usuario_id
                    WHERE s.empresa_id = %s
                      AND s.activa = TRUE
                    ORDER BY s.silla_id ASC
                    """,
                    [empresa_id],
                )
                rows = cursor.fetchall()

            sillas = [
                {
                    "id": int(row[0]),
                    "numero": row[1],
                    "nombre": row[2],
                    "activa": bool(row[3]),
                    "ocupada": row[4] is not None,
                    "ocupada_por_empleado_id": int(row[4]) if row[4] is not None else None,
                    "ocupada_por": (row[5] or row[6] or "").strip(),
                }
                for row in rows
            ]
            return Response({"ok": True, "sillas": sillas})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        numero = str(data.get("numero", "")).strip()
        nombre = str(data.get("nombre", "")).strip()

        if not numero:
            return Response({"error": "El numero de silla es obligatorio."}, status=400)

        try:
            empresa_id = self._get_empresa_id()
            if not empresa_id:
                return Response({"error": "No existe empresa configurada."}, status=404)

            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT silla_id, activa
                        FROM negocio.silla
                        WHERE empresa_id = %s AND numero = %s
                        LIMIT 1
                        """,
                        [empresa_id, numero],
                    )
                    existente = cursor.fetchone()

                    if existente and bool(existente[1]):
                        return Response({"error": "Ya existe una silla con ese numero."}, status=400)

                    if existente and not bool(existente[1]):
                        silla_id = int(existente[0])
                        cursor.execute(
                            """
                            UPDATE negocio.silla
                            SET
                                nombre = %s,
                                activa = TRUE
                            WHERE silla_id = %s
                            """,
                            [nombre or None, silla_id],
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO negocio.silla (empresa_id, numero, nombre, activa)
                            VALUES (%s, %s, %s, TRUE)
                            RETURNING silla_id
                            """,
                            [empresa_id, numero, nombre or None],
                        )
                        silla_id = int(cursor.fetchone()[0])

            return Response(
                {
                    "ok": True,
                    "silla": {
                        "id": silla_id,
                        "numero": numero,
                        "nombre": nombre,
                        "activa": True,
                    },
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminMarcasView(APIView):
    """Lista y crea marcas de productos. Acceso admin y secretaria."""
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return str(row[0] or "") if row else ""

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT marca_id, nombre, activa
                    FROM negocio.marca
                    ORDER BY nombre ASC
                    """,
                )
                rows = cursor.fetchall()
            marcas = [
                {"id": int(row[0]), "nombre": row[1] or "", "activa": bool(row[2])}
                for row in rows
            ]
            return Response({"ok": True, "marcas": marcas})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        nombre = str(data.get("nombre", "")).strip()
        if not nombre:
            return Response({"error": "El nombre de la marca es obligatorio."}, status=400)
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT marca_id FROM negocio.marca
                        WHERE LOWER(nombre) = LOWER(%s) LIMIT 1
                        """,
                        [nombre],
                    )
                    existente = cursor.fetchone()
                    if existente:
                        return Response({"error": "Ya existe una marca con ese nombre."}, status=400)
                    cursor.execute(
                        """
                        INSERT INTO negocio.marca (nombre, activa)
                        VALUES (%s, TRUE)
                        RETURNING marca_id
                        """,
                        [nombre],
                    )
                    marca_id = int(cursor.fetchone()[0])
            return Response({
                "ok": True,
                "marca": {"id": marca_id, "nombre": nombre, "activa": True},
            })
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminSillaDetalleView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return str(row[0] or "") if row else ""

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def delete(self, request, silla_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT silla_id
                        FROM negocio.silla
                        WHERE silla_id = %s
                        LIMIT 1
                        """,
                        [silla_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"error": "Silla no encontrada."}, status=404)

                    # Si hay empleados con esta silla, se desasignan antes de desactivar.
                    cursor.execute(
                        """
                        UPDATE negocio.empleado
                        SET silla_id = NULL
                        WHERE silla_id = %s
                        """,
                        [silla_id],
                    )
                    cursor.execute(
                        """
                        UPDATE negocio.silla
                        SET activa = FALSE
                        WHERE silla_id = %s
                        """,
                        [silla_id],
                    )

            return Response({"ok": True, "detail": "Silla desactivada correctamente."})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminPromocionesView(APIView):
    permission_classes = [IsAuthenticated]

    TIPOS_DESCUENTO = {"porcentaje", "monto_fijo", "2x1", "producto_gratis"}
    APLICA_EN = {"servicios", "productos", "ambos"}
    ESTADOS_VALIDOS = {"activas", "programadas", "finalizadas", "pausadas", "todas"}

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _to_bool(self, value: Any, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        return str(value).strip().lower() in {"1", "true", "t", "si", "sí", "yes", "on"}

    def _to_float(self, value: Any, default: float = 0.0) -> float:
        try:
            if value is None or str(value).strip() == "":
                return float(default)
            return float(value)
        except (ValueError, TypeError):
            return float(default)

    def _to_int(self, value: Any, default: int | None = None) -> int | None:
        try:
            if value is None or str(value).strip() == "":
                return default
            return int(value)
        except (ValueError, TypeError):
            return default

    def _normalizar_aplica_en(self, raw: Any) -> str:
        aplica_en = str(raw or "").strip().lower()
        if aplica_en in {"todos", "todo", "ambas"}:
            return "ambos"
        return aplica_en

    def _estado_promocion(self, activa: bool, fecha_inicio: date, fecha_fin: date) -> str:
        hoy = date.today()
        if not activa:
            return "pausada"
        if fecha_inicio > hoy:
            return "programada"
        if fecha_fin < hoy:
            return "finalizada"
        return "activa"

    def _serialize_promocion_row(self, row: Any) -> dict[str, Any]:
        (
            promocion_id,
            nombre,
            descripcion,
            tipo_descuento,
            aplica_en,
            valor_descuento,
            codigo,
            fecha_inicio,
            fecha_fin,
            solo_clientes_nuevos,
            requiere_compra_minima,
            monto_compra_minima,
            limite_usos,
            usos_actuales,
            activa,
        ) = row
        return {
            "id": int(promocion_id),
            "nombre": nombre or "",
            "descripcion": descripcion or "",
            "tipo_descuento": tipo_descuento,
            "aplica_en": aplica_en,
            "valor_descuento": float(valor_descuento or 0),
            "codigo": codigo or "",
            "fecha_inicio": str(fecha_inicio),
            "fecha_fin": str(fecha_fin),
            "solo_clientes_nuevos": bool(solo_clientes_nuevos),
            "requiere_compra_minima": bool(requiere_compra_minima),
            "monto_compra_minima": float(monto_compra_minima) if monto_compra_minima is not None else None,
            "limite_usos": int(limite_usos) if limite_usos is not None else None,
            "usos_actuales": int(usos_actuales or 0),
            "activa": bool(activa),
            "estado": self._estado_promocion(bool(activa), fecha_inicio, fecha_fin),
        }

    def _get_promocion_by_id(self, promocion_id: int) -> dict[str, Any] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    promocion_id,
                    nombre,
                    descripcion,
                    tipo_descuento,
                    aplica_en,
                    valor_descuento,
                    codigo,
                    fecha_inicio,
                    fecha_fin,
                    solo_clientes_nuevos,
                    requiere_compra_minima,
                    monto_compra_minima,
                    limite_usos,
                    usos_actuales,
                    activa
                FROM negocio.promocion
                WHERE promocion_id = %s
                LIMIT 1
                """,
                [promocion_id],
            )
            row = cursor.fetchone()
        return self._serialize_promocion_row(row) if row else None

    def _validar_payload(self, data: dict[str, Any], parcial: bool = False) -> tuple[dict[str, Any], str | None]:
        payload: dict[str, Any] = {}

        if not parcial or "nombre" in data:
            nombre = str(data.get("nombre", "")).strip()
            if len(nombre) < 3:
                return {}, "El nombre de la promoción debe tener al menos 3 caracteres."
            payload["nombre"] = nombre

        if not parcial or "descripcion" in data:
            payload["descripcion"] = str(data.get("descripcion", "")).strip() or None

        if not parcial or "tipo_descuento" in data:
            tipo_descuento = str(data.get("tipo_descuento", "")).strip().lower()
            if tipo_descuento not in self.TIPOS_DESCUENTO:
                return {}, "Tipo de descuento inválido."
            payload["tipo_descuento"] = tipo_descuento

        if not parcial or "aplica_en" in data:
            aplica_en = self._normalizar_aplica_en(data.get("aplica_en"))
            if aplica_en not in self.APLICA_EN:
                return {}, "El campo 'aplica_en' debe ser servicios, productos o ambos."
            payload["aplica_en"] = aplica_en

        if not parcial or "valor_descuento" in data:
            valor_descuento = self._to_float(data.get("valor_descuento"), default=-1)
            if valor_descuento < 0:
                return {}, "El valor del descuento no puede ser negativo."
            payload["valor_descuento"] = round(valor_descuento, 2)

        if not parcial or "codigo" in data:
            codigo_raw = str(data.get("codigo", "")).strip().upper()
            payload["codigo"] = codigo_raw or None

        if not parcial or "fecha_inicio" in data:
            fecha_inicio = str(data.get("fecha_inicio", "")).strip()
            if not fecha_inicio:
                return {}, "La fecha de inicio es obligatoria."
            payload["fecha_inicio"] = fecha_inicio

        if not parcial or "fecha_fin" in data:
            fecha_fin = str(data.get("fecha_fin", "")).strip()
            if not fecha_fin:
                return {}, "La fecha de fin es obligatoria."
            payload["fecha_fin"] = fecha_fin

        if ("fecha_inicio" in payload) and ("fecha_fin" in payload):
            if payload["fecha_fin"] < payload["fecha_inicio"]:
                return {}, "La fecha de fin no puede ser menor que la fecha de inicio."

        if not parcial or "solo_clientes_nuevos" in data:
            payload["solo_clientes_nuevos"] = self._to_bool(data.get("solo_clientes_nuevos"), default=False)

        if not parcial or "requiere_compra_minima" in data:
            payload["requiere_compra_minima"] = self._to_bool(data.get("requiere_compra_minima"), default=False)

        if (not parcial) or ("monto_compra_minima" in data) or ("requiere_compra_minima" in data):
            monto_compra_minima = self._to_float(data.get("monto_compra_minima"), default=0)
            requiere_compra_minima = payload.get("requiere_compra_minima")
            if requiere_compra_minima is None:
                requiere_compra_minima = self._to_bool(data.get("requiere_compra_minima"), default=False)
            if requiere_compra_minima and monto_compra_minima <= 0:
                return {}, "El monto mínimo debe ser mayor a 0."
            payload["monto_compra_minima"] = round(monto_compra_minima, 2) if requiere_compra_minima else None

        if not parcial or "limite_usos" in data:
            limite_usos = self._to_int(data.get("limite_usos"), default=None)
            if limite_usos is not None and limite_usos <= 0:
                return {}, "El límite de usos debe ser mayor a 0."
            payload["limite_usos"] = limite_usos

        if not parcial or "activa" in data:
            payload["activa"] = self._to_bool(data.get("activa"), default=True)

        tipo_descuento = payload.get("tipo_descuento")
        valor_descuento = payload.get("valor_descuento")
        if tipo_descuento == "porcentaje" and valor_descuento is not None:
            if valor_descuento <= 0 or valor_descuento > 100:
                return {}, "El descuento en porcentaje debe estar entre 0.01 y 100."

        return payload, None

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        estado = str(request.query_params.get("estado", "todas") or "todas").strip().lower()
        if estado not in self.ESTADOS_VALIDOS:
            estado = "todas"

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        promocion_id,
                        nombre,
                        descripcion,
                        tipo_descuento,
                        aplica_en,
                        valor_descuento,
                        codigo,
                        fecha_inicio,
                        fecha_fin,
                        solo_clientes_nuevos,
                        requiere_compra_minima,
                        monto_compra_minima,
                        limite_usos,
                        usos_actuales,
                        activa
                    FROM negocio.promocion
                    ORDER BY fecha_inicio DESC, promocion_id DESC
                    """
                )
                rows = cursor.fetchall()
                promociones_todas = [self._serialize_promocion_row(row) for row in rows]
                promociones = promociones_todas

                if estado != "todas":
                    mapa = {
                        "activas": "activa",
                        "programadas": "programada",
                        "finalizadas": "finalizada",
                        "pausadas": "pausada",
                    }
                    promociones = [p for p in promociones if p["estado"] == mapa[estado]]

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(descuento_monto), 0)
                    FROM negocio.pedido
                    WHERE DATE_TRUNC('month', fecha_creacion) = DATE_TRUNC('month', CURRENT_DATE)
                    """
                )
                total_descuentos_mes = float((cursor.fetchone() or [0])[0] or 0)

            estadisticas = {
                "promociones_activas": sum(1 for p in promociones_todas if p["estado"] == "activa"),
                "promociones_programadas": sum(1 for p in promociones_todas if p["estado"] == "programada"),
                "promociones_finalizadas": sum(1 for p in promociones_todas if p["estado"] == "finalizada"),
                "promociones_pausadas": sum(1 for p in promociones_todas if p["estado"] == "pausada"),
                "usos_total": sum(int(p["usos_actuales"]) for p in promociones_todas),
                "descuentos_aplicados_mes": round(total_descuentos_mes, 2),
            }

            return Response({"ok": True, "promociones": promociones, "estadisticas": estadisticas})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        payload, error = self._validar_payload(data, parcial=False)
        if error:
            return Response({"error": error}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO negocio.promocion (
                            nombre,
                            descripcion,
                            tipo_descuento,
                            aplica_en,
                            valor_descuento,
                            codigo,
                            fecha_inicio,
                            fecha_fin,
                            solo_clientes_nuevos,
                            requiere_compra_minima,
                            monto_compra_minima,
                            limite_usos,
                            activa
                        )
                        VALUES (%s, %s, %s, %s, %s, NULLIF(%s, ''), %s, %s, %s, %s, %s, %s, %s)
                        RETURNING promocion_id
                        """,
                        [
                            payload["nombre"],
                            payload["descripcion"],
                            payload["tipo_descuento"],
                            payload["aplica_en"],
                            payload["valor_descuento"],
                            payload["codigo"] or "",
                            payload["fecha_inicio"],
                            payload["fecha_fin"],
                            payload["solo_clientes_nuevos"],
                            payload["requiere_compra_minima"],
                            payload["monto_compra_minima"],
                            payload["limite_usos"],
                            payload["activa"],
                        ],
                    )
                    promocion_id = int(cursor.fetchone()[0])
            promocion = self._get_promocion_by_id(promocion_id)
            return Response({"ok": True, "promocion": promocion}, status=201)
        except DatabaseError as exc:
            message = str(exc).lower()
            if "promocion_codigo_key" in message or "duplicate key value" in message:
                return Response({"error": "El código ya existe. Usa otro código."}, status=400)
            return db_structure_error_response(exc)


class AdminPromocionDetalleView(AdminPromocionesView):
    permission_classes = [IsAuthenticated]

    def get(self, request, promocion_id: int):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            promocion = self._get_promocion_by_id(promocion_id)
            if not promocion:
                return Response({"error": "Promoción no encontrada."}, status=404)
            return Response({"ok": True, "promocion": promocion})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def put(self, request, promocion_id: int):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        if not data:
            return Response({"error": "No se enviaron datos para actualizar."}, status=400)

        payload, error = self._validar_payload(data, parcial=True)
        if error:
            return Response({"error": error}, status=400)

        try:
            actual = self._get_promocion_by_id(promocion_id)
            if not actual:
                return Response({"error": "Promoción no encontrada."}, status=404)

            merged = {**actual, **payload}
            if merged["fecha_fin"] < merged["fecha_inicio"]:
                return Response({"error": "La fecha de fin no puede ser menor que la fecha de inicio."}, status=400)

            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE negocio.promocion
                        SET
                            nombre = %s,
                            descripcion = %s,
                            tipo_descuento = %s,
                            aplica_en = %s,
                            valor_descuento = %s,
                            codigo = NULLIF(%s, ''),
                            fecha_inicio = %s,
                            fecha_fin = %s,
                            solo_clientes_nuevos = %s,
                            requiere_compra_minima = %s,
                            monto_compra_minima = %s,
                            limite_usos = %s,
                            activa = %s
                        WHERE promocion_id = %s
                        """,
                        [
                            merged["nombre"],
                            merged["descripcion"] or None,
                            merged["tipo_descuento"],
                            merged["aplica_en"],
                            round(float(merged["valor_descuento"]), 2),
                            (merged.get("codigo") or "").strip().upper(),
                            merged["fecha_inicio"],
                            merged["fecha_fin"],
                            bool(merged["solo_clientes_nuevos"]),
                            bool(merged["requiere_compra_minima"]),
                            round(float(merged["monto_compra_minima"]), 2) if merged.get("monto_compra_minima") is not None else None,
                            merged.get("limite_usos"),
                            bool(merged["activa"]),
                            promocion_id,
                        ],
                    )

            promocion = self._get_promocion_by_id(promocion_id)
            return Response({"ok": True, "promocion": promocion})
        except DatabaseError as exc:
            message = str(exc).lower()
            if "promocion_codigo_key" in message or "duplicate key value" in message:
                return Response({"error": "El código ya existe. Usa otro código."}, status=400)
            return db_structure_error_response(exc)

    def delete(self, request, promocion_id: int):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        DELETE FROM negocio.promocion
                        WHERE promocion_id = %s
                        RETURNING promocion_id
                        """,
                        [promocion_id],
                    )
                    deleted = cursor.fetchone()
                    if not deleted:
                        return Response({"error": "Promoción no encontrada."}, status=404)
            return Response({"ok": True, "detail": "Promoción eliminada correctamente."})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminDashboardView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _row_value(self, row: Any, idx: int, default: Any = 0) -> Any:
        if not row:
            return default
        if idx < 0 or idx >= len(row):
            return default
        return row[idx] if row[idx] is not None else default

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            with connection.cursor() as cursor:
                # Ventas del día (pedidos + mostrador + anticipos validados).
                cursor.execute(
                    """
                    SELECT COALESCE(SUM(p.total), 0)
                    FROM negocio.pedido p
                    JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE
                      AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                      AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                      AND (
                            LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                            OR (
                                LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                AND (
                                    (
                                        LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                        AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                    )
                                    OR (
                                        LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                        AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                    )
                                )
                            )
                          )
                    """
                )
                pedidos_hoy = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(vm.total), 0)
                    FROM negocio.venta_mostrador vm
                    WHERE DATE(vm.fecha) = CURRENT_DATE
                      AND COALESCE(vm.cancelada, FALSE) = FALSE
                    """
                )
                mostrador_hoy = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(ac.monto_anticipo), 0)
                    FROM negocio.anticipo_cita ac
                    WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE
                      AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                    """
                )
                anticipos_hoy = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(
                        SUM(
                            GREATEST(
                                COALESCE(c.precio_total, 0) - COALESCE(av.total_validado, 0),
                                0
                            )
                        ),
                        0
                    )
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN (
                        SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                        FROM negocio.anticipo_cita
                        WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                        GROUP BY cita_id
                    ) av ON av.cita_id = c.cita_id
                    WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE
                      AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                    """
                )
                restantes_hoy = float(self._row_value(cursor.fetchone(), 0, 0))

                ventas_hoy = round(pedidos_hoy + mostrador_hoy + anticipos_hoy + restantes_hoy, 2)

                # Ventas de ayer para variación.
                cursor.execute(
                    """
                    SELECT COALESCE(SUM(p.total), 0)
                    FROM negocio.pedido p
                    JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE - INTERVAL '1 day'
                      AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                      AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                      AND (
                            LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                            OR (
                                LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                AND (
                                    (
                                        LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                        AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                    )
                                    OR (
                                        LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                        AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                    )
                                )
                            )
                          )
                    """
                )
                pedidos_ayer = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(vm.total), 0)
                    FROM negocio.venta_mostrador vm
                    WHERE DATE(vm.fecha) = CURRENT_DATE - INTERVAL '1 day'
                      AND COALESCE(vm.cancelada, FALSE) = FALSE
                    """
                )
                mostrador_ayer = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(ac.monto_anticipo), 0)
                    FROM negocio.anticipo_cita ac
                    WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE - INTERVAL '1 day'
                      AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                    """
                )
                anticipos_ayer = float(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(
                        SUM(
                            GREATEST(
                                COALESCE(c.precio_total, 0) - COALESCE(av.total_validado, 0),
                                0
                            )
                        ),
                        0
                    )
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN (
                        SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                        FROM negocio.anticipo_cita
                        WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                        GROUP BY cita_id
                    ) av ON av.cita_id = c.cita_id
                    WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) = CURRENT_DATE - INTERVAL '1 day'
                      AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                    """
                )
                restantes_ayer = float(self._row_value(cursor.fetchone(), 0, 0))

                ventas_ayer = round(pedidos_ayer + mostrador_ayer + anticipos_ayer + restantes_ayer, 2)

                porcentaje_vs_ayer: float | None = None
                if ventas_ayer > 0:
                    porcentaje_vs_ayer = round(((ventas_hoy - ventas_ayer) / ventas_ayer) * 100, 2)
                elif ventas_hoy > 0:
                    porcentaje_vs_ayer = 100.0

                # Citas de hoy y pendientes.
                hoy_mx = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City')::date"
                cursor.execute(
                    f"""
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE(c.fecha_hora AT TIME ZONE 'America/Mexico_City') = {hoy_mx}
                      AND LOWER(COALESCE(ec.codigo, '')) <> 'cancelada'
                    """
                )
                citas_hoy = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    f"""
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE(c.fecha_hora AT TIME ZONE 'America/Mexico_City') = {hoy_mx}
                      AND LOWER(COALESCE(ec.codigo, '')) IN ('pendiente', 'confirmada')
                    """
                )
                citas_pendientes = int(self._row_value(cursor.fetchone(), 0, 0))

                # Barberos activos.
                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.empleado e
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE e.activo = TRUE
                      AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                    """
                )
                barberos_activos = int(self._row_value(cursor.fetchone(), 0, 0))

                # Barberos en descanso según día/hora actual.
                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(DISTINCT ed.empleado_id), 0)
                    FROM negocio.empleado_descanso ed
                    JOIN negocio.empleado e ON e.empleado_id = ed.empleado_id
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE e.activo = TRUE
                      AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                      AND ed.dia_semana = (
                        CASE EXTRACT(ISODOW FROM CURRENT_DATE)
                          WHEN 1 THEN 0
                          WHEN 2 THEN 1
                          WHEN 3 THEN 2
                          WHEN 4 THEN 3
                          WHEN 5 THEN 4
                          WHEN 6 THEN 5
                          ELSE 6
                        END
                      )
                      AND LOCALTIME >= ed.hora_inicio
                      AND LOCALTIME < ed.hora_fin
                    """
                )
                barberos_en_descanso = int(self._row_value(cursor.fetchone(), 0, 0))

                # Productos con stock bajo.
                cursor.execute(
                    """
                    SELECT
                        p.producto_id,
                        p.nombre,
                        COALESCE(ie.stock_actual, 0) AS stock_actual,
                        p.stock_minimo_alerta,
                        p.precio_venta
                    FROM negocio.producto p
                    LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                    WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                      AND COALESCE(ie.stock_actual, 0) <= COALESCE(p.stock_minimo_alerta, 0)
                    ORDER BY COALESCE(ie.stock_actual, 0) ASC, p.nombre ASC
                    LIMIT 10
                    """
                )
                productos_rows = cursor.fetchall()
                productos_stock_bajo = [
                    {
                        "id": int(r[0]),
                        "nombre": r[1] or "",
                        "stock": int(r[2] or 0),
                        "stock_minimo": int(r[3] or 0),
                        "precio": float(r[4] or 0),
                    }
                    for r in productos_rows
                ]

                # Conteos generales.
                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.usuario_rol ur
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE LOWER(COALESCE(r.codigo, '')) = 'cliente'
                    """
                )
                total_clientes = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute("SELECT COALESCE(COUNT(*), 0) FROM negocio.servicio WHERE activo = TRUE")
                servicios_activos = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.producto
                    WHERE LOWER(COALESCE(estado, 'activo')) = 'activo'
                    """
                )
                productos_activos = int(self._row_value(cursor.fetchone(), 0, 0))

                # Top servicios del día.
                cursor.execute(
                    """
                    SELECT
                        s.servicio_id,
                        s.nombre,
                        COALESCE(COUNT(*), 0) AS cantidad,
                        COALESCE(SUM(c.precio_total), 0) AS total
                    FROM negocio.cita c
                    JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE(c.fecha_hora) = CURRENT_DATE
                      AND LOWER(COALESCE(ec.codigo, '')) IN ('confirmada', 'completada')
                    GROUP BY s.servicio_id, s.nombre
                    ORDER BY cantidad DESC, total DESC
                    LIMIT 5
                    """
                )
                top_servicios_rows = cursor.fetchall()
                top_servicios = [
                    {
                        "id": int(r[0]),
                        "nombre": r[1] or "",
                        "cantidad": int(r[2] or 0),
                        "total": f"{float(r[3] or 0):.2f}",
                        "precio": "0.00",
                    }
                    for r in top_servicios_rows
                ]

                # Horas con mayor demanda del día.
                cursor.execute(
                    """
                    SELECT
                        TO_CHAR(c.fecha_hora, 'HH24:00') AS hora_bloque,
                        COUNT(*) AS cantidad
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE(c.fecha_hora) = CURRENT_DATE
                      AND LOWER(COALESCE(ec.codigo, '')) IN ('confirmada', 'completada')
                    GROUP BY hora_bloque
                    ORDER BY cantidad DESC, hora_bloque ASC
                    LIMIT 6
                    """
                )
                horas_rows = cursor.fetchall()
                max_count = max([int(r[1] or 0) for r in horas_rows], default=0)
                horarios_mayor_demanda = [
                    {
                        "hora": str(r[0] or ""),
                        "porcentaje": int(round((int(r[1] or 0) / max_count) * 100, 0)) if max_count > 0 else 0,
                    }
                    for r in horas_rows
                ]

            stats = {
                "ventas_dia": ventas_hoy,
                "ventas_ayer": ventas_ayer,
                "porcentaje_ventas_vs_ayer": porcentaje_vs_ayer,
                "citas_hoy": citas_hoy,
                "citas_pendientes": citas_pendientes,
                "barberos_activos": barberos_activos,
                "barberos_en_descanso": barberos_en_descanso,
                "productos_stock_bajo": len(productos_stock_bajo),
                "total_clientes": total_clientes,
                "servicios_activos": servicios_activos,
                "productos_activos": productos_activos,
            }

            return Response(
                {
                    "ok": True,
                    "stats": stats,
                    "productos_stock_bajo": productos_stock_bajo,
                    "top_servicios": top_servicios,
                    "horarios_mayor_demanda": horarios_mayor_demanda,
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminReportesView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _parse_date(self, raw: str | None) -> date | None:
        txt = str(raw or "").strip()
        if not txt:
            return None
        try:
            return date.fromisoformat(txt)
        except ValueError:
            return None

    def _default_range(self, tipo: str) -> tuple[date, date]:
        hoy = date.today()
        if tipo == "ventas-dia":
            return hoy, hoy
        if tipo == "ventas-semana":
            inicio = hoy - timedelta(days=hoy.weekday())
            return inicio, inicio + timedelta(days=6)
        inicio_mes = hoy.replace(day=1)
        if inicio_mes.month == 12:
            siguiente = inicio_mes.replace(year=inicio_mes.year + 1, month=1, day=1)
        else:
            siguiente = inicio_mes.replace(month=inicio_mes.month + 1, day=1)
        return inicio_mes, siguiente - timedelta(days=1)

    def _previous_range(self, desde: date, hasta: date) -> tuple[date, date]:
        dias = (hasta - desde).days + 1
        prev_hasta = desde - timedelta(days=1)
        prev_desde = prev_hasta - timedelta(days=max(0, dias - 1))
        return prev_desde, prev_hasta

    def _sum_ventas_productos(self, cursor, desde: date, hasta: date) -> float:
        cursor.execute(
            """
            SELECT COALESCE(SUM(p.total), 0)
            FROM negocio.pedido p
            JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
            LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
            LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
            WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
              AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
              AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
              AND (
                    LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                    OR (
                        LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                        AND (
                            (
                                LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                            )
                            OR (
                                LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                            )
                        )
                    )
                  )
            """,
            [desde, hasta],
        )
        pedidos = float((cursor.fetchone() or [0])[0] or 0)

        cursor.execute(
            """
            SELECT COALESCE(SUM(vm.total), 0)
            FROM negocio.venta_mostrador vm
            WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
              AND COALESCE(vm.cancelada, FALSE) = FALSE
            """,
            [desde, hasta],
        )
        mostrador = float((cursor.fetchone() or [0])[0] or 0)
        return round(pedidos + mostrador, 2)

    def _sum_ventas_servicios(self, cursor, desde: date, hasta: date) -> float:
        cursor.execute(
            """
            SELECT COALESCE(SUM(ac.monto_anticipo), 0)
            FROM negocio.anticipo_cita ac
            WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
              AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
            """,
            [desde, hasta],
        )
        anticipos = float((cursor.fetchone() or [0])[0] or 0)

        # Compatibilidad: pagos directos con tarjeta registrados solo en notas (sin anticipo_cita).
        cursor.execute(
            """
            SELECT COALESCE(SUM(c.precio_total), 0)
            FROM negocio.cita c
            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
            LEFT JOIN (
                SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                FROM negocio.anticipo_cita
                WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                GROUP BY cita_id
            ) av ON av.cita_id = c.cita_id
            WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
              AND COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
              AND COALESCE(av.total_validado, 0) <= 0
              AND LOWER(COALESCE(ec.codigo, '')) NOT IN ('cancelada', 'no_asistio')
            """,
            [desde, hasta],
        )
        pagos_tarjeta_directos = float((cursor.fetchone() or [0])[0] or 0)

        cursor.execute(
            """
            SELECT COALESCE(
                SUM(
                    GREATEST(
                        COALESCE(c.precio_total, 0) - COALESCE(av.total_validado, 0),
                        0
                    )
                ),
                0
            )
            FROM negocio.cita c
            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
            LEFT JOIN (
                SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                FROM negocio.anticipo_cita
                WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                GROUP BY cita_id
            ) av ON av.cita_id = c.cita_id
            WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
              AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
              AND NOT (
                    COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                    AND COALESCE(av.total_validado, 0) <= 0
              )
            """,
            [desde, hasta],
        )
        restantes = float((cursor.fetchone() or [0])[0] or 0)
        return round(anticipos + pagos_tarjeta_directos + restantes, 2)

    def _sum_total_ventas(self, cursor, desde: date, hasta: date) -> float:
        return round(self._sum_ventas_servicios(cursor, desde, hasta) + self._sum_ventas_productos(cursor, desde, hasta), 2)

    def _month_start(self, d: date) -> date:
        return d.replace(day=1)

    def _add_months(self, d: date, delta: int) -> date:
        y = d.year + ((d.month - 1 + delta) // 12)
        m = ((d.month - 1 + delta) % 12) + 1
        return date(y, m, 1)

    def _serie_mensual_y_proyeccion(self, cursor, meses_hist: int = 6, meses_pred: int = 3) -> dict[str, Any]:
        hoy = date.today()
        inicio_mes_actual = self._month_start(hoy)
        inicio_hist = self._add_months(inicio_mes_actual, -(meses_hist - 1))

        historico: list[dict[str, Any]] = []
        valores: list[float] = []
        for i in range(meses_hist):
            ini = self._add_months(inicio_hist, i)
            fin = self._add_months(ini, 1) - timedelta(days=1)
            total = float(self._sum_total_ventas(cursor, ini, fin))
            historico.append({"mes": ini.strftime("%Y-%m"), "total": round(total, 2)})
            valores.append(total)

        if not valores:
            return {"historico": [], "proyeccion": []}

        n = len(valores)
        if n == 1:
            pred_vals = [round(max(0.0, valores[0]), 2) for _ in range(meses_pred)]
        else:
            x = [i + 1 for i in range(n)]
            sx = sum(x)
            sy = sum(valores)
            sxy = sum(a * b for a, b in zip(x, valores))
            sx2 = sum(a * a for a in x)
            den = (n * sx2) - (sx * sx)
            m = ((n * sxy) - (sx * sy)) / den if den != 0 else 0.0
            b = (sy - (m * sx)) / n
            pred_vals = [round(max(0.0, (m * (n + i)) + b), 2) for i in range(1, meses_pred + 1)]

        proyeccion: list[dict[str, Any]] = []
        base = self._add_months(inicio_hist, meses_hist)
        for i in range(meses_pred):
            mes = self._add_months(base, i)
            proyeccion.append({"mes": mes.strftime("%Y-%m"), "total": pred_vals[i]})

        return {"historico": historico, "proyeccion": proyeccion}

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        tipo = str(request.GET.get("tipo", "") or "").strip().lower()
        desde_q = self._parse_date(request.GET.get("desde"))
        hasta_q = self._parse_date(request.GET.get("hasta"))

        tipos_validos = {
            "ventas-dia",
            "ventas-semana",
            "ventas-mes",
            "servicios-populares",
            "citas",
            "horarios",
            "productos-vendidos",
            "inventario",
        }

        try:
            with connection.cursor() as cursor:
                if not tipo:
                    hoy = date.today()
                    inicio_semana = hoy - timedelta(days=hoy.weekday())
                    inicio_mes = hoy.replace(day=1)
                    if inicio_mes.month == 12:
                        siguiente_mes = inicio_mes.replace(year=inicio_mes.year + 1, month=1, day=1)
                    else:
                        siguiente_mes = inicio_mes.replace(month=inicio_mes.month + 1, day=1)
                    fin_mes = siguiente_mes - timedelta(days=1)

                    ventas_dia = self._sum_total_ventas(cursor, hoy, hoy)
                    ventas_ayer = self._sum_total_ventas(cursor, hoy - timedelta(days=1), hoy - timedelta(days=1))
                    ventas_semana = self._sum_total_ventas(cursor, inicio_semana, inicio_semana + timedelta(days=6))
                    prev_semana_desde = inicio_semana - timedelta(days=7)
                    prev_semana_hasta = inicio_semana - timedelta(days=1)
                    ventas_semana_prev = self._sum_total_ventas(cursor, prev_semana_desde, prev_semana_hasta)
                    ventas_mes = self._sum_total_ventas(cursor, inicio_mes, fin_mes)
                    prev_mes_hasta = inicio_mes - timedelta(days=1)
                    prev_mes_desde = prev_mes_hasta.replace(day=1)
                    ventas_mes_prev = self._sum_total_ventas(cursor, prev_mes_desde, prev_mes_hasta)

                    def variacion(actual: float, previo: float) -> float:
                        if previo > 0:
                            return round(((actual - previo) / previo) * 100, 2)
                        return 100.0 if actual > 0 else 0.0

                    cursor.execute(
                        """
                        SELECT LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado, COUNT(*)
                        FROM negocio.cita c
                        JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        WHERE DATE(c.fecha_hora) BETWEEN %s AND %s
                        GROUP BY LOWER(COALESCE(ec.codigo, 'pendiente'))
                        """,
                        [inicio_mes, fin_mes],
                    )
                    citas_por_estado = {str(r[0] or "pendiente"): int(r[1] or 0) for r in cursor.fetchall()}

                    cursor.execute("SELECT COALESCE(COUNT(*), 0) FROM negocio.servicio WHERE activo = TRUE")
                    servicios_activos = int((cursor.fetchone() or [0])[0] or 0)

                    cursor.execute(
                        """
                        SELECT COALESCE(COUNT(*), 0)
                        FROM negocio.producto
                        WHERE LOWER(COALESCE(estado, 'activo')) = 'activo'
                        """
                    )
                    productos_activos = int((cursor.fetchone() or [0])[0] or 0)

                    cursor.execute(
                        """
                        SELECT COALESCE(COUNT(*), 0)
                        FROM negocio.producto p
                        LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                        WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                          AND COALESCE(ie.stock_actual, 0) <= COALESCE(p.stock_minimo_alerta, 0)
                        """
                    )
                    productos_stock_bajo = int((cursor.fetchone() or [0])[0] or 0)

                    return Response(
                        {
                            "ok": True,
                            "periodo": {"inicio": inicio_mes.isoformat(), "fin": fin_mes.isoformat()},
                            "resumen": {
                                "servicios_activos": servicios_activos,
                                "productos_activos": productos_activos,
                                "productos_stock_bajo": productos_stock_bajo,
                            },
                            "citas_por_estado": citas_por_estado,
                            "ventas_dia": ventas_dia,
                            "ventas_semana": ventas_semana,
                            "ventas_mes": ventas_mes,
                            "ventas_dia_variacion": variacion(ventas_dia, ventas_ayer),
                            "ventas_semana_variacion": variacion(ventas_semana, ventas_semana_prev),
                            "ventas_mes_variacion": variacion(ventas_mes, ventas_mes_prev),
                        }
                    )

                if tipo not in tipos_validos:
                    return Response({"ok": False, "error": "Tipo de reporte inválido."}, status=400)

                if desde_q and hasta_q:
                    desde, hasta = desde_q, hasta_q
                elif desde_q and not hasta_q:
                    desde, hasta = desde_q, desde_q
                elif not desde_q and hasta_q:
                    desde, hasta = hasta_q, hasta_q
                else:
                    desde, hasta = self._default_range(tipo)

                if hasta < desde:
                    hasta = desde

                prev_desde, prev_hasta = self._previous_range(desde, hasta)

                if tipo in {"ventas-dia", "ventas-semana", "ventas-mes"}:
                    servicios_total = self._sum_ventas_servicios(cursor, desde, hasta)
                    productos_total = self._sum_ventas_productos(cursor, desde, hasta)
                    total = round(servicios_total + productos_total, 2)
                    total_prev = self._sum_total_ventas(cursor, prev_desde, prev_hasta)
                    variacion = round(((total - total_prev) / total_prev) * 100, 2) if total_prev > 0 else (100.0 if total > 0 else 0.0)

                    cursor.execute(
                        """
                        -- Detalle de "cortes vendidos" por eventos de cobro:
                        -- 1) anticipos validados (con etiqueta si es parcial),
                        -- 2) restante al completar la cita.
                        SELECT *
                        FROM (
                            SELECT
                                TO_CHAR((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                                TO_CHAR((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                                COALESCE(
                                    NULLIF(TRIM(CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))), ''),
                                    u.email,
                                    'Cliente'
                                ) AS cliente_nombre,
                                (
                                    COALESCE(s.nombre, '')
                                    || CASE
                                        WHEN COALESCE(ac.monto_anticipo, 0) < COALESCE(c.precio_total, 0)
                                        THEN ' (anticipo)'
                                        ELSE ''
                                       END
                                ) AS servicio_nombre,
                                COALESCE(ac.monto_anticipo, 0) AS precio_total
                            FROM negocio.anticipo_cita ac
                            JOIN negocio.cita c ON c.cita_id = ac.cita_id
                            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                            JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                            JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                            LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                            WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                              AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                              AND LOWER(COALESCE(ec.codigo, '')) NOT IN ('cancelada', 'no_asistio')

                            UNION ALL

                            SELECT
                                TO_CHAR((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                                TO_CHAR((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                                COALESCE(
                                    NULLIF(TRIM(CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))), ''),
                                    u.email,
                                    'Cliente'
                                ) AS cliente_nombre,
                                (
                                    COALESCE(s.nombre, '')
                                    || CASE
                                        WHEN COALESCE(av.total_validado, 0) > 0
                                        THEN ' (pago restante)'
                                        ELSE ''
                                       END
                                ) AS servicio_nombre,
                                GREATEST(COALESCE(c.precio_total, 0) - COALESCE(av.total_validado, 0), 0) AS precio_total
                            FROM negocio.cita c
                            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                            JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                            JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                            LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                            LEFT JOIN (
                                SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                                FROM negocio.anticipo_cita
                                WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                                GROUP BY cita_id
                            ) av ON av.cita_id = c.cita_id
                            WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                              AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                              AND NOT (
                                    COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                    AND COALESCE(av.total_validado, 0) <= 0
                              )
                              AND GREATEST(COALESCE(c.precio_total, 0) - COALESCE(av.total_validado, 0), 0) > 0

                            UNION ALL

                            SELECT
                                TO_CHAR((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                                TO_CHAR((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                                COALESCE(
                                    NULLIF(TRIM(CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))), ''),
                                    u.email,
                                    'Cliente'
                                ) AS cliente_nombre,
                                COALESCE(s.nombre, '') AS servicio_nombre,
                                COALESCE(c.precio_total, 0) AS precio_total
                            FROM negocio.cita c
                            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                            JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                            JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                            LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                            LEFT JOIN (
                                SELECT cita_id, COALESCE(SUM(monto_anticipo), 0) AS total_validado
                                FROM negocio.anticipo_cita
                                WHERE LOWER(COALESCE(estado_validacion, '')) = 'validado'
                                GROUP BY cita_id
                            ) av ON av.cita_id = c.cita_id
                            WHERE DATE((c.fecha_actualizacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                              AND COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                              AND COALESCE(av.total_validado, 0) <= 0
                              AND LOWER(COALESCE(ec.codigo, '')) NOT IN ('cancelada', 'no_asistio')
                        ) t
                        ORDER BY fecha ASC, hora ASC, cliente_nombre ASC
                        """,
                        [desde, hasta, desde, hasta, desde, hasta],
                    )
                    detalle = [
                        {
                            "fecha": str(r[0] or ""),
                            "hora": str(r[1] or ""),
                            "cliente_nombre": str(r[2] or "Cliente"),
                            "servicio_nombre": str(r[3] or ""),
                            "precio_total": float(r[4] or 0),
                        }
                        for r in cursor.fetchall()
                    ]

                    pedidos_trans = 0
                    cursor.execute(
                        """
                        SELECT COUNT(*)
                        FROM negocio.pedido p
                        JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                        LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                        LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                        WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                          AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                          AND (
                                LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                                OR (
                                    LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                    AND (
                                        (
                                            LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                            AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                        )
                                        OR (
                                            LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                            AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                        )
                                    )
                                )
                              )
                        """,
                        [desde, hasta],
                    )
                    pedidos_trans = int((cursor.fetchone() or [0])[0] or 0)

                    cursor.execute(
                        """
                        SELECT COUNT(*)
                        FROM negocio.venta_mostrador vm
                        WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND COALESCE(vm.cancelada, FALSE) = FALSE
                        """,
                        [desde, hasta],
                    )
                    mostrador_trans = int((cursor.fetchone() or [0])[0] or 0)

                    # Regla solicitada: transacciones de citas solo cuentan citas realmente
                    # atendidas/completadas en el periodo (por fecha real de cita).
                    cursor.execute(
                        """
                        SELECT COUNT(*)
                        FROM negocio.cita c
                        JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        WHERE DATE((c.fecha_hora AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                        """,
                        [desde, hasta],
                    )
                    citas_completadas_trans = int((cursor.fetchone() or [0])[0] or 0)

                    servicios_pct = round((servicios_total / total) * 100, 2) if total > 0 else 0.0
                    productos_pct = round((productos_total / total) * 100, 2) if total > 0 else 0.0
                    serie_mensual = self._serie_mensual_y_proyeccion(cursor, meses_hist=6, meses_pred=3)

                    return Response(
                        {
                            "ok": True,
                            "tipo": tipo,
                            "criterio_cobro": (
                                "Productos: pedidos no cancelados con estado pagado/validado "
                                "(incluye tarjeta aprobada automatica). "
                                "Servicios: cobro por monto efectivamente pagado "
                                "(anticipos validados + restante al completar cita). "
                                "En detalle, los anticipos parciales se marcan como '(anticipo)'. "
                                "Transacciones de citas: solo citas en estado 'completada'."
                            ),
                            "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                            "total": total,
                            "servicios_total": servicios_total,
                            "productos_total": productos_total,
                            "servicios_porcentaje": servicios_pct,
                            "productos_porcentaje": productos_pct,
                            "transacciones": citas_completadas_trans,
                            "transacciones_totales": int(len(detalle) + pedidos_trans + mostrador_trans),
                            "variacion": variacion,
                            "historico_mensual": serie_mensual.get("historico", []),
                            "proyeccion_mensual": serie_mensual.get("proyeccion", []),
                            "detalle": detalle,
                        }
                    )

                if tipo == "servicios-populares":
                    cursor.execute(
                        """
                        SELECT
                            COALESCE(s.nombre, '') AS servicio_nombre,
                            COUNT(*) AS cantidad,
                            COALESCE(SUM(c.precio_total), 0) AS total
                        FROM negocio.cita c
                        JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                        JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        WHERE DATE((c.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND (
                                LOWER(COALESCE(ec.codigo, '')) = 'completada'
                                OR EXISTS (
                                    SELECT 1
                                    FROM negocio.anticipo_cita ac
                                    WHERE ac.cita_id = c.cita_id
                                      AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                                )
                                OR COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                              )
                          AND LOWER(COALESCE(ec.codigo, '')) NOT IN ('cancelada', 'no_asistio')
                        GROUP BY s.servicio_id, s.nombre
                        ORDER BY cantidad DESC, total DESC, servicio_nombre ASC
                        """,
                        [desde, hasta],
                    )
                    rows = cursor.fetchall()
                    detalle = [{"servicio_nombre": str(r[0] or ""), "cantidad": int(r[1] or 0), "total": float(r[2] or 0)} for r in rows]
                    total = round(sum(float(r[2] or 0) for r in rows), 2)
                    total_citas_validas = int(sum(int(r[1] or 0) for r in rows))

                    cursor.execute(
                        """
                        SELECT COALESCE(SUM(ac.monto_anticipo), 0)
                        FROM negocio.anticipo_cita ac
                        WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                        """,
                        [desde, hasta],
                    )
                    anticipos_validados_total = float((cursor.fetchone() or [0])[0] or 0)

                    return Response(
                        {
                            "ok": True,
                            "tipo": tipo,
                            "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                            "total": total,
                            "total_citas_validas": total_citas_validas,
                            "anticipos_validados_total": round(anticipos_validados_total, 2),
                            "detalle": detalle,
                        }
                    )

                if tipo == "citas":
                    cursor.execute(
                        """
                        SELECT LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado, COUNT(*) AS total
                        FROM negocio.cita c
                        JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        WHERE DATE(c.fecha_hora) BETWEEN %s AND %s
                        GROUP BY LOWER(COALESCE(ec.codigo, 'pendiente'))
                        ORDER BY estado ASC
                        """,
                        [desde, hasta],
                    )
                    rows = cursor.fetchall()
                    por_estado = [{"estado": str(r[0] or "pendiente"), "total": int(r[1] or 0)} for r in rows]
                    total_citas = int(sum(int(r[1] or 0) for r in rows))
                    by_code = {str(r[0] or "pendiente"): int(r[1] or 0) for r in rows}
                    atendidas = int(by_code.get("completada", 0) + by_code.get("no_asistio", 0) + by_code.get("cancelada", 0))
                    tasa_asistencia = round((by_code.get("completada", 0) / atendidas) * 100, 2) if atendidas > 0 else 0.0

                    cursor.execute(
                        """
                        SELECT COALESCE(SUM(ac.monto_anticipo), 0)
                        FROM negocio.anticipo_cita ac
                        WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                        """,
                        [desde, hasta],
                    )
                    anticipos_validados_total = float((cursor.fetchone() or [0])[0] or 0)

                    return Response(
                        {
                            "ok": True,
                            "tipo": tipo,
                            "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                            "total_citas": total_citas,
                            "tasa_asistencia": tasa_asistencia,
                            "anticipos_validados_total": round(anticipos_validados_total, 2),
                            "por_estado": por_estado,
                        }
                    )

                if tipo == "horarios":
                    cursor.execute(
                        """
                        SELECT EXTRACT(HOUR FROM c.fecha_hora)::int AS hora, COUNT(*) AS cantidad
                        FROM negocio.cita c
                        JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        WHERE DATE((c.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND (
                                LOWER(COALESCE(ec.codigo, '')) = 'completada'
                                OR EXISTS (
                                    SELECT 1
                                    FROM negocio.anticipo_cita ac
                                    WHERE ac.cita_id = c.cita_id
                                      AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                                )
                                OR COALESCE(c.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                              )
                          AND LOWER(COALESCE(ec.codigo, '')) NOT IN ('cancelada', 'no_asistio')
                        GROUP BY EXTRACT(HOUR FROM c.fecha_hora)::int
                        ORDER BY hora ASC
                        """,
                        [desde, hasta],
                    )
                    rows = cursor.fetchall()
                    detalle = [{"hora": int(r[0] or 0), "cantidad": int(r[1] or 0)} for r in rows]
                    total_citas_validadas = int(sum(int(r[1] or 0) for r in rows))

                    cursor.execute(
                        """
                        SELECT COALESCE(SUM(ac.monto_anticipo), 0)
                        FROM negocio.anticipo_cita ac
                        WHERE DATE((ac.fecha_validacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND LOWER(COALESCE(ac.estado_validacion, '')) = 'validado'
                        """,
                        [desde, hasta],
                    )
                    anticipos_validados_total = float((cursor.fetchone() or [0])[0] or 0)

                    return Response(
                        {
                            "ok": True,
                            "tipo": tipo,
                            "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                            "total_citas_validadas": total_citas_validadas,
                            "anticipos_validados_total": round(anticipos_validados_total, 2),
                            "detalle": detalle,
                        }
                    )

                if tipo == "productos-vendidos":
                    cursor.execute(
                        """
                        SELECT
                            TO_CHAR((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                            TO_CHAR((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                            COALESCE(
                                NULLIF(TRIM(CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))), ''),
                                u.email,
                                'Cliente'
                            ) AS cliente_nombre,
                            COALESCE(pr.nombre, 'Producto') AS producto_nombre,
                            COALESCE(pi.cantidad, 0) AS unidades,
                            CASE
                                WHEN COALESCE(p.subtotal, 0) > 0 THEN GREATEST(
                                    COALESCE(pi.subtotal, 0)
                                    - (COALESCE(p.descuento_monto, 0) * (COALESCE(pi.subtotal, 0) / p.subtotal)),
                                    0
                                )
                                ELSE COALESCE(pi.subtotal, 0)
                            END AS total
                        FROM negocio.pedido_item pi
                        JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                        JOIN negocio.producto pr ON pr.producto_id = pi.producto_id
                        LEFT JOIN negocio.usuario u ON u.usuario_id = p.cliente_usuario_id
                        LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                        JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                        LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                        LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                        WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                          AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                          AND (
                                LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                                OR (
                                    LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                    AND (
                                        (
                                            LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                            AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                        )
                                        OR (
                                            LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                            AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                        )
                                    )
                                )
                              )
                        ORDER BY p.fecha_creacion ASC, pi.pedido_item_id ASC
                        """,
                        [desde, hasta],
                    )
                    rows_pedido = cursor.fetchall()

                    cursor.execute(
                        """
                        SELECT
                            TO_CHAR((vm.fecha AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                            TO_CHAR((vm.fecha AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                            COALESCE(
                                NULLIF(TRIM(CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))), ''),
                                u.email,
                                'Mostrador'
                            ) AS cliente_nombre,
                            COALESCE(pr.nombre, 'Producto') AS producto_nombre,
                            COALESCE(vmi.cantidad, 0) AS unidades,
                            COALESCE(vmi.subtotal, 0) AS total
                        FROM negocio.venta_mostrador_item vmi
                        JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                        JOIN negocio.producto pr ON pr.producto_id = vmi.producto_id
                        LEFT JOIN negocio.usuario u ON u.usuario_id = vm.cliente_usuario_id
                        LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                        WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                          AND COALESCE(vm.cancelada, FALSE) = FALSE
                        ORDER BY vm.fecha ASC, vmi.venta_mostrador_item_id ASC
                        """,
                        [desde, hasta],
                    )
                    rows_mostrador = cursor.fetchall()

                    rows = [*rows_pedido, *rows_mostrador]
                    detalle = [
                        {
                            "fecha": str(r[0] or ""),
                            "hora": str(r[1] or ""),
                            "cliente_nombre": str(r[2] or "Cliente"),
                            "producto_nombre": str(r[3] or "Producto"),
                            "unidades": int(r[4] or 0),
                            "total": float(r[5] or 0),
                        }
                        for r in rows
                    ]
                    return Response(
                        {
                            "ok": True,
                            "tipo": tipo,
                            "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                            "detalle": detalle,
                        }
                    )

                # inventario
                cursor.execute(
                    """
                    SELECT
                        COALESCE(SUM(CASE WHEN LOWER(COALESCE(tmi.codigo,'')) = 'entrada' THEN im.cantidad ELSE 0 END), 0) AS entradas,
                        COALESCE(SUM(CASE WHEN LOWER(COALESCE(tmi.codigo,'')) = 'salida' THEN im.cantidad ELSE 0 END), 0) AS salidas,
                        COALESCE(SUM(CASE WHEN LOWER(COALESCE(tmi.codigo,'')) = 'venta' THEN im.cantidad ELSE 0 END), 0) AS ventas,
                        COALESCE(SUM(CASE WHEN LOWER(COALESCE(tmi.codigo,'')) = 'ajuste' THEN im.cantidad ELSE 0 END), 0) AS ajustes
                    FROM negocio.inventario_movimiento im
                    LEFT JOIN negocio.tipo_movimiento_inventario tmi ON tmi.tipo_movimiento_id = im.tipo_movimiento_id
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                    """,
                    [desde, hasta],
                )
                row_tot = cursor.fetchone() or (0, 0, 0, 0)
                entradas = int(row_tot[0] or 0)
                salidas = int(row_tot[1] or 0)
                ventas = int(row_tot[2] or 0)
                ajustes = int(row_tot[3] or 0)

                # Respaldo por canal: ventas web (pedido_item) + ventas secretaría/mostrador.
                cursor.execute(
                    """
                    SELECT COALESCE(SUM(pi.cantidad), 0)
                    FROM negocio.pedido_item pi
                    JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                    JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE DATE((p.fecha_creacion AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                      AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                      AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                      AND (
                            LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                            OR (
                                LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                AND (
                                    (
                                        LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                        AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                    )
                                    OR (
                                        LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                        AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                    )
                                )
                            )
                          )
                    """,
                    [desde, hasta],
                )
                ventas_web = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(vmi.cantidad), 0)
                    FROM negocio.venta_mostrador_item vmi
                    JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                    WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                      AND COALESCE(vm.cancelada, FALSE) = FALSE
                    """,
                    [desde, hasta],
                )
                ventas_secretaria = int((cursor.fetchone() or [0])[0] or 0)
                ventas_canales_total = int(ventas_web + ventas_secretaria)
                if ventas <= 0 and ventas_canales_total > 0:
                    ventas = ventas_canales_total

                balance_neto = int((entradas + ajustes) - (salidas + ventas))

                detalle = [
                    {"tipo": "entrada", "total": entradas},
                    {"tipo": "salida", "total": salidas},
                    {"tipo": "venta", "total": ventas},
                    {"tipo": "ajuste", "total": ajustes},
                ]

                cursor.execute(
                    """
                    SELECT
                        COALESCE(COUNT(*), 0) AS total_movimientos,
                        COALESCE(COUNT(DISTINCT im.producto_id), 0) AS productos_afectados
                    FROM negocio.inventario_movimiento im
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                    """,
                    [desde, hasta],
                )
                row_meta = cursor.fetchone() or (0, 0)
                total_movimientos = int(row_meta[0] or 0)
                productos_afectados = int(row_meta[1] or 0)

                cursor.execute(
                    """
                    SELECT
                        COALESCE(SUM(im.cantidad), 0)
                    FROM negocio.inventario_movimiento im
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                      AND COALESCE(im.nota, '') ILIKE '%%cancel%%'
                    """,
                    [desde, hasta],
                )
                cancelaciones_pedido = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT
                        im.fecha,
                        COALESCE(p.nombre, 'Producto') AS producto,
                        im.cantidad
                    FROM negocio.inventario_movimiento im
                    LEFT JOIN negocio.producto p ON p.producto_id = im.producto_id
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                      AND COALESCE(im.nota, '') ILIKE '%%cancel%%'
                    ORDER BY im.fecha DESC
                    LIMIT 100
                    """,
                    [desde, hasta],
                )
                detalle_cancelaciones = [
                    {"fecha": r[0], "producto": str(r[1] or "Producto"), "cantidad": int(r[2] or 0)}
                    for r in cursor.fetchall()
                ]

                cursor.execute(
                    """
                    SELECT
                        COALESCE(p.nombre, 'Producto') AS producto,
                        LOWER(COALESCE(tmi.codigo, 'movimiento')) AS tipo,
                        COALESCE(SUM(im.cantidad), 0) AS total_unidades
                    FROM negocio.inventario_movimiento im
                    LEFT JOIN negocio.producto p ON p.producto_id = im.producto_id
                    LEFT JOIN negocio.tipo_movimiento_inventario tmi ON tmi.tipo_movimiento_id = im.tipo_movimiento_id
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                    GROUP BY COALESCE(p.nombre, 'Producto'), LOWER(COALESCE(tmi.codigo, 'movimiento'))
                    ORDER BY total_unidades DESC, producto ASC
                    LIMIT 20
                    """,
                    [desde, hasta],
                )
                top_productos = [
                    {
                        "producto": str(r[0] or "Producto"),
                        "tipo": str(r[1] or "movimiento"),
                        "total_unidades": int(r[2] or 0),
                    }
                    for r in cursor.fetchall()
                ]

                cursor.execute(
                    """
                    SELECT
                        TO_CHAR((im.fecha AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
                        TO_CHAR((im.fecha AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                        COALESCE(p.nombre, 'Producto') AS producto,
                        LOWER(COALESCE(tmi.codigo, 'movimiento')) AS tipo,
                        COALESCE(im.cantidad, 0) AS cantidad,
                        COALESCE(im.stock_anterior, 0) AS stock_anterior,
                        COALESCE(im.stock_posterior, 0) AS stock_posterior,
                        COALESCE(im.nota, '') AS nota
                    FROM negocio.inventario_movimiento im
                    LEFT JOIN negocio.producto p ON p.producto_id = im.producto_id
                    LEFT JOIN negocio.tipo_movimiento_inventario tmi ON tmi.tipo_movimiento_id = im.tipo_movimiento_id
                    WHERE DATE((im.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                    ORDER BY im.fecha DESC
                    LIMIT 120
                    """,
                    [desde, hasta],
                )
                detalle_reciente = [
                    {
                        "fecha": str(r[0] or ""),
                        "hora": str(r[1] or ""),
                        "producto": str(r[2] or "Producto"),
                        "tipo": str(r[3] or "movimiento"),
                        "cantidad": int(r[4] or 0),
                        "stock_anterior": int(r[5] or 0),
                        "stock_posterior": int(r[6] or 0),
                        "nota": str(r[7] or ""),
                    }
                    for r in cursor.fetchall()
                ]

                try:
                    # Intento principal: usar columnas de la versión actual del modelo.
                    cursor.execute(
                        """
                        SELECT
                            COALESCE(p.producto_id, 0) AS producto_id,
                            COALESCE(p.nombre, 'Producto') AS producto,
                            COALESCE(ie.stock_actual, 0) AS stock_actual,
                            COALESCE(p.stock_minimo_alerta, 0) AS stock_minimo,
                            COALESCE(p.precio_venta, 0) AS precio_venta
                        FROM negocio.producto p
                        LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                        WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                        ORDER BY COALESCE(ie.stock_actual, 0) ASC, p.nombre ASC
                        LIMIT 120
                        """
                    )
                except DatabaseError:
                    # Compatibilidad hacia atrás: si alguna columna no existe aún,
                    # usar valores por defecto que no dependen de esas columnas.
                    cursor.execute(
                        """
                        SELECT
                            COALESCE(p.producto_id, 0) AS producto_id,
                            COALESCE(p.nombre, 'Producto') AS producto,
                            COALESCE(ie.stock_actual, 0) AS stock_actual,
                            0 AS stock_minimo,
                            0 AS precio_venta
                        FROM negocio.producto p
                        LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                        ORDER BY COALESCE(ie.stock_actual, 0) ASC, p.nombre ASC
                        LIMIT 120
                        """
                    )
                existencias = [
                    {
                        "producto_id": int(r[0] or 0),
                        "producto": str(r[1] or "Producto"),
                        "stock_actual": int(r[2] or 0),
                        "stock_minimo": int(r[3] or 0),
                        "precio_venta": float(r[4] or 0),
                        "valor_inventario": float((float(r[2] or 0) * float(r[4] or 0))),
                    }
                    for r in cursor.fetchall()
                ]
                total_existencias = int(sum(int(r.get("stock_actual") or 0) for r in existencias))
                valor_total_inventario = round(sum(float(r.get("valor_inventario") or 0) for r in existencias), 2)
                productos_stock_bajo_actual = int(
                    sum(1 for r in existencias if int(r.get("stock_actual") or 0) <= int(r.get("stock_minimo") or 0))
                )
                sin_movimientos = total_movimientos <= 0

                return Response(
                    {
                        "ok": True,
                        "tipo": tipo,
                        "periodo": {"inicio": desde.isoformat(), "fin": hasta.isoformat()},
                        "entradas": entradas,
                        "salidas": salidas,
                        "ventas": ventas,
                        "ventas_web": ventas_web,
                        "ventas_secretaria": ventas_secretaria,
                        "ventas_canales_total": ventas_canales_total,
                        "ajustes": ajustes,
                        "balance_neto": balance_neto,
                        "total_movimientos": total_movimientos,
                        "productos_afectados": productos_afectados,
                        "sin_movimientos": sin_movimientos,
                        "total_existencias": total_existencias,
                        "valor_total_inventario": valor_total_inventario,
                        "productos_stock_bajo_actual": productos_stock_bajo_actual,
                        "cancelaciones_pedido": cancelaciones_pedido,
                        "detalle": detalle,
                        "detalle_cancelaciones": detalle_cancelaciones,
                        "top_productos": top_productos,
                        "detalle_reciente": detalle_reciente,
                        "existencias": existencias,
                    }
                )
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminEmpleadosView(APIView):
    permission_classes = [IsAuthenticated]

    ROLE_MAP_FRONT_TO_DB = {
        "admin": "administrador",
        "barbero": "barbero",
        "secretaria": "secretaria",
        "cliente": "cliente",
    }
    ROLE_MAP_DB_TO_FRONT = {
        "administrador": "admin",
        "barbero": "barbero",
        "secretaria": "secretaria",
        "cliente": "cliente",
    }
    DIA_KEYS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
            return (row[0] if row and row[0] else "").strip().lower()

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def _empleado_es_barbero(self, cursor, empleado_id: int) -> bool:
        cursor.execute(
            """
            SELECT 1
            FROM negocio.empleado e
            JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
            JOIN negocio.rol r ON r.rol_id = ur.rol_id
            WHERE e.empleado_id = %s
              AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
            LIMIT 1
            """,
            [empleado_id],
        )
        return bool(cursor.fetchone())

    def _get_empresa_id(self) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT empresa_id
                FROM negocio.empresa
                ORDER BY empresa_id ASC
                LIMIT 1
                """
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _slugify(self, text: str) -> str:
        s = re.sub(r"[^a-z0-9]+", "_", text.lower(), flags=re.IGNORECASE).strip("_")
        return s or "especialidad"

    def _safe_json_loads(self, raw: Any) -> Any:
        if raw is None or raw == "":
            return None
        if isinstance(raw, (dict, list)):
            return raw
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except (TypeError, ValueError, json.JSONDecodeError):
                return None
        return None

    def _build_horario_json(self, empleado_id: int) -> dict[str, Any]:
        horario = {
            k: {"trabaja": False, "inicio": "", "fin": "", "descanso": ""}
            for k in self.DIA_KEYS
        }
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT dia_semana, trabaja, hora_inicio, hora_fin
                FROM negocio.empleado_horario_dia
                WHERE empleado_id = %s
                ORDER BY dia_semana ASC
                """,
                [empleado_id],
            )
            rows = cursor.fetchall()
            cursor.execute(
                """
                SELECT dia_semana, hora_inicio, hora_fin
                FROM negocio.empleado_descanso
                WHERE empleado_id = %s
                ORDER BY empleado_descanso_id ASC
                """,
                [empleado_id],
            )
            descansos = cursor.fetchall()

        descanso_por_dia: dict[int, str] = {}
        for d, hi, hf in descansos:
            if hi and hf and int(d) not in descanso_por_dia:
                descanso_por_dia[int(d)] = f"{hi.strftime('%H:%M')}-{hf.strftime('%H:%M')}"

        for d, trabaja, hi, hf in rows:
            idx = int(d)
            if idx < 0 or idx > 6:
                continue
            key = self.DIA_KEYS[idx]
            horario[key] = {
                "trabaja": bool(trabaja),
                "inicio": hi.strftime("%H:%M") if hi else "",
                "fin": hf.strftime("%H:%M") if hf else "",
                "descanso": descanso_por_dia.get(idx, ""),
            }
        return horario

    def _build_horario_display(self, horario_json: dict[str, Any]) -> str:
        dias_label = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"]
        partes: list[str] = []
        for idx, key in enumerate(self.DIA_KEYS):
            h = horario_json.get(key) or {}
            if not h.get("trabaja"):
                continue
            ini = str(h.get("inicio") or "").strip()
            fin = str(h.get("fin") or "").strip()
            if ini and fin:
                partes.append(f"{dias_label[idx]} {ini}-{fin}")
        return ", ".join(partes)

    def _get_dias_libres(self, empleado_id: int) -> list[dict[str, Any]]:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT fecha, COALESCE(motivo, ''), estado
                FROM negocio.empleado_dia_libre
                WHERE empleado_id = %s
                ORDER BY fecha ASC, dia_libre_id ASC
                """,
                [empleado_id],
            )
            rows = cursor.fetchall()
        return [
            {
                "fecha": row[0].isoformat() if row[0] else "",
                "motivo": row[1] or "",
                "estado": row[2] or "pendiente",
            }
            for row in rows
        ]

    def _get_periodos_vacaciones(self, empleado_id: int) -> list[dict[str, Any]]:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT fecha_solicitud::date, fecha_inicio, fecha_fin, estado
                FROM negocio.empleado_vacacion
                WHERE empleado_id = %s
                ORDER BY fecha_inicio ASC, vacacion_id ASC
                """,
                [empleado_id],
            )
            rows = cursor.fetchall()
        return [
            {
                "fecha_solicitud": row[0].isoformat() if row[0] else "",
                "fecha_inicio": row[1].isoformat() if row[1] else "",
                "fecha_fin": row[2].isoformat() if row[2] else "",
                "estado": (
                    "aprobado"
                    if row[3] == "aprobada"
                    else ("rechazado" if row[3] == "rechazada" else (row[3] or "pendiente"))
                ),
            }
            for row in rows
        ]

    def _serialize_empleado(self, row: tuple[Any, ...]) -> dict[str, Any]:
        empleado_id = int(row[0])
        horario_json = self._build_horario_json(empleado_id)
        horario_display = self._build_horario_display(horario_json)
        dias_libres = self._get_dias_libres(empleado_id)
        periodos_vacaciones = self._get_periodos_vacaciones(empleado_id)
        hoy = date.today()
        en_vacaciones = any(
            p.get("estado") == "aprobado"
            and p.get("fecha_inicio")
            and p.get("fecha_fin")
            and p["fecha_inicio"] <= hoy.isoformat() <= p["fecha_fin"]
            for p in periodos_vacaciones
        )
        return {
            "id": empleado_id,
            "email": row[1] or "",
            "username": row[2] or "",
            "nombre": row[3] or "",
            "apellido": row[4] or "",
            "telefono": row[5] or "",
            "rol": self.ROLE_MAP_DB_TO_FRONT.get(row[6] or "", row[6] or ""),
            "activo": bool(row[7]),
            "verificado": bool(row[8]),
            "bio": "",  # No existe columna dedicada en el esquema actual.
            "avatar_url": row[9] or "",
            "silla_asignada": row[10] or "",
            "fecha_nacimiento": row[11].isoformat() if row[11] else "",
            "especialidades": row[12] or "",
            "horario_trabajo": json.dumps(horario_json, ensure_ascii=False),
            "horario_display": horario_display,
            "dias_libres": json.dumps(dias_libres, ensure_ascii=False),
            "periodos_vacaciones": json.dumps(periodos_vacaciones, ensure_ascii=False),
            "en_vacaciones": en_vacaciones,
        }

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        rol_param = str(request.query_params.get("rol", "")).strip().lower()
        if self._is_secretaria(request):
            # Secretaría solo gestiona barberos.
            rol_param = "barbero"
        rol_db = self.ROLE_MAP_FRONT_TO_DB.get(rol_param, "")
        empresa_id = self._get_empresa_id()
        if not empresa_id:
            return Response({"ok": True, "empleados": []})

        try:
            with connection.cursor() as cursor:
                sql = """
                    SELECT
                        e.empleado_id,
                        u.email,
                        u.username,
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE(pp.telefono, ''),
                        r.codigo,
                        e.activo,
                        COALESCE(u.verificado, FALSE),
                        COALESCE(pp.avatar_url, ''),
                        COALESCE(s.numero, ''),
                        pp.fecha_nacimiento,
                        COALESCE((
                            SELECT string_agg(esp.nombre, ', ' ORDER BY esp.nombre)
                            FROM negocio.empleado_especialidad ee
                            JOIN negocio.especialidad esp ON esp.especialidad_id = ee.especialidad_id
                            WHERE ee.empleado_id = e.empleado_id
                        ), '')
                    FROM negocio.empleado e
                    JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    LEFT JOIN negocio.empleado_especialidad ee0 ON ee0.empleado_id = e.empleado_id
                    LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    LEFT JOIN negocio.silla s ON s.silla_id = e.silla_id
                    WHERE e.empresa_id = %s
                """
                params: list[Any] = [empresa_id]
                if rol_db:
                    sql += " AND r.codigo = %s"
                    params.append(rol_db)
                sql += " GROUP BY e.empleado_id, u.email, u.username, pp.nombres, pp.apellido_paterno, pp.telefono, r.codigo, e.activo, u.verificado, pp.avatar_url, s.numero, pp.fecha_nacimiento ORDER BY e.empleado_id ASC"
                cursor.execute(sql, params)
                rows = cursor.fetchall()

            empleados = [self._serialize_empleado(row) for row in rows]
            return Response({"ok": True, "empleados": empleados})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        nombre = str(data.get("nombre", "")).strip()
        apellido = str(data.get("apellido", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", "")).strip()
        telefono = str(data.get("telefono", "")).strip()
        fecha_nacimiento = str(data.get("fecha_nacimiento", "")).strip()
        rol_front = str(data.get("rol", "")).strip().lower()
        rol_db = self.ROLE_MAP_FRONT_TO_DB.get(rol_front, "")
        silla_numero = str(data.get("silla_asignada", "")).strip()
        avatar_url = str(data.get("avatar_url", "")).strip()
        especialidades_raw = data.get("especialidades", "")
        horario_raw = data.get("horario_trabajo", "")

        if not nombre or not apellido or not email or not password or not telefono or not rol_db:
            return Response({"ok": False, "error": "Faltan campos obligatorios para crear empleado."}, status=400)
        if self._is_secretaria(request) and rol_front != "barbero":
            return Response(
                {"ok": False, "error": "Secretaría solo puede crear empleados con rol barbero."},
                status=403,
            )

        empresa_id = self._get_empresa_id()
        if not empresa_id:
            return Response({"ok": False, "error": "No existe empresa configurada."}, status=404)

        user_model = get_user_model()
        username_base = (email.split("@")[0] or "empleado").strip().lower()
        username = username_base
        n = 1
        while user_model.objects.filter(username=username).exists():
            n += 1
            username = f"{username_base}{n}"

        try:
            with transaction.atomic():
                dj_user = user_model.objects.create_user(
                    username=username,
                    email=email,
                    password=password,
                    first_name=nombre,
                    last_name=apellido,
                )
                dj_user.is_staff = rol_front == "admin"
                dj_user.is_superuser = False
                dj_user.save(update_fields=["is_staff", "is_superuser"])

                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO negocio.usuario (
                            email, username, password_hash, activo, verificado, proveedor_auth
                        )
                        VALUES (%s, %s, %s, TRUE, TRUE, 'local')
                        RETURNING usuario_id
                        """,
                        [email, username, make_password(password)],
                    )
                    usuario_id = int(cursor.fetchone()[0])

                    cursor.execute("SELECT rol_id FROM negocio.rol WHERE codigo = %s LIMIT 1", [rol_db])
                    rol_row = cursor.fetchone()
                    if not rol_row:
                        return Response({"ok": False, "error": f"Rol '{rol_db}' no existe en catálogo negocio.rol."}, status=400)
                    rol_id = int(rol_row[0])

                    cursor.execute(
                        """
                        INSERT INTO negocio.usuario_rol (usuario_id, rol_id)
                        VALUES (%s, %s)
                        ON CONFLICT (usuario_id, rol_id) DO NOTHING
                        """,
                        [usuario_id, rol_id],
                    )

                    cursor.execute(
                        """
                        INSERT INTO negocio.perfil_persona (
                            usuario_id, nombres, apellido_paterno, telefono, fecha_nacimiento, avatar_url,
                            acepto_privacidad, acepto_terminos
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, TRUE, TRUE)
                        ON CONFLICT (usuario_id)
                        DO UPDATE SET
                            nombres = EXCLUDED.nombres,
                            apellido_paterno = EXCLUDED.apellido_paterno,
                            telefono = EXCLUDED.telefono,
                            fecha_nacimiento = EXCLUDED.fecha_nacimiento,
                            avatar_url = EXCLUDED.avatar_url
                        """,
                        [usuario_id, nombre, apellido, telefono or None, fecha_nacimiento or None, avatar_url or None],
                    )

                    silla_id = None
                    if rol_front == "barbero" and silla_numero:
                        cursor.execute(
                            """
                            SELECT silla_id
                            FROM negocio.silla
                            WHERE empresa_id = %s AND numero = %s AND activa = TRUE
                            LIMIT 1
                            """,
                            [empresa_id, silla_numero],
                        )
                        silla_row = cursor.fetchone()
                        silla_id = int(silla_row[0]) if silla_row else None

                    cursor.execute(
                        """
                        INSERT INTO negocio.empleado (usuario_id, empresa_id, silla_id, activo, fecha_ingreso)
                        VALUES (%s, %s, %s, TRUE, CURRENT_DATE)
                        RETURNING empleado_id
                        """,
                        [usuario_id, empresa_id, silla_id],
                    )
                    empleado_id = int(cursor.fetchone()[0])

                    especialidades = self._safe_json_loads(especialidades_raw)
                    if isinstance(especialidades, list):
                        for esp_nombre_raw in especialidades:
                            esp_nombre = str(esp_nombre_raw or "").strip()
                            if not esp_nombre:
                                continue
                            cursor.execute(
                                "SELECT especialidad_id FROM negocio.especialidad WHERE LOWER(nombre) = LOWER(%s) LIMIT 1",
                                [esp_nombre],
                            )
                            esp_row = cursor.fetchone()
                            if esp_row:
                                esp_id = int(esp_row[0])
                            else:
                                codigo = self._slugify(esp_nombre)
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.especialidad (codigo, nombre, activa)
                                    VALUES (%s, %s, TRUE)
                                    ON CONFLICT (codigo)
                                    DO UPDATE SET nombre = EXCLUDED.nombre
                                    RETURNING especialidad_id
                                    """,
                                    [codigo, esp_nombre],
                                )
                                esp_id = int(cursor.fetchone()[0])
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_especialidad (empleado_id, especialidad_id)
                                VALUES (%s, %s)
                                ON CONFLICT (empleado_id, especialidad_id) DO NOTHING
                                """,
                                [empleado_id, esp_id],
                            )

                    horario_data = self._safe_json_loads(horario_raw)
                    if isinstance(horario_data, dict):
                        for idx, dia_key in enumerate(self.DIA_KEYS):
                            d = horario_data.get(dia_key) or {}
                            trabaja = bool(d.get("trabaja", False))
                            inicio = str(d.get("inicio", "")).strip() or None
                            fin = str(d.get("fin", "")).strip() or None
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_horario_dia (
                                    empleado_id, dia_semana, trabaja, hora_inicio, hora_fin
                                )
                                VALUES (%s, %s, %s, %s, %s)
                                ON CONFLICT (empleado_id, dia_semana)
                                DO UPDATE SET
                                    trabaja = EXCLUDED.trabaja,
                                    hora_inicio = EXCLUDED.hora_inicio,
                                    hora_fin = EXCLUDED.hora_fin
                                """,
                                [empleado_id, idx, trabaja, inicio if trabaja else None, fin if trabaja else None],
                            )
                            descanso = str(d.get("descanso", "")).strip()
                            m = re.match(r"^(\d{2}:\d{2})-(\d{2}:\d{2})$", descanso)
                            if trabaja and m:
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.empleado_descanso (empleado_id, dia_semana, hora_inicio, hora_fin)
                                    VALUES (%s, %s, %s, %s)
                                    """,
                                    [empleado_id, idx, m.group(1), m.group(2)],
                                )

                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            e.empleado_id,
                            u.email,
                            u.username,
                            COALESCE(pp.nombres, ''),
                            COALESCE(pp.apellido_paterno, ''),
                            COALESCE(pp.telefono, ''),
                            r.codigo,
                            e.activo,
                            COALESCE(u.verificado, FALSE),
                            COALESCE(pp.avatar_url, ''),
                            COALESCE(s.numero, ''),
                            pp.fecha_nacimiento,
                            COALESCE((
                                SELECT string_agg(esp.nombre, ', ' ORDER BY esp.nombre)
                                FROM negocio.empleado_especialidad ee
                                JOIN negocio.especialidad esp ON esp.especialidad_id = ee.especialidad_id
                                WHERE ee.empleado_id = e.empleado_id
                            ), '')
                        FROM negocio.empleado e
                        JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                        LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                        LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                        LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                        LEFT JOIN negocio.silla s ON s.silla_id = e.silla_id
                        WHERE e.empleado_id = %s
                        GROUP BY e.empleado_id, u.email, u.username, pp.nombres, pp.apellido_paterno, pp.telefono, r.codigo, e.activo, u.verificado, pp.avatar_url, s.numero, pp.fecha_nacimiento
                        """,
                        [empleado_id],
                    )
                    row = cursor.fetchone()
                return Response({"ok": True, "empleado": self._serialize_empleado(row)})
        except DatabaseError as exc:
            return db_structure_error_response(exc)
        except Exception as exc:
            return Response({"ok": False, "error": str(exc)}, status=400)


class AdminEmpleadoDetalleView(AdminEmpleadosView):
    def get(self, request, empleado_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        e.empleado_id,
                        u.email,
                        u.username,
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE(pp.telefono, ''),
                        r.codigo,
                        e.activo,
                        COALESCE(u.verificado, FALSE),
                        COALESCE(pp.avatar_url, ''),
                        COALESCE(s.numero, ''),
                        pp.fecha_nacimiento,
                        COALESCE((
                            SELECT string_agg(esp.nombre, ', ' ORDER BY esp.nombre)
                            FROM negocio.empleado_especialidad ee
                            JOIN negocio.especialidad esp ON esp.especialidad_id = ee.especialidad_id
                            WHERE ee.empleado_id = e.empleado_id
                        ), '')
                    FROM negocio.empleado e
                    JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    LEFT JOIN negocio.silla s ON s.silla_id = e.silla_id
                    WHERE e.empleado_id = %s
                    GROUP BY e.empleado_id, u.email, u.username, pp.nombres, pp.apellido_paterno, pp.telefono, r.codigo, e.activo, u.verificado, pp.avatar_url, s.numero, pp.fecha_nacimiento
                    """,
                    [empleado_id],
                )
                row = cursor.fetchone()
            if not row:
                return Response({"ok": False, "error": "Empleado no encontrado."}, status=404)
            if self._is_secretaria(request):
                rol_objetivo = str(row[6] or "").strip().lower()
                if rol_objetivo != "barbero":
                    return Response({"detail": "No autorizado."}, status=403)
            return Response({"ok": True, "empleado": self._serialize_empleado(row)})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def put(self, request, empleado_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT e.empleado_id, e.usuario_id, u.username
                        FROM negocio.empleado e
                        JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                        WHERE e.empleado_id = %s
                        LIMIT 1
                        """,
                        [empleado_id],
                    )
                    base = cursor.fetchone()
                    if not base:
                        return Response({"ok": False, "error": "Empleado no encontrado."}, status=404)
                    usuario_id = int(base[1])
                    username = base[2]
                    if self._is_secretaria(request) and not self._empleado_es_barbero(cursor, empleado_id):
                        return Response({"detail": "No autorizado."}, status=403)

                    nombre = str(data.get("nombre", "")).strip()
                    apellido = str(data.get("apellido", "")).strip()
                    telefono = str(data.get("telefono", "")).strip()
                    fecha_nacimiento = str(data.get("fecha_nacimiento", "")).strip() or None
                    rol_front = str(data.get("rol", "")).strip().lower()
                    rol_db = self.ROLE_MAP_FRONT_TO_DB.get(rol_front, "")
                    if self._is_secretaria(request) and rol_front and rol_front != "barbero":
                        return Response(
                            {"ok": False, "error": "Secretaría solo puede asignar o mantener rol barbero."},
                            status=403,
                        )
                    activo = bool(data.get("activo", True))
                    avatar_url = str(data.get("avatar_url", "")).strip()
                    silla_numero = str(data.get("silla_asignada", "")).strip()

                    if nombre:
                        cursor.execute(
                            """
                            INSERT INTO negocio.perfil_persona (
                                usuario_id, nombres, apellido_paterno, telefono, fecha_nacimiento, avatar_url,
                                acepto_privacidad, acepto_terminos
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, TRUE, TRUE)
                            ON CONFLICT (usuario_id)
                            DO UPDATE SET
                                nombres = EXCLUDED.nombres,
                                apellido_paterno = EXCLUDED.apellido_paterno,
                                telefono = EXCLUDED.telefono,
                                fecha_nacimiento = EXCLUDED.fecha_nacimiento,
                                avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE negocio.perfil_persona.avatar_url END
                            """,
                            [usuario_id, nombre, apellido, telefono or None, fecha_nacimiento, avatar_url],
                        )

                    silla_id = None
                    if rol_front == "barbero" and silla_numero:
                        cursor.execute(
                            """
                            SELECT silla_id
                            FROM negocio.silla
                            WHERE numero = %s AND activa = TRUE
                            LIMIT 1
                            """,
                            [silla_numero],
                        )
                        row_silla = cursor.fetchone()
                        silla_id = int(row_silla[0]) if row_silla else None

                    cursor.execute(
                        """
                        UPDATE negocio.empleado
                        SET
                            activo = %s,
                            silla_id = %s
                        WHERE empleado_id = %s
                        """,
                        [activo, silla_id if rol_front == "barbero" else None, empleado_id],
                    )

                    if rol_db:
                        cursor.execute("SELECT rol_id FROM negocio.rol WHERE codigo = %s LIMIT 1", [rol_db])
                        rol_row = cursor.fetchone()
                        if rol_row:
                            cursor.execute("DELETE FROM negocio.usuario_rol WHERE usuario_id = %s", [usuario_id])
                            cursor.execute(
                                "INSERT INTO negocio.usuario_rol (usuario_id, rol_id) VALUES (%s, %s)",
                                [usuario_id, int(rol_row[0])],
                            )

                    especialidades = self._safe_json_loads(data.get("especialidades", ""))
                    if isinstance(especialidades, list):
                        cursor.execute("DELETE FROM negocio.empleado_especialidad WHERE empleado_id = %s", [empleado_id])
                        for esp_nombre_raw in especialidades:
                            esp_nombre = str(esp_nombre_raw or "").strip()
                            if not esp_nombre:
                                continue
                            cursor.execute(
                                "SELECT especialidad_id FROM negocio.especialidad WHERE LOWER(nombre)=LOWER(%s) LIMIT 1",
                                [esp_nombre],
                            )
                            esp_row = cursor.fetchone()
                            if esp_row:
                                esp_id = int(esp_row[0])
                            else:
                                codigo = self._slugify(esp_nombre)
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.especialidad (codigo, nombre, activa)
                                    VALUES (%s, %s, TRUE)
                                    ON CONFLICT (codigo)
                                    DO UPDATE SET nombre = EXCLUDED.nombre
                                    RETURNING especialidad_id
                                    """,
                                    [codigo, esp_nombre],
                                )
                                esp_id = int(cursor.fetchone()[0])
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_especialidad (empleado_id, especialidad_id)
                                VALUES (%s, %s)
                                ON CONFLICT (empleado_id, especialidad_id) DO NOTHING
                                """,
                                [empleado_id, esp_id],
                            )

                    horario_data = self._safe_json_loads(data.get("horario_trabajo", ""))
                    if isinstance(horario_data, dict):
                        cursor.execute("DELETE FROM negocio.empleado_descanso WHERE empleado_id = %s", [empleado_id])
                        for idx, dia_key in enumerate(self.DIA_KEYS):
                            d = horario_data.get(dia_key) or {}
                            trabaja = bool(d.get("trabaja", False))
                            inicio = str(d.get("inicio", "")).strip() or None
                            fin = str(d.get("fin", "")).strip() or None
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_horario_dia (
                                    empleado_id, dia_semana, trabaja, hora_inicio, hora_fin
                                )
                                VALUES (%s, %s, %s, %s, %s)
                                ON CONFLICT (empleado_id, dia_semana)
                                DO UPDATE SET
                                    trabaja = EXCLUDED.trabaja,
                                    hora_inicio = EXCLUDED.hora_inicio,
                                    hora_fin = EXCLUDED.hora_fin
                                """,
                                [empleado_id, idx, trabaja, inicio if trabaja else None, fin if trabaja else None],
                            )
                            descanso = str(d.get("descanso", "")).strip()
                            m = re.match(r"^(\d{2}:\d{2})-(\d{2}:\d{2})$", descanso)
                            if trabaja and m:
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.empleado_descanso (empleado_id, dia_semana, hora_inicio, hora_fin)
                                    VALUES (%s, %s, %s, %s)
                                    """,
                                    [empleado_id, idx, m.group(1), m.group(2)],
                                )

                    dias_libres = self._safe_json_loads(data.get("dias_libres", ""))
                    if isinstance(dias_libres, list):
                        cursor.execute("DELETE FROM negocio.empleado_dia_libre WHERE empleado_id = %s", [empleado_id])
                        for item in dias_libres:
                            if not isinstance(item, dict):
                                continue
                            f = str(item.get("fecha", "")).strip()
                            if not f:
                                continue
                            motivo = str(item.get("motivo", "")).strip()
                            estado = str(item.get("estado", "pendiente")).strip() or "pendiente"
                            if estado not in {"pendiente", "aprobado", "rechazado"}:
                                estado = "pendiente"
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_dia_libre (empleado_id, fecha, motivo, estado)
                                VALUES (%s, %s, %s, %s)
                                """,
                                [empleado_id, f, motivo or None, estado],
                            )

                    periodos = self._safe_json_loads(data.get("periodos_vacaciones", ""))
                    if isinstance(periodos, list):
                        cursor.execute("DELETE FROM negocio.empleado_vacacion WHERE empleado_id = %s", [empleado_id])
                        for item in periodos:
                            if not isinstance(item, dict):
                                continue
                            fi = str(item.get("fecha_inicio", "")).strip()
                            ff = str(item.get("fecha_fin", "")).strip()
                            if not fi or not ff:
                                continue
                            estado_front = str(item.get("estado", "pendiente")).strip() or "pendiente"
                            if estado_front == "aprobado":
                                estado_db = "aprobada"
                            elif estado_front == "rechazado":
                                estado_db = "rechazada"
                            else:
                                estado_db = estado_front
                            if estado_db not in {"pendiente", "aprobada", "rechazada"}:
                                estado_db = "pendiente"
                            cursor.execute(
                                """
                                INSERT INTO negocio.empleado_vacacion (empleado_id, fecha_inicio, fecha_fin, estado)
                                VALUES (%s, %s, %s, %s)
                                """,
                                [empleado_id, fi, ff, estado_db],
                            )

                    # Mantener usuario Django activo/inactivo según estado de empleado.
                    user_model = get_user_model()
                    dj = user_model.objects.filter(username=username).first()
                    if dj:
                        dj.first_name = nombre or dj.first_name
                        dj.last_name = apellido or dj.last_name
                        dj.is_active = activo
                        dj.is_staff = rol_front == "admin"
                        dj.save()

                return self.get(request, empleado_id)
        except DatabaseError as exc:
            return db_structure_error_response(exc)
        except Exception as exc:
            return Response({"ok": False, "error": str(exc)}, status=400)

    def delete(self, request, empleado_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with connection.cursor() as cursor:
                if self._is_secretaria(request) and not self._empleado_es_barbero(cursor, empleado_id):
                    return Response({"detail": "No autorizado."}, status=403)
                cursor.execute(
                    "UPDATE negocio.empleado SET activo = FALSE WHERE empleado_id = %s",
                    [empleado_id],
                )
                if cursor.rowcount == 0:
                    return Response({"ok": False, "error": "Empleado no encontrado."}, status=404)
            return Response({"ok": True})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


CLIP_2FA_SALT = "clip_credentials_2fa"
CLIP_2FA_CACHE_TIMEOUT = 600  # 10 minutos


def _send_clip_2fa_email(email: str, codigo: str) -> bool:
    """Envía el código 2FA por correo para actualizar credenciales Clip."""
    asunto = "Verificación Clip — Stylo Barber Connect"
    plain, html_body = build_otp_email_pair(
        eyebrow="Administración",
        title="Credenciales de pago Clip",
        lead="Introduce este código en el panel para confirmar la actualización de credenciales Clip.",
        codigo=codigo,
        minutes=10,
        footer="Si no solicitaste este cambio, revisa la seguridad de tu cuenta de administrador.",
    )
    return send_stylo_transactional(email, asunto, plain, html_body)


class ClipSolicitar2FAView(APIView):
    """Solicita envío de código 2FA por email para poder actualizar credenciales Clip."""
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "Solo administradores pueden solicitar este código."}, status=403)
        email = getattr(request.user, "email", "") or ""
        if not email:
            return Response({"ok": False, "error": "No hay correo asociado al usuario."}, status=400)
        codigo = f"{secrets.randbelow(1_000_000):06d}"
        cache_key = f"clip_2fa:{request.user.id}"
        cache.set(cache_key, codigo, CLIP_2FA_CACHE_TIMEOUT)
        enviado = _send_clip_2fa_email(email, codigo)
        signer = TimestampSigner(salt=CLIP_2FA_SALT)
        temp_token = signer.sign(json.dumps({"user_id": request.user.id, "purpose": "clip_2fa"}))
        payload = {
            "ok": True,
            "tempToken": temp_token,
            "mensaje": "Se envió un código de verificación a tu correo. Úsalo para confirmar el cambio de credenciales Clip.",
        }
        if not enviado:
            payload["mensaje"] = "No se pudo enviar el correo. Revisa la configuración de email."
            if settings.DEBUG:
                payload["codigo_debug"] = codigo
        return Response(payload)


class AdminConfiguracionView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return str(row[0] or "") if row else ""

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def _normalizar_paqueterias(self, raw: Any) -> list[str]:
        if raw is None:
            return []

        if isinstance(raw, list):
            candidatos = raw
        else:
            texto = str(raw).strip()
            if not texto:
                return []
            if texto.startswith("paqueterias::"):
                texto = texto[len("paqueterias::") :].strip()
            if texto.startswith("[") or texto.startswith("{"):
                try:
                    dec = json.loads(texto)
                    if isinstance(dec, dict):
                        candidatos = dec.get("paqueterias", [])
                    elif isinstance(dec, list):
                        candidatos = dec
                    else:
                        candidatos = []
                except Exception:
                    candidatos = re.split(r"[,\n;]+", texto)
            else:
                candidatos = re.split(r"[,\n;]+", texto)

        visto: set[str] = set()
        resultado: list[str] = []
        for item in candidatos:
            nombre = str(item or "").strip()
            if not nombre:
                continue
            k = nombre.lower()
            if k in visto:
                continue
            visto.add(k)
            resultado.append(nombre)
        return resultado

    def _extraer_config_extra(self, raw: Any) -> dict[str, Any]:
        out: dict[str, Any] = {
            "paqueterias_disponibles": [],
            "clip_habilitado": False,
            "clip_url": "",
            "clip_api_key_enc": "",
            "clip_api_secret_enc": "",
            "clip_auth_token_enc": "",
        }
        texto = str(raw or "").strip()
        if not texto:
            return out

        # Formato actual: configuración extra unificada.
        if texto.startswith("{"):
            try:
                payload = json.loads(texto)
                if isinstance(payload, dict):
                    if payload.get("_sys") == "config_extra":
                        out["paqueterias_disponibles"] = self._normalizar_paqueterias(
                            payload.get("paqueterias_disponibles", [])
                        )
                        clip = payload.get("clip", {})
                        if isinstance(clip, dict):
                            out["clip_habilitado"] = bool(clip.get("habilitado", False))
                            out["clip_url"] = str(clip.get("url", "") or "").strip()
                            out["clip_api_key_enc"] = str(
                                clip.get("api_key_enc", clip.get("api_key_test_enc", "")) or ""
                            ).strip()
                            out["clip_api_secret_enc"] = str(
                                clip.get("api_secret_enc", clip.get("api_secret_test_enc", "")) or ""
                            ).strip()
                            out["clip_auth_token_enc"] = str(clip.get("auth_token_enc", "") or "").strip()
                        return out

                    # Compatibilidad con formato anterior.
                    if payload.get("_sys") == "paqueterias_disponibles":
                        out["paqueterias_disponibles"] = self._normalizar_paqueterias(payload.get("items", []))
                        return out
            except Exception:
                pass

        # Compatibilidad con formato legado tipo "paqueterias::".
        if texto.startswith("paqueterias::"):
            out["paqueterias_disponibles"] = self._normalizar_paqueterias(texto)
            return out

        return out

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        e.empresa_id,
                        e.nombre_negocio,
                        COALESCE(e.telefono, ''),
                        COALESCE(e.email_contacto, ''),
                        COALESCE(e.direccion_texto, ''),
                        e.logo_tipo,
                        COALESCE(e.logo_texto_parte1, ''),
                        COALESCE(e.logo_texto_parte2, ''),
                        COALESCE(e.logo_url, ''),
                        COALESCE(e.google_maps_url, ''),
                        COALESCE(e.apple_maps_url, '')
                    FROM negocio.empresa e
                    ORDER BY e.empresa_id ASC
                    LIMIT 1
                    """
                )
                empresa_row = cursor.fetchone()

                if not empresa_row:
                    return Response(
                        {
                            "detail": "No hay datos en negocio.empresa. Configura la empresa primero.",
                        },
                        status=404,
                    )

                empresa_id = int(empresa_row[0])

                cursor.execute(
                    """
                    SELECT plataforma, url, activa
                    FROM negocio.red_social_negocio
                    WHERE empresa_id = %s
                    """,
                    [empresa_id],
                )
                redes_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT dia_semana, abierto, hora_apertura, hora_cierre
                    FROM negocio.horario_negocio
                    WHERE empresa_id = %s
                    ORDER BY dia_semana ASC
                    """,
                    [empresa_id],
                )
                horarios_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT
                        COALESCE(banco_nombre, ''),
                        COALESCE(titular, ''),
                        COALESCE(clabe, COALESCE(numero_cuenta, ''))
                    FROM negocio.cuenta_bancaria
                    WHERE empresa_id = %s
                      AND activa = TRUE
                    ORDER BY cuenta_bancaria_id DESC
                    LIMIT 1
                    """,
                    [empresa_id],
                )
                cuenta_row = cursor.fetchone()

                cursor.execute(
                    """
                    SELECT
                        porcentaje_anticipo,
                        citas_penalizacion,
                        tiempo_espera_maximo_min
                    FROM negocio.politica_anticipo
                    WHERE empresa_id = %s
                      AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
                    ORDER BY vigente_desde DESC, politica_anticipo_id DESC
                    LIMIT 1
                    """,
                    [empresa_id],
                )
                politica_row = cursor.fetchone()

                cursor.execute(
                    """
                    SELECT codigo, costo_fijo
                    FROM negocio.metodo_entrega
                    WHERE codigo IN ('tienda', 'moto_mandado', 'paqueteria')
                    """
                )
                metodos_entrega_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT codigo, activo
                    FROM negocio.metodo_pago_catalogo
                    WHERE codigo IN ('efectivo', 'tarjeta', 'transferencia')
                    """
                )
                metodos_pago_rows = cursor.fetchall()

            redes: dict[str, str] = {
                "facebook_url": "",
                "instagram_url": "",
                "x_url": "",
                "tiktok_url": "",
                "whatsapp_url": "",
            }
            paqueterias_disponibles: list[str] = ["DHL", "Estafeta", "FedEx", "Paquetexpress"]
            clip_habilitado = False
            clip_url = ""
            clip_api_key_masked = ""
            clip_api_secret_configurada = False
            clip_auth_token_configurada = False
            for plataforma, url, activa in redes_rows:
                if not activa:
                    continue
                if plataforma == "otro":
                    cfg_extra = self._extraer_config_extra(url)
                    parsed = cfg_extra.get("paqueterias_disponibles") or []
                    if parsed:
                        paqueterias_disponibles = parsed
                    clip_habilitado = bool(cfg_extra.get("clip_habilitado", False))
                    clip_url = str(cfg_extra.get("clip_url", "") or "").strip()
                    clip_api_key_plain = _clip_decrypt(str(cfg_extra.get("clip_api_key_enc", "") or "").strip())
                    clip_api_secret_plain = _clip_decrypt(str(cfg_extra.get("clip_api_secret_enc", "") or "").strip())
                    clip_auth_token_plain = _clip_decrypt(str(cfg_extra.get("clip_auth_token_enc", "") or "").strip())
                    if clip_api_key_plain:
                        if len(clip_api_key_plain) <= 6:
                            clip_api_key_masked = "*" * len(clip_api_key_plain)
                        else:
                            clip_api_key_masked = (
                                f"{clip_api_key_plain[:4]}{'*' * max(4, len(clip_api_key_plain) - 8)}{clip_api_key_plain[-4:]}"
                            )
                    clip_api_secret_configurada = bool(clip_api_secret_plain)
                    clip_auth_token_configurada = bool(clip_auth_token_plain)
                    continue
                key = f"{plataforma}_url"
                if key in redes:
                    redes[key] = url or ""

            costos_envio = {
                "recoger_local": 0.0,
                "moto_mandado": 45.0,
                "paqueteria": 150.0,
            }
            for codigo, costo in metodos_entrega_rows:
                if codigo == "tienda":
                    costos_envio["recoger_local"] = float(costo or 0)
                elif codigo == "moto_mandado":
                    costos_envio["moto_mandado"] = float(costo or 0)
                elif codigo == "paqueteria":
                    costos_envio["paqueteria"] = float(costo or 0)

            pagos_activos = {
                "efectivo": True,
                "tarjeta": False,
                "transferencia": True,
            }
            for codigo, activo in metodos_pago_rows:
                pagos_activos[str(codigo)] = bool(activo)

            horarios = [
                {
                    "dia_semana": int(row[0]),
                    "abierto": bool(row[1]),
                    "hora_apertura": row[2].strftime("%H:%M") if row[2] else None,
                    "hora_cierre": row[3].strftime("%H:%M") if row[3] else None,
                }
                for row in horarios_rows
            ]

            return Response(
                {
                    "empresa_id": empresa_id,
                    "nombre_negocio": empresa_row[1],
                    "telefono": empresa_row[2],
                    "email_contacto": empresa_row[3],
                    "direccion_texto": empresa_row[4],
                    "logo_tipo": empresa_row[5],
                    "logo_texto_parte1": empresa_row[6],
                    "logo_texto_parte2": empresa_row[7],
                    "logo_url": empresa_row[8],
                    "google_maps_url": empresa_row[9],
                    "apple_maps_url": empresa_row[10],
                    "porcentaje_anticipo": float(politica_row[0]) if politica_row else 0.0,
                    "citas_penalizacion": int(politica_row[1]) if politica_row else 0,
                    "tiempo_espera_maximo": int(politica_row[2]) if politica_row else 10,
                    "banco_nombre": cuenta_row[0] if cuenta_row else "",
                    "banco_titular": cuenta_row[1] if cuenta_row else "",
                    "banco_cuenta": cuenta_row[2] if cuenta_row else "",
                    **redes,
                    "horarios": horarios,
                    "costos_envio": costos_envio,
                    "paqueterias_disponibles": paqueterias_disponibles,
                    "pago_efectivo_activo": pagos_activos["efectivo"],
                    "pago_tarjeta_activo": pagos_activos["tarjeta"],
                    "pago_transferencia_activo": pagos_activos["transferencia"],
                    "clip_habilitado": clip_habilitado,
                    "clip_url": clip_url,
                    "clip_api_key_masked": clip_api_key_masked,
                    "clip_api_secret_configurada": clip_api_secret_configurada,
                    "clip_auth_token_configurada": clip_auth_token_configurada,
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def put(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}

        nombre_negocio = str(data.get("nombre_negocio", "")).strip()
        telefono = str(data.get("telefono", "")).strip()
        email_contacto = str(data.get("email_contacto", "")).strip()
        direccion_texto = str(data.get("direccion_texto", "")).strip()
        logo_tipo = str(data.get("logo_tipo", "texto")).strip() or "texto"
        logo_texto_parte1 = str(data.get("logo_texto_parte1", "")).strip()
        logo_texto_parte2 = str(data.get("logo_texto_parte2", "")).strip()
        logo_url = str(data.get("logo_url", "")).strip()
        google_maps_url = str(data.get("google_maps_url", "")).strip()
        apple_maps_url = str(data.get("apple_maps_url", "")).strip()
        banco_nombre = str(data.get("banco_nombre", "")).strip()
        banco_titular = str(data.get("banco_titular", "")).strip()
        banco_cuenta = str(data.get("banco_cuenta", "")).strip()
        porcentaje_anticipo_raw = data.get("porcentaje_anticipo", 0)
        citas_penalizacion_raw = data.get("citas_penalizacion", 0)
        tiempo_espera_maximo_raw = data.get("tiempo_espera_maximo", 10)
        costos_envio_raw = data.get("costos_envio")
        paqueterias_disponibles_raw = data.get("paqueterias_disponibles")
        pago_efectivo_activo_raw = data.get("pago_efectivo_activo", True)
        pago_tarjeta_activo_raw = data.get("pago_tarjeta_activo", False)
        pago_transferencia_activo_raw = data.get("pago_transferencia_activo", True)
        clip_habilitado_raw = data.get("clip_habilitado", pago_tarjeta_activo_raw)
        clip_url = str(data.get("clip_url", "") or "").strip()
        clip_api_key_raw = data.get("clip_api_key", data.get("clip_api_key_prueba"))
        clip_api_secret_raw = data.get("clip_api_secret", data.get("clip_api_secret_prueba"))
        clip_auth_token_raw = data.get("clip_auth_token")

        try:
            porcentaje_anticipo = float(porcentaje_anticipo_raw)
        except (TypeError, ValueError):
            return Response({"detail": "porcentaje_anticipo invalido."}, status=400)
        try:
            citas_penalizacion = int(citas_penalizacion_raw)
        except (TypeError, ValueError):
            return Response({"detail": "citas_penalizacion invalido."}, status=400)
        try:
            tiempo_espera_maximo = int(tiempo_espera_maximo_raw)
        except (TypeError, ValueError):
            return Response({"detail": "tiempo_espera_maximo invalido."}, status=400)

        if porcentaje_anticipo < 0 or porcentaje_anticipo > 100:
            return Response({"detail": "porcentaje_anticipo debe estar entre 0 y 100."}, status=400)
        if citas_penalizacion < 1 or citas_penalizacion > 50:
            return Response({"detail": "citas_penalizacion debe estar entre 1 y 50."}, status=400)
        if tiempo_espera_maximo < 5 or tiempo_espera_maximo > 60:
            return Response({"detail": "tiempo_espera_maximo debe estar entre 5 y 60."}, status=400)

        if logo_tipo not in ("texto", "imagen"):
            return Response({"detail": "logo_tipo invalido. Usa 'texto' o 'imagen'."}, status=400)

        if not nombre_negocio:
            return Response({"detail": "nombre_negocio es obligatorio."}, status=400)

        if costos_envio_raw is not None and not isinstance(costos_envio_raw, dict):
            return Response({"detail": "costos_envio debe ser un objeto."}, status=400)

        def _to_non_negative_float(value: Any, field: str) -> float:
            try:
                parsed = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{field} invalido.")
            if parsed < 0:
                raise ValueError(f"{field} no puede ser negativo.")
            return parsed

        try:
            costos_envio = {
                "recoger_local": _to_non_negative_float(
                    (costos_envio_raw or {}).get("recoger_local", 0),
                    "costos_envio.recoger_local",
                ),
                "moto_mandado": _to_non_negative_float(
                    (costos_envio_raw or {}).get("moto_mandado", 45),
                    "costos_envio.moto_mandado",
                ),
                "paqueteria": _to_non_negative_float(
                    (costos_envio_raw or {}).get("paqueteria", 150),
                    "costos_envio.paqueteria",
                ),
            }
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)

        if paqueterias_disponibles_raw is not None and not isinstance(paqueterias_disponibles_raw, (list, str)):
            return Response({"detail": "paqueterias_disponibles debe ser lista o texto."}, status=400)
        paqueterias_disponibles = self._normalizar_paqueterias(paqueterias_disponibles_raw)

        def _to_bool(v: Any) -> bool:
            if isinstance(v, bool):
                return v
            return str(v).strip().lower() in {"1", "true", "si", "sí", "yes", "on"}

        pago_efectivo_activo = _to_bool(pago_efectivo_activo_raw)
        pago_tarjeta_activo = _to_bool(pago_tarjeta_activo_raw)
        pago_transferencia_activo = _to_bool(pago_transferencia_activo_raw)
        clip_habilitado = _to_bool(clip_habilitado_raw)

        if clip_url and not re.match(r"^https?://", clip_url):
            return Response({"detail": "clip_url debe iniciar con http:// o https://."}, status=400)

        clip_api_key = str(clip_api_key_raw or "").strip() if clip_api_key_raw is not None else ""
        clip_api_secret = str(clip_api_secret_raw or "").strip() if clip_api_secret_raw is not None else ""
        clip_auth_token = str(clip_auth_token_raw or "").strip() if clip_auth_token_raw is not None else ""
        if (clip_api_key and not clip_api_secret) or (clip_api_secret and not clip_api_key):
            return Response(
                {"detail": "Para actualizar credenciales Clip debes capturar API Key y API Secret."},
                status=400,
            )
        if clip_auth_token and " " not in clip_auth_token:
            clip_auth_token = f"Basic {clip_auth_token}"

        # Si se están actualizando credenciales Clip, exigir verificación 2FA.
        # Todas las respuestas de error aquí son ANTES de cualquier escritura en BD:
        # código correcto → se borra el código de caché y se continúa; código erróneo → 400 sin guardar nada.
        actualizando_credenciales_clip = bool(clip_api_key or clip_api_secret or clip_auth_token)
        if actualizando_credenciales_clip:
            codigo_2fa = str(data.get("codigo_2fa", "") or "").strip()
            temp_token_clip = str(data.get("temp_token_clip", "") or "").strip()
            if not codigo_2fa or not temp_token_clip:
                return Response(
                    {
                        "requires_2fa": True,
                        "error": "Para actualizar credenciales Clip debes verificar con el código enviado a tu correo. Solicita el código e ingrésalo al guardar.",
                    },
                    status=403,
                )
            try:
                signer = TimestampSigner(salt=CLIP_2FA_SALT)
                payload_2fa = json.loads(signer.unsign(temp_token_clip, max_age=CLIP_2FA_CACHE_TIMEOUT))
                if payload_2fa.get("user_id") != request.user.id or payload_2fa.get("purpose") != "clip_2fa":
                    return Response({"error": "Token de verificación inválido."}, status=400)
            except Exception:
                return Response(
                    {"error": "Código o token de verificación inválido o expirado. Solicita un nuevo código."},
                    status=400,
                )
            cache_key = f"clip_2fa:{request.user.id}"
            codigo_guardado = cache.get(cache_key)
            if codigo_guardado is None or codigo_guardado != codigo_2fa:
                return Response({"error": "El código de verificación no es correcto o ya expiró."}, status=400)
            cache.delete(cache_key)

        redes_payload: dict[str, Any] = {
            "facebook": data.get("facebook_url", ""),
            "instagram": data.get("instagram_url", ""),
            "x": data.get("x_url", ""),
            "tiktok": data.get("tiktok_url", ""),
            "whatsapp": data.get("whatsapp_url", ""),
        }

        horarios_payload = data.get("horarios")
        if horarios_payload is not None and not isinstance(horarios_payload, list):
            return Response({"detail": "horarios debe ser una lista."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT empresa_id
                        FROM negocio.empresa
                        ORDER BY empresa_id ASC
                        LIMIT 1
                        """
                    )
                    empresa_row = cursor.fetchone()

                    if empresa_row:
                        empresa_id = int(empresa_row[0])
                        cursor.execute(
                            """
                            UPDATE negocio.empresa
                            SET
                                nombre_negocio = %s,
                                telefono = %s,
                                email_contacto = %s,
                                direccion_texto = %s,
                                logo_tipo = %s,
                                logo_texto_parte1 = %s,
                                logo_texto_parte2 = %s,
                                logo_url = %s,
                                google_maps_url = %s,
                                apple_maps_url = %s
                            WHERE empresa_id = %s
                            """,
                            [
                                nombre_negocio,
                                telefono or None,
                                email_contacto or None,
                                direccion_texto or None,
                                logo_tipo,
                                logo_texto_parte1 or None,
                                logo_texto_parte2 or None,
                                logo_url or None,
                                google_maps_url or None,
                                apple_maps_url or None,
                                empresa_id,
                            ],
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO negocio.empresa (
                                nombre_negocio,
                                telefono,
                                email_contacto,
                                direccion_texto,
                                logo_tipo,
                                logo_texto_parte1,
                                logo_texto_parte2,
                                logo_url,
                                google_maps_url,
                                apple_maps_url
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            RETURNING empresa_id
                            """,
                            [
                                nombre_negocio,
                                telefono or None,
                                email_contacto or None,
                                direccion_texto or None,
                                logo_tipo,
                                logo_texto_parte1 or None,
                                logo_texto_parte2 or None,
                                logo_url or None,
                                google_maps_url or None,
                                apple_maps_url or None,
                            ],
                        )
                        empresa_id = int(cursor.fetchone()[0])

                    for plataforma, raw_url in redes_payload.items():
                        url = str(raw_url or "").strip()
                        if url:
                            cursor.execute(
                                """
                                INSERT INTO negocio.red_social_negocio (empresa_id, plataforma, url, activa)
                                VALUES (%s, %s, %s, TRUE)
                                ON CONFLICT (empresa_id, plataforma)
                                DO UPDATE SET url = EXCLUDED.url, activa = TRUE
                                """,
                                [empresa_id, plataforma, url],
                            )
                        else:
                            cursor.execute(
                                """
                                UPDATE negocio.red_social_negocio
                                SET activa = FALSE
                                WHERE empresa_id = %s AND plataforma = %s
                                """,
                                [empresa_id, plataforma],
                            )

                    metodos_entrega_payload = [
                        ("tienda", "Recoger en tienda", costos_envio["recoger_local"]),
                        ("moto_mandado", "Moto mandado", costos_envio["moto_mandado"]),
                        ("paqueteria", "Paquetería", costos_envio["paqueteria"]),
                    ]
                    for codigo, nombre, costo_fijo in metodos_entrega_payload:
                        cursor.execute(
                            """
                            UPDATE negocio.metodo_entrega
                            SET nombre = %s, costo_fijo = %s
                            WHERE codigo = %s
                            """,
                            [nombre, costo_fijo, codigo],
                        )
                        if cursor.rowcount == 0:
                            cursor.execute(
                                """
                                INSERT INTO negocio.metodo_entrega (codigo, nombre, costo_fijo)
                                VALUES (%s, %s, %s)
                                """,
                                [codigo, nombre, costo_fijo],
                            )

                    metodos_pago_payload = [
                        ("efectivo", "Efectivo", pago_efectivo_activo),
                        ("tarjeta", "Tarjeta", pago_tarjeta_activo),
                        ("transferencia", "Transferencia bancaria", pago_transferencia_activo),
                    ]
                    for codigo, nombre, activo in metodos_pago_payload:
                        cursor.execute(
                            """
                            UPDATE negocio.metodo_pago_catalogo
                            SET nombre = %s, activo = %s
                            WHERE codigo = %s
                            """,
                            [nombre, activo, codigo],
                        )
                        if cursor.rowcount == 0:
                            cursor.execute(
                                """
                                INSERT INTO negocio.metodo_pago_catalogo (codigo, nombre, activo)
                                VALUES (%s, %s, %s)
                                """,
                                [codigo, nombre, activo],
                            )

                    cursor.execute(
                        """
                        SELECT url
                        FROM negocio.red_social_negocio
                        WHERE empresa_id = %s AND plataforma = 'otro'
                        ORDER BY red_social_id DESC
                        LIMIT 1
                        """,
                        [empresa_id],
                    )
                    row_extra = cursor.fetchone()
                    cfg_extra_actual = self._extraer_config_extra(row_extra[0] if row_extra else "")
                    clip_api_key_enc = str(cfg_extra_actual.get("clip_api_key_enc", "") or "").strip()
                    clip_api_secret_enc = str(cfg_extra_actual.get("clip_api_secret_enc", "") or "").strip()
                    clip_auth_token_enc = str(cfg_extra_actual.get("clip_auth_token_enc", "") or "").strip()
                    if clip_api_key and clip_api_secret:
                        clip_api_key_enc = _clip_encrypt(clip_api_key)
                        clip_api_secret_enc = _clip_encrypt(clip_api_secret)
                    if clip_auth_token:
                        clip_auth_token_enc = _clip_encrypt(clip_auth_token)

                    env_clip_key = str(getattr(settings, "CLIP_API_KEY", "") or "").strip()
                    env_clip_secret = str(getattr(settings, "CLIP_API_SECRET", "") or "").strip()
                    env_clip_auth_token = str(getattr(settings, "CLIP_AUTH_TOKEN", "") or "").strip()
                    hay_credenciales_admin = bool(_clip_decrypt(clip_api_key_enc) and _clip_decrypt(clip_api_secret_enc))
                    hay_token_admin = bool(_clip_decrypt(clip_auth_token_enc))
                    if (
                        clip_habilitado
                        and not hay_token_admin
                        and not hay_credenciales_admin
                        and not env_clip_auth_token
                        and not (env_clip_key and env_clip_secret)
                    ):
                        return Response(
                            {
                                "detail": (
                                    "Clip está habilitado, pero faltan credenciales. "
                                    "Configura Token de Autenticación o API Key/API Secret en Pagos, "
                                    "o define CLIP_AUTH_TOKEN / CLIP_API_KEY / CLIP_API_SECRET en backend."
                                )
                            },
                            status=400,
                        )

                    if (
                        paqueterias_disponibles
                        or clip_url
                        or clip_habilitado
                        or clip_api_key_enc
                        or clip_api_secret_enc
                        or clip_auth_token_enc
                    ):
                        payload_extra = json.dumps(
                            {
                                "_sys": "config_extra",
                                "paqueterias_disponibles": paqueterias_disponibles,
                                "clip": {
                                    "habilitado": clip_habilitado,
                                    "url": clip_url,
                                    "api_key_enc": clip_api_key_enc,
                                    "api_secret_enc": clip_api_secret_enc,
                                    "auth_token_enc": clip_auth_token_enc,
                                },
                            },
                            ensure_ascii=False,
                        )
                        cursor.execute(
                            """
                            INSERT INTO negocio.red_social_negocio (empresa_id, plataforma, url, activa)
                            VALUES (%s, 'otro', %s, TRUE)
                            ON CONFLICT (empresa_id, plataforma)
                            DO UPDATE SET url = EXCLUDED.url, activa = TRUE
                            """,
                            [empresa_id, payload_extra],
                        )
                    else:
                        cursor.execute(
                            """
                            UPDATE negocio.red_social_negocio
                            SET activa = FALSE
                            WHERE empresa_id = %s AND plataforma = 'otro'
                            """,
                            [empresa_id],
                            )

                    if isinstance(horarios_payload, list):
                        for item in horarios_payload:
                            if not isinstance(item, dict):
                                continue

                            dia_semana = item.get("dia_semana")
                            abierto = bool(item.get("abierto", False))
                            hora_apertura = item.get("hora_apertura")
                            hora_cierre = item.get("hora_cierre")

                            if not isinstance(dia_semana, int) or dia_semana < 0 or dia_semana > 6:
                                return Response({"detail": "dia_semana invalido en horarios."}, status=400)

                            if abierto and (not hora_apertura or not hora_cierre):
                                return Response(
                                    {
                                        "detail": (
                                            "Si un dia esta abierto, hora_apertura y hora_cierre son obligatorias."
                                        )
                                    },
                                    status=400,
                                )

                            cursor.execute(
                                """
                                INSERT INTO negocio.horario_negocio (
                                    empresa_id, dia_semana, abierto, hora_apertura, hora_cierre
                                )
                                VALUES (%s, %s, %s, %s, %s)
                                ON CONFLICT (empresa_id, dia_semana)
                                DO UPDATE SET
                                    abierto = EXCLUDED.abierto,
                                    hora_apertura = EXCLUDED.hora_apertura,
                                    hora_cierre = EXCLUDED.hora_cierre
                                """,
                                [
                                    empresa_id,
                                    dia_semana,
                                    abierto,
                                    hora_apertura if abierto else None,
                                    hora_cierre if abierto else None,
                                ],
                            )

                    if banco_nombre and banco_titular and banco_cuenta:
                        cursor.execute(
                            """
                            SELECT cuenta_bancaria_id
                            FROM negocio.cuenta_bancaria
                            WHERE empresa_id = %s AND activa = TRUE
                            ORDER BY cuenta_bancaria_id DESC
                            LIMIT 1
                            """,
                            [empresa_id],
                        )
                        cuenta_activa = cursor.fetchone()
                        if cuenta_activa:
                            cursor.execute(
                                """
                                UPDATE negocio.cuenta_bancaria
                                SET banco_nombre = %s, titular = %s, numero_cuenta = %s, clabe = %s, activa = TRUE
                                WHERE cuenta_bancaria_id = %s
                                """,
                                [banco_nombre, banco_titular, banco_cuenta, banco_cuenta, int(cuenta_activa[0])],
                            )
                        else:
                            cursor.execute(
                                """
                                INSERT INTO negocio.cuenta_bancaria (
                                    empresa_id, banco_nombre, titular, numero_cuenta, clabe, activa
                                )
                                VALUES (%s, %s, %s, %s, %s, TRUE)
                                """,
                                [empresa_id, banco_nombre, banco_titular, banco_cuenta, banco_cuenta],
                            )

                    cursor.execute(
                        """
                        SELECT politica_anticipo_id
                        FROM negocio.politica_anticipo
                        WHERE empresa_id = %s
                          AND vigente_hasta IS NULL
                        ORDER BY politica_anticipo_id DESC
                        LIMIT 1
                        """,
                        [empresa_id],
                    )
                    politica_vigente = cursor.fetchone()
                    if politica_vigente:
                        cursor.execute(
                            """
                            UPDATE negocio.politica_anticipo
                            SET
                                modo = 'con_penalizacion',
                                porcentaje_anticipo = %s,
                                citas_penalizacion = %s,
                                tiempo_espera_maximo_min = %s
                            WHERE politica_anticipo_id = %s
                            """,
                            [porcentaje_anticipo, citas_penalizacion, tiempo_espera_maximo, int(politica_vigente[0])],
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO negocio.politica_anticipo (
                                empresa_id, modo, porcentaje_anticipo, citas_penalizacion, tiempo_espera_maximo_min
                            )
                            VALUES (%s, 'con_penalizacion', %s, %s, %s)
                            """,
                            [empresa_id, porcentaje_anticipo, citas_penalizacion, tiempo_espera_maximo],
                        )

            return Response({"detail": "Configuracion guardada correctamente."})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminContenidoLegalView(APIView):
    permission_classes = [IsAuthenticated]

    TIPOS_BASE = {
        "mision": "Misión",
        "vision": "Visión",
        "valores": "Valores",
        "privacidad": "Política de privacidad",
        "terminos": "Términos y condiciones",
    }

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _serialize_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": int(row[0]),
            "tipo": row[1] or "",
            "tipo_display": row[2] or row[1] or "",
            "titulo": row[3] or "",
            "contenido": row[4] or "",
            "activo": bool(row[5]),
            "fecha_actualizacion": row[6],
        }

    def _ensure_tipos_base(self) -> None:
        with connection.cursor() as cursor:
            for codigo, nombre in self.TIPOS_BASE.items():
                cursor.execute(
                    """
                    INSERT INTO negocio.tipo_contenido_legal (codigo, nombre)
                    VALUES (%s, %s)
                    ON CONFLICT (codigo) DO NOTHING
                    """,
                    [codigo, nombre],
                )

    def _get_tipos_catalogo(self) -> dict[str, str]:
        tipos: dict[str, str] = {}
        with connection.cursor() as cursor:
            self._ensure_tipos_base()
            cursor.execute(
                """
                SELECT LOWER(codigo), COALESCE(nombre, codigo)
                FROM negocio.tipo_contenido_legal
                ORDER BY tipo_contenido_legal_id ASC
                """
            )
            for codigo, nombre in cursor.fetchall():
                key = str(codigo or "").strip().lower()
                if not key:
                    continue
                tipos[key] = str(nombre or key).strip() or key
        if not tipos:
            tipos = dict(self.TIPOS_BASE)
        return tipos

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        cl.contenido_legal_id,
                        LOWER(tcl.codigo) AS tipo_codigo,
                        COALESCE(tcl.nombre, tcl.codigo) AS tipo_nombre,
                        COALESCE(cl.titulo, tcl.nombre, tcl.codigo) AS titulo,
                        COALESCE(cl.cuerpo, '') AS contenido,
                        cl.activo,
                        cl.fecha_actualizacion
                    FROM negocio.contenido_legal cl
                    JOIN negocio.tipo_contenido_legal tcl
                      ON tcl.tipo_contenido_legal_id = cl.tipo_contenido_legal_id
                    ORDER BY cl.contenido_legal_id ASC
                    """
                )
                rows = cursor.fetchall()

            contenidos = [self._serialize_row(row) for row in rows]
            tipos_catalogo = self._get_tipos_catalogo()
            tipos_ocupados = {str(item["tipo"]).strip().lower() for item in contenidos}
            tipos_disponibles = {k: v for k, v in tipos_catalogo.items() if k not in tipos_ocupados}
            return Response(
                {
                    "ok": True,
                    "contenidos": contenidos,
                    "tipos_disponibles": tipos_disponibles,
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        tipo = str(data.get("tipo", "")).strip().lower()
        titulo = str(data.get("titulo", "")).strip()
        contenido = str(data.get("contenido", "") or "")
        activo = data.get("activo", True)
        activo_bool = bool(activo) if isinstance(activo, bool) else str(activo).strip().lower() in {"1", "true", "si", "sí", "yes"}

        if not tipo:
            return Response({"ok": False, "error": "El tipo de contenido es obligatorio."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    self._ensure_tipos_base()
                    cursor.execute(
                        """
                        SELECT tipo_contenido_legal_id, COALESCE(nombre, codigo)
                        FROM negocio.tipo_contenido_legal
                        WHERE LOWER(codigo) = %s
                        LIMIT 1
                        """,
                        [tipo],
                    )
                    tipo_row = cursor.fetchone()
                    if not tipo_row:
                        return Response({"ok": False, "error": "Tipo de contenido no válido."}, status=400)
                    tipo_id = int(tipo_row[0])
                    tipo_nombre = str(tipo_row[1] or tipo).strip() or tipo

                    cursor.execute(
                        """
                        SELECT 1
                        FROM negocio.contenido_legal
                        WHERE tipo_contenido_legal_id = %s
                        LIMIT 1
                        """,
                        [tipo_id],
                    )
                    if cursor.fetchone():
                        return Response(
                            {"ok": False, "error": "Ya existe contenido para este tipo. Edita el actual."},
                            status=409,
                        )

                    titulo_final = titulo or tipo_nombre
                    cursor.execute(
                        """
                        INSERT INTO negocio.contenido_legal (
                            tipo_contenido_legal_id, titulo, cuerpo, activo
                        )
                        VALUES (%s, %s, %s, %s)
                        RETURNING contenido_legal_id
                        """,
                        [tipo_id, titulo_final, contenido, activo_bool],
                    )
                    contenido_id = int(cursor.fetchone()[0])

            return Response({"ok": True, "id": contenido_id}, status=201)
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminContenidoLegalDetalleView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def put(self, request, contenido_id: int):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        titulo_nuevo: str | None = None
        contenido_nuevo: str | None = None
        activo_nuevo: bool | None = None

        if "titulo" in data:
            titulo = str(data.get("titulo", "")).strip()
            if not titulo:
                return Response({"ok": False, "error": "El título no puede estar vacío."}, status=400)
            titulo_nuevo = titulo

        if "contenido" in data:
            contenido_nuevo = str(data.get("contenido", "") or "")

        if "activo" in data:
            activo = data.get("activo")
            activo_bool = bool(activo) if isinstance(activo, bool) else str(activo).strip().lower() in {"1", "true", "si", "sí", "yes"}
            activo_nuevo = activo_bool

        if titulo_nuevo is None and contenido_nuevo is None and activo_nuevo is None:
            return Response({"ok": False, "error": "No hay campos para actualizar."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT titulo, cuerpo, activo
                        FROM negocio.contenido_legal
                        WHERE contenido_legal_id = %s
                        LIMIT 1
                        """,
                        [contenido_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Contenido no encontrado."}, status=404)

                    titulo_actual = str(row[0] or "")
                    cuerpo_actual = str(row[1] or "")
                    activo_actual = bool(row[2])

                    titulo_final = titulo_nuevo if titulo_nuevo is not None else titulo_actual
                    cuerpo_final = contenido_nuevo if contenido_nuevo is not None else cuerpo_actual
                    activo_final = activo_nuevo if activo_nuevo is not None else activo_actual

                    cursor.execute(
                        """
                        UPDATE negocio.contenido_legal
                        SET titulo = %s,
                            cuerpo = %s,
                            activo = %s,
                            fecha_actualizacion = NOW()
                        WHERE contenido_legal_id = %s
                        """,
                        [titulo_final, cuerpo_final, activo_final, contenido_id],
                    )
            return Response({"ok": True})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def delete(self, request, contenido_id: int):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT 1 FROM negocio.contenido_legal WHERE contenido_legal_id = %s LIMIT 1",
                        [contenido_id],
                    )
                    if not cursor.fetchone():
                        return Response({"ok": False, "error": "Contenido no encontrado."}, status=404)
                    cursor.execute(
                        "DELETE FROM negocio.contenido_legal WHERE contenido_legal_id = %s",
                        [contenido_id],
                    )
            return Response({"ok": True})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminPrediccionVentasView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _to_int(self, raw: Any) -> int | None:
        try:
            value = int(str(raw).strip())
            return value if value > 0 else None
        except Exception:
            return None

    def _to_date(self, raw: Any) -> date | None:
        value = str(raw or "").strip()
        if not value:
            return None
        try:
            return date.fromisoformat(value)
        except Exception:
            return None

    def _range_days_series(self, daily: dict[str, float], desde: date, hasta: date) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        current = desde
        while current <= hasta:
            key = current.isoformat()
            out.append({"label": key, "valor": round(float(daily.get(key, 0) or 0), 2)})
            current += timedelta(days=1)
        return out

    def _last_n_days_series(self, daily: dict[str, float], n: int) -> list[dict[str, Any]]:
        hoy = date.today()
        out: list[dict[str, Any]] = []
        for i in range(n - 1, -1, -1):
            d = hoy - timedelta(days=i)
            key = d.isoformat()
            out.append({"label": key, "valor": round(float(daily.get(key, 0) or 0), 2)})
        return out

    def _last_n_weeks_series(self, daily: dict[str, float], n: int) -> list[dict[str, Any]]:
        hoy = date.today()
        lunes_actual = hoy - timedelta(days=hoy.weekday())
        out: list[dict[str, Any]] = []
        for i in range(n - 1, -1, -1):
            inicio = lunes_actual - timedelta(days=7 * i)
            fin = inicio + timedelta(days=6)
            total = 0.0
            for j in range(7):
                d = inicio + timedelta(days=j)
                total += float(daily.get(d.isoformat(), 0) or 0)
            out.append({"label": f"{inicio.isoformat()} a {fin.isoformat()}", "valor": round(total, 2)})
        return out

    def _last_n_months_series(self, daily: dict[str, float], n: int) -> list[dict[str, Any]]:
        hoy = date.today()
        y = hoy.year
        m = hoy.month
        meses: list[tuple[int, int]] = []
        for _ in range(n):
            meses.append((y, m))
            m -= 1
            if m <= 0:
                m = 12
                y -= 1
        meses.reverse()
        out: list[dict[str, Any]] = []
        for yy, mm in meses:
            inicio = date(yy, mm, 1)
            if mm == 12:
                siguiente = date(yy + 1, 1, 1)
            else:
                siguiente = date(yy, mm + 1, 1)
            total = 0.0
            d = inicio
            while d < siguiente:
                total += float(daily.get(d.isoformat(), 0) or 0)
                d += timedelta(days=1)
            out.append({"label": f"{yy}-{str(mm).zfill(2)}", "valor": round(total, 2)})
        return out

    def _proyeccion_lineal(self, values: list[float], horizon: int = 3) -> tuple[list[float], float]:
        n = len(values)
        if n <= 0:
            return [0.0 for _ in range(horizon)], 0.0
        if n == 1:
            return [max(0.0, float(values[0])) for _ in range(horizon)], 0.0
        x = [i + 1 for i in range(n)]
        y = [float(v or 0) for v in values]
        sx = sum(x)
        sy = sum(y)
        sxy = sum(a * b for a, b in zip(x, y))
        sx2 = sum(a * a for a in x)
        den = (n * sx2) - (sx * sx)
        pendiente = ((n * sxy) - (sx * sy)) / den if den != 0 else 0.0
        intercepto = (sy - (pendiente * sx)) / n
        preds: list[float] = []
        for h in range(1, horizon + 1):
            xv = n + h
            preds.append(round(max(0.0, (pendiente * xv) + intercepto), 2))
        return preds, pendiente

    def _proyeccion_exponencial(self, values: list[float], horizon: int = 3) -> tuple[list[float], float]:
        n = len(values)
        if n <= 1:
            base = float(values[0] if values else 0)
            return [round(max(0.0, base), 2) for _ in range(horizon)], 0.0
        y0 = max(float(values[0] or 0), 0.0001)
        yn = max(float(values[-1] or 0), 0.0001)
        k = math.log(yn / y0) / (n - 1)
        preds: list[float] = []
        for h in range(1, horizon + 1):
            pred = yn * math.exp(k * h)
            preds.append(round(max(0.0, pred), 2))
        return preds, k

    def _backtesting_lineal(self, values: list[float], min_train: int = 3) -> dict[str, Any]:
        """
        Backtesting walk-forward de 1 paso con modelo lineal.
        Calcula MAE, MAPE y una "precision" simple = 100 - MAPE.
        """
        serie = [float(v or 0) for v in values]
        n = len(serie)
        if n <= min_train:
            return {
                "muestras": 0,
                "mae": None,
                "mape": None,
                "precision_porcentaje": None,
            }

        abs_errors: list[float] = []
        abs_pct_errors: list[float] = []
        for i in range(min_train, n):
            train = serie[:i]
            pred, _ = self._proyeccion_lineal(train, 1)
            yhat = float(pred[0] if pred else 0.0)
            y = float(serie[i])
            abs_errors.append(abs(y - yhat))
            if y > 0:
                abs_pct_errors.append(abs((y - yhat) / y) * 100.0)

        mae = round(sum(abs_errors) / len(abs_errors), 2) if abs_errors else None
        mape = round(sum(abs_pct_errors) / len(abs_pct_errors), 2) if abs_pct_errors else None
        precision = round(max(0.0, 100.0 - float(mape)), 2) if mape is not None else None
        return {
            "muestras": len(abs_errors),
            "mae": mae,
            "mape": mape,
            "precision_porcentaje": precision,
        }

    def _fetch_daily_producto(self, cursor, producto_id: int, desde: date, hasta: date) -> dict[str, float]:
        cursor.execute(
            """
            SELECT TO_CHAR(fecha_dia, 'YYYY-MM-DD') AS fecha, COALESCE(SUM(unidades), 0) AS unidades
            FROM (
                SELECT
                    DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) AS fecha_dia,
                    COALESCE(pi.cantidad, 0)::numeric AS unidades
                FROM negocio.pedido_item pi
                JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                WHERE pi.producto_id = %s
                  AND DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                  AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                  AND (
                        LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                        OR (
                            LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                            AND (
                                (
                                    LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                    AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                )
                                OR (
                                    LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                    AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                )
                            )
                        )
                    )
                UNION ALL
                SELECT
                    DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) AS fecha_dia,
                    COALESCE(vmi.cantidad, 0)::numeric AS unidades
                FROM negocio.venta_mostrador_item vmi
                JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                WHERE vmi.producto_id = %s
                  AND DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(vm.cancelada, FALSE) = FALSE
            ) q
            GROUP BY fecha_dia
            ORDER BY fecha_dia ASC
            """,
            [producto_id, desde, hasta, producto_id, desde, hasta],
        )
        return {str(r[0]): float(r[1] or 0) for r in cursor.fetchall()}

    def _fetch_kpis_producto(self, cursor, producto_id: int, desde: date, hasta: date) -> dict[str, Any]:
        cursor.execute(
            """
            SELECT
                COALESCE(SUM(unidades), 0) AS unidades_vendidas,
                COALESCE(SUM(tickets), 0) AS tickets_entregados
            FROM (
                SELECT
                    COALESCE(SUM(pi.cantidad), 0)::numeric AS unidades,
                    COUNT(DISTINCT p.pedido_id)::numeric AS tickets
                FROM negocio.pedido_item pi
                JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                WHERE pi.producto_id = %s
                  AND DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                  AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                  AND (
                        LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                        OR (
                            LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                            AND (
                                (
                                    LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                    AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                )
                                OR (
                                    LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                    AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                )
                            )
                        )
                    )
                UNION ALL
                SELECT
                    COALESCE(SUM(vmi.cantidad), 0)::numeric AS unidades,
                    COUNT(DISTINCT vm.venta_mostrador_id)::numeric AS tickets
                FROM negocio.venta_mostrador_item vmi
                JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                WHERE vmi.producto_id = %s
                  AND DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(vm.cancelada, FALSE) = FALSE
            ) t
            """,
            [producto_id, desde, hasta, producto_id, desde, hasta],
        )
        row = cursor.fetchone() or (0, 0)
        unidades = float(row[0] or 0)
        tickets = int(float(row[1] or 0))
        dias = max(1, (hasta - desde).days + 1)
        return {
            "unidades_vendidas": round(unidades, 2),
            "tickets_entregados": tickets,
            "promedio_diario": round(unidades / dias, 2),
        }

    def _fetch_daily_subcategoria(self, cursor, categoria_codigo: str, marca_id: int, desde: date, hasta: date) -> dict[str, float]:
        cursor.execute(
            """
            SELECT TO_CHAR(fecha_dia, 'YYYY-MM-DD') AS fecha, COALESCE(SUM(unidades), 0) AS unidades
            FROM (
                SELECT
                    DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) AS fecha_dia,
                    COALESCE(pi.cantidad, 0)::numeric AS unidades
                FROM negocio.pedido_item pi
                JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                JOIN negocio.producto pr ON pr.producto_id = pi.producto_id
                JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = pr.categoria_producto_id
                JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                WHERE LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                  AND pr.marca_id = %s
                  AND DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                  AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                  AND (
                        LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                        OR (
                            LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                            AND (
                                (
                                    LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                    AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                )
                                OR (
                                    LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                    AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                )
                            )
                        )
                    )
                UNION ALL
                SELECT
                    DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) AS fecha_dia,
                    COALESCE(vmi.cantidad, 0)::numeric AS unidades
                FROM negocio.venta_mostrador_item vmi
                JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                JOIN negocio.producto pr ON pr.producto_id = vmi.producto_id
                JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = pr.categoria_producto_id
                WHERE LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                  AND pr.marca_id = %s
                  AND DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                  AND COALESCE(vm.cancelada, FALSE) = FALSE
            ) q
            GROUP BY fecha_dia
            ORDER BY fecha_dia ASC
            """,
            [categoria_codigo, marca_id, desde, hasta, categoria_codigo, marca_id, desde, hasta],
        )
        return {str(r[0]): float(r[1] or 0) for r in cursor.fetchall()}

    def _mock_payload(self) -> dict[str, Any]:
        serie_dia = [
            {"label": "2026-02-23", "valor": 6},
            {"label": "2026-02-24", "valor": 7},
            {"label": "2026-02-25", "valor": 8},
            {"label": "2026-02-26", "valor": 9},
            {"label": "2026-02-27", "valor": 8},
            {"label": "2026-02-28", "valor": 10},
            {"label": "2026-03-01", "valor": 11},
            {"label": "2026-03-02", "valor": 12},
        ]
        serie_semana = [
            {"label": "2026-01-06 a 2026-01-12", "valor": 38},
            {"label": "2026-01-13 a 2026-01-19", "valor": 41},
            {"label": "2026-01-20 a 2026-01-26", "valor": 45},
            {"label": "2026-01-27 a 2026-02-02", "valor": 47},
            {"label": "2026-02-03 a 2026-02-09", "valor": 50},
            {"label": "2026-02-10 a 2026-02-16", "valor": 54},
        ]
        serie_mes = [
            {"label": "2025-03", "valor": 24},
            {"label": "2025-04", "valor": 27},
            {"label": "2025-05", "valor": 30},
            {"label": "2025-06", "valor": 33},
            {"label": "2025-07", "valor": 36},
            {"label": "2025-08", "valor": 39},
            {"label": "2025-09", "valor": 42},
            {"label": "2025-10", "valor": 45},
            {"label": "2025-11", "valor": 48},
            {"label": "2025-12", "valor": 52},
            {"label": "2026-01", "valor": 56},
            {"label": "2026-02", "valor": 61},
        ]
        valores = [float(x["valor"]) for x in serie_mes[-6:]]
        pred_lineal, pendiente = self._proyeccion_lineal(valores, 3)
        pred_exp, k = self._proyeccion_exponencial(valores, 3)
        backtesting = self._backtesting_lineal(valores, 3)
        sub_vals = [88, 94, 101, 108, 115, 122, 142, 151, 159, 166, 174, 182]
        sub_backtesting = self._backtesting_lineal(sub_vals[-6:], 3)
        return {
            "ok": True,
            "modo": "prueba",
            "fuente": "ficticia",
            "meta": {
                "subcategoria_alias": "marca",
                "explicacion": "En este demo de barberia, 'subcategoria' se representa con marca de producto.",
            },
            "filtros": {
                "categorias": [
                    {"codigo": "cabello", "nombre": "Cabello"},
                    {"codigo": "barba", "nombre": "Barba"},
                ],
                "subcategorias": [
                    {"id": 201, "nombre": "Uppercut Deluxe"},
                    {"id": 202, "nombre": "Reuzel"},
                ],
                "productos": [
                    {"id": 991001, "nombre": "Pomada Matte Clay 100g"},
                    {"id": 991002, "nombre": "Cera Shine Cream 90g"},
                    {"id": 991003, "nombre": "Spray texturizante 150ml"},
                ],
            },
            "seleccion": {
                "categoria": "cabello",
                "subcategoria_id": 201,
                "producto_id": 991001,
                "producto_nombre": "Pomada Matte Clay 100g",
            },
            "ventas": {
                "dia": serie_dia,
                "semana": serie_semana,
                "mes": serie_mes,
            },
            "prediccion": {
                "modelo_recomendado": "lineal",
                "lineal": pred_lineal,
                "exponencial": pred_exp,
                "pendiente_lineal": round(pendiente, 4),
                "k_exponencial": round(k, 4),
                "venta_proyectada_mes_siguiente": pred_lineal[0] if pred_lineal else 0,
                "tendencia": "positiva" if pendiente > 0.15 else ("negativa" if pendiente < -0.15 else "estable"),
                "punto_reorden_sugerido": int(max(8, math.ceil((pred_lineal[0] if pred_lineal else 0) * 0.5))),
                "backtesting": backtesting,
            },
            "subcategoria": {
                "prediccion_mes_siguiente": 172,
                "tendencia": "positiva",
                "producto_mas_vendido": {"producto_id": 991001, "nombre": "Pomada Matte Clay 100g", "unidades": 61},
                "participacion_productos": [
                    {"producto_id": 991001, "nombre": "Pomada Matte Clay 100g", "unidades": 61, "porcentaje": 43.57},
                    {"producto_id": 991002, "nombre": "Cera Shine Cream 90g", "unidades": 44, "porcentaje": 31.43},
                    {"producto_id": 991003, "nombre": "Spray texturizante 150ml", "unidades": 35, "porcentaje": 25.00},
                ],
            },
            "subcategoria_ventas": {
                "dia": [
                    {"label": "2026-02-23", "valor": 18},
                    {"label": "2026-02-24", "valor": 19},
                    {"label": "2026-02-25", "valor": 21},
                    {"label": "2026-02-26", "valor": 20},
                    {"label": "2026-02-27", "valor": 22},
                    {"label": "2026-02-28", "valor": 24},
                    {"label": "2026-03-01", "valor": 25},
                    {"label": "2026-03-02", "valor": 27},
                ],
                "semana": [
                    {"label": "2026-01-06 a 2026-01-12", "valor": 102},
                    {"label": "2026-01-13 a 2026-01-19", "valor": 108},
                    {"label": "2026-01-20 a 2026-01-26", "valor": 114},
                    {"label": "2026-01-27 a 2026-02-02", "valor": 118},
                    {"label": "2026-02-03 a 2026-02-09", "valor": 123},
                    {"label": "2026-02-10 a 2026-02-16", "valor": 129},
                ],
                "mes": [
                    {"label": "2025-03", "valor": 88},
                    {"label": "2025-04", "valor": 94},
                    {"label": "2025-05", "valor": 101},
                    {"label": "2025-06", "valor": 108},
                    {"label": "2025-07", "valor": 115},
                    {"label": "2025-08", "valor": 122},
                    {"label": "2025-09", "valor": 142},
                    {"label": "2025-10", "valor": 151},
                    {"label": "2025-11", "valor": 159},
                    {"label": "2025-12", "valor": 166},
                    {"label": "2026-01", "valor": 174},
                    {"label": "2026-02", "valor": 182},
                ],
            },
            "subcategoria_prediccion": {
                "lineal": [188, 195, 202],
                "exponencial": [189, 197, 206],
                "pendiente_lineal": 7.9429,
                "k_exponencial": 0.0469,
                "tendencia": "positiva",
                "venta_proyectada_mes_siguiente": 188,
                "backtesting": sub_backtesting,
            },
            "productos_listado": [
                {"producto_id": 991001, "producto_nombre": "Pomada Matte Clay 100g", "stock_disponible": 18, "ventas_totales": 61},
                {"producto_id": 991002, "producto_nombre": "Cera Shine Cream 90g", "stock_disponible": 12, "ventas_totales": 44},
                {"producto_id": 991003, "producto_nombre": "Spray texturizante 150ml", "stock_disponible": 9, "ventas_totales": 35},
            ],
            "justificacion_matematica": {
                "lineal": "y = m*x + b para tendencia general.",
                "exponencial": "N(t) = N0 * e^(k*t) para crecimiento/decrecimiento.",
            },
        }

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        modo = str(request.GET.get("modo", "") or "").strip().lower()
        if modo == "prueba":
            return Response(self._mock_payload())

        categoria_q = str(request.GET.get("categoria", "") or "").strip().lower()
        subcategoria_id_q = self._to_int(request.GET.get("subcategoria_id"))
        producto_id_q = self._to_int(request.GET.get("producto_id"))
        desde_q = self._to_date(request.GET.get("desde"))
        hasta_q = self._to_date(request.GET.get("hasta"))
        pred_scope = str(request.GET.get("pred_scope", "dia") or "dia").strip().lower()
        if pred_scope not in ("dia", "mes"):
            pred_scope = "dia"

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT cp.codigo, cp.nombre
                    FROM negocio.categoria_producto cp
                    JOIN negocio.producto p ON p.categoria_producto_id = cp.categoria_producto_id
                    WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                    GROUP BY cp.categoria_producto_id, cp.codigo, cp.nombre
                    ORDER BY cp.nombre ASC
                    """
                )
                categorias_rows = cursor.fetchall()
                categorias = [{"codigo": str(r[0] or ""), "nombre": str(r[1] or r[0] or "")} for r in categorias_rows]

                categoria_sel = categoria_q
                if not categoria_sel or categoria_sel not in {c["codigo"] for c in categorias}:
                    categoria_sel = str(categorias[0]["codigo"]) if categorias else ""

                cursor.execute(
                    """
                    SELECT m.marca_id, m.nombre
                    FROM negocio.marca m
                    JOIN negocio.producto p ON p.marca_id = m.marca_id
                    JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = p.categoria_producto_id
                    WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                      AND LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                    GROUP BY m.marca_id, m.nombre
                    ORDER BY m.nombre ASC
                    """,
                    [categoria_sel],
                )
                sub_rows = cursor.fetchall()
                subcategorias = [{"id": int(r[0]), "nombre": str(r[1] or "")} for r in sub_rows]

                sub_sel = subcategoria_id_q
                if sub_sel is None or sub_sel not in {s["id"] for s in subcategorias}:
                    sub_sel = int(subcategorias[0]["id"]) if subcategorias else None

                if sub_sel is not None:
                    cursor.execute(
                        """
                        SELECT p.producto_id, p.nombre
                        FROM negocio.producto p
                        JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = p.categoria_producto_id
                        WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                          AND LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                          AND p.marca_id = %s
                        ORDER BY p.nombre ASC
                        """,
                        [categoria_sel, sub_sel],
                    )
                else:
                    cursor.execute(
                        """
                        SELECT p.producto_id, p.nombre
                        FROM negocio.producto p
                        JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = p.categoria_producto_id
                        WHERE LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                          AND LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                        ORDER BY p.nombre ASC
                        """,
                        [categoria_sel],
                    )
                prod_rows = cursor.fetchall()
                productos = [{"id": int(r[0]), "nombre": str(r[1] or "")} for r in prod_rows]

                prod_sel = producto_id_q
                if prod_sel is None or prod_sel not in {p["id"] for p in productos}:
                    prod_sel = int(productos[0]["id"]) if productos else None

                if not prod_sel:
                    return Response(
                        {
                            "ok": True,
                            "modo": "real",
                            "fuente": "base_de_datos",
                            "meta": {
                                "subcategoria_alias": "marca",
                                "explicacion": "En este modulo, 'subcategoria' se representa con marca de producto.",
                            },
                            "filtros": {"categorias": categorias, "subcategorias": subcategorias, "productos": productos},
                            "seleccion": {"categoria": categoria_sel, "subcategoria_id": sub_sel, "producto_id": None, "producto_nombre": ""},
                            "ventas": {"dia": [], "semana": [], "mes": []},
                            "ventas_rango": {
                                "desde": desde_q.isoformat() if desde_q else None,
                                "hasta": hasta_q.isoformat() if hasta_q else None,
                                "dia": [],
                            },
                            "kpis_ventas": {
                                "scope": "producto",
                                "desde": (desde_q or date.today()).isoformat(),
                                "hasta": (hasta_q or date.today()).isoformat(),
                                "unidades_vendidas": 0,
                                "tickets_entregados": 0,
                                "promedio_diario": 0,
                            },
                            "prediccion": {
                                "modelo_recomendado": "lineal",
                                "lineal": [0, 0, 0],
                                "exponencial": [0, 0, 0],
                                "pendiente_lineal": 0,
                                "k_exponencial": 0,
                                "venta_proyectada_mes_siguiente": 0,
                                "tendencia": "estable",
                                "punto_reorden_sugerido": 0,
                                "backtesting": {
                                    "muestras": 0,
                                    "mae": None,
                                    "mape": None,
                                    "precision_porcentaje": None,
                                },
                            },
                            "subcategoria": {
                                "prediccion_mes_siguiente": 0,
                                "tendencia": "estable",
                                "producto_mas_vendido": {"producto_id": None, "nombre": "", "unidades": 0},
                                "participacion_productos": [],
                            },
                            "subcategoria_ventas": {"dia": [], "semana": [], "mes": []},
                            "subcategoria_prediccion": {
                                "lineal": [0, 0, 0],
                                "exponencial": [0, 0, 0],
                                "pendiente_lineal": 0,
                                "k_exponencial": 0,
                                "tendencia": "estable",
                                "venta_proyectada_mes_siguiente": 0,
                                "backtesting": {
                                    "muestras": 0,
                                    "mae": None,
                                    "mape": None,
                                    "precision_porcentaje": None,
                                },
                            },
                            "justificacion_matematica": {
                                "lineal": "y = m*x + b para tendencia general.",
                                "exponencial": "N(t) = N0 * e^(k*t) para crecimiento/decrecimiento.",
                            },
                            "prediccion_crecimiento": {
                                "scope": pred_scope,
                                "ley": "N(t)=N0*e^(k*t)",
                                "k": 0,
                                "base": {"tipo": "unidades_diarias", "valores": []},
                                "predicciones": [],
                                "venta_proyectada_siguientes_6_dias": 0,
                                "venta_proyectada_mes_siguiente": 0,
                            },
                        }
                    )

                cursor.execute(
                    """
                    SELECT p.nombre, COALESCE(ie.stock_actual, 0), COALESCE(p.stock_minimo_alerta, 0)
                    FROM negocio.producto p
                    LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                    WHERE p.producto_id = %s
                    LIMIT 1
                    """,
                    [prod_sel],
                )
                producto_row = cursor.fetchone() or ("", 0, 0)
                producto_nombre = str(producto_row[0] or "")
                stock_actual = float(producto_row[1] or 0)
                stock_minimo = float(producto_row[2] or 0)

                hoy = date.today()
                desde_hist = hoy - timedelta(days=450)
                daily_prod = self._fetch_daily_producto(cursor, prod_sel, desde_hist, hoy)
                serie_dia = self._last_n_days_series(daily_prod, 30)
                serie_semana = self._last_n_weeks_series(daily_prod, 12)
                serie_mes = self._last_n_months_series(daily_prod, 12)

                # Rango explícito enviado por filtros de fecha en frontend
                if desde_q and hasta_q:
                    desde_rango, hasta_rango = desde_q, hasta_q
                elif desde_q and not hasta_q:
                    desde_rango, hasta_rango = desde_q, desde_q
                elif not desde_q and hasta_q:
                    desde_rango, hasta_rango = hasta_q, hasta_q
                else:
                    desde_rango, hasta_rango = (hoy - timedelta(days=29)), hoy
                if hasta_rango < desde_rango:
                    hasta_rango = desde_rango

                ventas_rango_dia = self._range_days_series(daily_prod, desde_rango, hasta_rango)
                kpis_rango = self._fetch_kpis_producto(cursor, prod_sel, desde_rango, hasta_rango)

                vals_mes = [float(x.get("valor", 0) or 0) for x in serie_mes[-6:]]
                pred_lineal, pendiente = self._proyeccion_lineal(vals_mes, 3)
                pred_exp, k_exp = self._proyeccion_exponencial(vals_mes, 3)
                backtesting_prod = self._backtesting_lineal(vals_mes, 3)
                tendencia = "positiva" if pendiente > 0.15 else ("negativa" if pendiente < -0.15 else "estable")
                proy_sig = float(pred_lineal[0] if pred_lineal else 0)
                punto_reorden = int(max(stock_minimo, math.ceil(proy_sig * 0.5)))

                base_dia = [float(x.get("valor", 0) or 0) for x in ventas_rango_dia if float(x.get("valor", 0) or 0) > 0]
                if len(base_dia) < 2:
                    base_dia = [float(x.get("valor", 0) or 0) for x in serie_dia if float(x.get("valor", 0) or 0) > 0]
                base_mes = [float(x.get("valor", 0) or 0) for x in serie_mes[-6:]]
                if pred_scope == "mes":
                    growth_base = base_mes if len(base_mes) >= 2 else [0.0, 0.0]
                    growth_preds, growth_k = self._proyeccion_exponencial(growth_base, 1)
                    prediccion_crecimiento = {
                        "scope": "mes",
                        "ley": "N(t)=N0*e^(k*t)",
                        "k": round(float(growth_k or 0), 6),
                        "base": {"tipo": "totales_mensuales", "valores": [round(float(v or 0), 2) for v in growth_base]},
                        "predicciones": [round(float(v or 0), 2) for v in growth_preds],
                        "venta_proyectada_mes_siguiente": round(float(growth_preds[0] if growth_preds else 0), 2),
                    }
                else:
                    growth_base = base_dia if len(base_dia) >= 2 else [0.0, 0.0]
                    growth_preds, growth_k = self._proyeccion_exponencial(growth_base, 6)
                    prediccion_crecimiento = {
                        "scope": "dia",
                        "ley": "N(t)=N0*e^(k*t)",
                        "k": round(float(growth_k or 0), 6),
                        "base": {"tipo": "unidades_diarias", "valores": [round(float(v or 0), 2) for v in growth_base]},
                        "predicciones": [round(float(v or 0), 2) for v in growth_preds],
                        "venta_proyectada_siguientes_6_dias": round(sum(float(v or 0) for v in growth_preds), 2),
                    }

                sub_pred = 0.0
                sub_tendencia = "estable"
                participacion: list[dict[str, Any]] = []
                top_producto = {"producto_id": None, "nombre": "", "unidades": 0}
                productos_listado: list[dict[str, Any]] = []
                sub_serie_dia: list[dict[str, Any]] = []
                sub_serie_semana: list[dict[str, Any]] = []
                sub_serie_mes: list[dict[str, Any]] = []
                sub_pred_lineal: list[float] = [0.0, 0.0, 0.0]
                sub_pred_exp: list[float] = [0.0, 0.0, 0.0]
                sub_pendiente = 0.0
                sub_k_exp = 0.0

                if sub_sel is not None:
                    desde_listado = hoy - timedelta(days=120)
                    cursor.execute(
                        """
                        SELECT
                            p.producto_id,
                            COALESCE(p.nombre, 'Producto') AS producto_nombre,
                            COALESCE(ie.stock_actual, 0) AS stock_disponible,
                            COALESCE(vt.total_unidades, 0) AS ventas_totales
                        FROM negocio.producto p
                        JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = p.categoria_producto_id
                        LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                        LEFT JOIN (
                            SELECT x.producto_id, COALESCE(SUM(x.unidades), 0) AS total_unidades
                            FROM (
                                SELECT
                                    pi.producto_id AS producto_id,
                                    COALESCE(pi.cantidad, 0)::numeric AS unidades
                                FROM negocio.pedido_item pi
                                JOIN negocio.pedido pd ON pd.pedido_id = pi.pedido_id
                                JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = pd.estado_pedido_id
                                LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = pd.metodo_entrega_id
                                LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = pd.metodo_pago_id
                                WHERE DATE((COALESCE(pd.fecha_actualizacion, pd.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                                  AND COALESCE(pd.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                                  AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                                  AND (
                                        LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                                        OR (
                                            LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                            AND (
                                                (
                                                    LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                                    AND COALESCE(pd.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                                )
                                                OR (
                                                    LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                                    AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                                )
                                            )
                                        )
                                    )
                                UNION ALL
                                SELECT
                                    vmi.producto_id AS producto_id,
                                    COALESCE(vmi.cantidad, 0)::numeric AS unidades
                                FROM negocio.venta_mostrador_item vmi
                                JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                                WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                                  AND COALESCE(vm.cancelada, FALSE) = FALSE
                            ) x
                            GROUP BY x.producto_id
                        ) vt ON vt.producto_id = p.producto_id
                        WHERE LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                          AND p.marca_id = %s
                          AND LOWER(COALESCE(p.estado, 'activo')) = 'activo'
                        ORDER BY ventas_totales DESC, producto_nombre ASC
                        """,
                        [desde_listado, hoy, desde_listado, hoy, categoria_sel, sub_sel],
                    )
                    list_rows = cursor.fetchall()
                    productos_listado = [
                        {
                            "producto_id": int(r[0]),
                            "producto_nombre": str(r[1] or "Producto"),
                            "stock_disponible": float(r[2] or 0),
                            "ventas_totales": float(r[3] or 0),
                        }
                        for r in list_rows
                    ]

                    daily_sub = self._fetch_daily_subcategoria(cursor, categoria_sel, sub_sel, desde_hist, hoy)
                    sub_serie_dia = self._last_n_days_series(daily_sub, 30)
                    sub_serie_semana = self._last_n_weeks_series(daily_sub, 12)
                    sub_serie_mes = self._last_n_months_series(daily_sub, 12)
                    vals_sub = [float(x.get("valor", 0) or 0) for x in sub_serie_mes[-6:]]
                    sub_pred_lineal, sub_pendiente = self._proyeccion_lineal(vals_sub, 3)
                    sub_pred_exp, sub_k_exp = self._proyeccion_exponencial(vals_sub, 3)
                    sub_backtesting = self._backtesting_lineal(vals_sub, 3)
                    sub_pred = float(sub_pred_lineal[0] if sub_pred_lineal else 0)
                    sub_tendencia = "positiva" if sub_pendiente > 0.15 else ("negativa" if sub_pendiente < -0.15 else "estable")

                    desde_part = hoy - timedelta(days=90)
                    cursor.execute(
                        """
                        SELECT producto_id, producto_nombre, COALESCE(SUM(unidades), 0) AS unidades
                        FROM (
                            SELECT
                                pr.producto_id AS producto_id,
                                COALESCE(pr.nombre, 'Producto') AS producto_nombre,
                                COALESCE(pi.cantidad, 0)::numeric AS unidades
                            FROM negocio.pedido_item pi
                            JOIN negocio.pedido p ON p.pedido_id = pi.pedido_id
                            JOIN negocio.producto pr ON pr.producto_id = pi.producto_id
                            JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = pr.categoria_producto_id
                            JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                            LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                            LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                            WHERE LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                              AND pr.marca_id = %s
                              AND DATE((COALESCE(p.fecha_actualizacion, p.fecha_creacion) AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                              AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                              AND LOWER(COALESCE(ep.codigo, '')) <> 'cancelado'
                              AND (
                                    LOWER(COALESCE(ep.codigo, '')) = 'entregado'
                                    OR (
                                        LOWER(COALESCE(me.codigo, '')) = 'paqueteria'
                                        AND (
                                            (
                                                LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                                                AND COALESCE(p.notas, '') ILIKE '%%[CLIP_PAGO_DIRECTO_OK]%%'
                                            )
                                            OR (
                                                LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                                                AND LOWER(COALESCE(ep.codigo, '')) IN ('aceptado', 'confirmado', 'pago_validado', 'en_camino', 'enviado', 'preparando', 'entregado')
                                            )
                                        )
                                    )
                                )
                            UNION ALL
                            SELECT
                                pr.producto_id AS producto_id,
                                COALESCE(pr.nombre, 'Producto') AS producto_nombre,
                                COALESCE(vmi.cantidad, 0)::numeric AS unidades
                            FROM negocio.venta_mostrador_item vmi
                            JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                            JOIN negocio.producto pr ON pr.producto_id = vmi.producto_id
                            JOIN negocio.categoria_producto cp ON cp.categoria_producto_id = pr.categoria_producto_id
                            WHERE LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)
                              AND pr.marca_id = %s
                              AND DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) BETWEEN %s AND %s
                              AND COALESCE(vm.cancelada, FALSE) = FALSE
                        ) q
                        GROUP BY producto_id, producto_nombre
                        ORDER BY unidades DESC, producto_nombre ASC
                        """,
                        [categoria_sel, sub_sel, desde_part, hoy, categoria_sel, sub_sel, desde_part, hoy],
                    )
                    part_rows = cursor.fetchall()
                    total_units = float(sum(float(r[2] or 0) for r in part_rows) or 0)
                    participacion = [
                        {
                            "producto_id": int(r[0]),
                            "nombre": str(r[1] or "Producto"),
                            "unidades": float(r[2] or 0),
                            "porcentaje": round((float(r[2] or 0) / total_units) * 100, 2) if total_units > 0 else 0.0,
                        }
                        for r in part_rows
                    ]
                    if participacion:
                        top_producto = {
                            "producto_id": participacion[0]["producto_id"],
                            "nombre": participacion[0]["nombre"],
                            "unidades": participacion[0]["unidades"],
                        }

                return Response(
                    {
                        "ok": True,
                        "modo": "real",
                        "fuente": "base_de_datos",
                        "meta": {
                            "subcategoria_alias": "marca",
                            "explicacion": "En este modulo, 'subcategoria' se representa con marca de producto.",
                        },
                        "filtros": {
                            "categorias": categorias,
                            "subcategorias": subcategorias,
                            "productos": productos,
                        },
                        "seleccion": {
                            "categoria": categoria_sel,
                            "subcategoria_id": sub_sel,
                            "producto_id": prod_sel,
                            "producto_nombre": producto_nombre,
                        },
                        "ventas": {
                            "dia": serie_dia,
                            "semana": serie_semana,
                            "mes": serie_mes,
                        },
                        "ventas_rango": {
                            "desde": desde_rango.isoformat(),
                            "hasta": hasta_rango.isoformat(),
                            "dia": ventas_rango_dia,
                        },
                        "kpis_ventas": {
                            "scope": "producto",
                            "desde": desde_rango.isoformat(),
                            "hasta": hasta_rango.isoformat(),
                            "unidades_vendidas": kpis_rango["unidades_vendidas"],
                            "tickets_entregados": kpis_rango["tickets_entregados"],
                            "promedio_diario": kpis_rango["promedio_diario"],
                        },
                        "prediccion": {
                            "modelo_recomendado": "lineal",
                            "lineal": pred_lineal,
                            "exponencial": pred_exp,
                            "pendiente_lineal": round(pendiente, 4),
                            "k_exponencial": round(k_exp, 4),
                            "venta_proyectada_mes_siguiente": round(proy_sig, 2),
                            "tendencia": tendencia,
                            "punto_reorden_sugerido": punto_reorden,
                            "stock_actual": round(stock_actual, 2),
                            "stock_minimo": round(stock_minimo, 2),
                            "backtesting": backtesting_prod,
                        },
                        "subcategoria": {
                            "prediccion_mes_siguiente": round(sub_pred, 2),
                            "tendencia": sub_tendencia,
                            "producto_mas_vendido": top_producto,
                            "participacion_productos": participacion,
                        },
                        "subcategoria_ventas": {
                            "dia": sub_serie_dia,
                            "semana": sub_serie_semana,
                            "mes": sub_serie_mes,
                        },
                        "subcategoria_prediccion": {
                            "lineal": sub_pred_lineal,
                            "exponencial": sub_pred_exp,
                            "pendiente_lineal": round(sub_pendiente, 4),
                            "k_exponencial": round(sub_k_exp, 4),
                            "tendencia": sub_tendencia,
                            "venta_proyectada_mes_siguiente": round(sub_pred, 2),
                            "backtesting": sub_backtesting if sub_sel is not None else {
                                "muestras": 0,
                                "mae": None,
                                "mape": None,
                                "precision_porcentaje": None,
                            },
                        },
                        "productos_listado": productos_listado,
                        "justificacion_matematica": {
                            "lineal": "y = m*x + b para tendencia general.",
                            "exponencial": "N(t) = N0 * e^(k*t) para crecimiento/decrecimiento.",
                        },
                        "prediccion_crecimiento": prediccion_crecimiento,
                    }
                )
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminServiciosView(APIView):
    permission_classes = [IsAuthenticated]

    FRONT_TO_DB_CATEGORIA = {
        "corte": "corte",
        "barba": "barba",
        "tratamiento": "tratamiento",
        "combo": "paquete",
        "paquete": "paquete",
    }
    DB_TO_FRONT_CATEGORIA = {
        "corte": "corte",
        "barba": "barba",
        "tratamiento": "tratamiento",
        "paquete": "combo",
    }

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
            return (row[0] if row and row[0] else "").strip().lower()

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def _normalize_categoria_db(self, categoria_front: str | None) -> str:
        raw = str(categoria_front or "").strip().lower()
        return self.FRONT_TO_DB_CATEGORIA.get(raw, "corte")

    def _serialize_servicio_row(self, row: tuple) -> dict[str, Any]:
        categoria_db = str(row[6] or "").strip().lower()
        categoria_front = self.DB_TO_FRONT_CATEGORIA.get(categoria_db, categoria_db or "corte")
        return {
            "id": int(row[0]),
            "nombre": row[1] or "",
            "descripcion": row[2] or "",
            "precio": float(row[3] or 0),
            "duracion_minutos": int(row[4] or 0),
            "activo": bool(row[5]),
            "categoria": categoria_front,
            "popular": bool(row[7]),
            "imagen_url": row[8] or "",
        }

    def _get_servicio_base(self, servicio_id: int) -> dict[str, Any] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    s.servicio_id,
                    s.nombre,
                    COALESCE(s.descripcion, ''),
                    s.precio_base,
                    s.duracion_base_min,
                    s.activo,
                    COALESCE(cs.codigo, 'corte') AS categoria_codigo,
                    s.popular,
                    COALESCE(
                        (
                            SELECT si.url
                            FROM negocio.servicio_imagen si
                            WHERE si.servicio_id = s.servicio_id
                            ORDER BY si.orden ASC
                            LIMIT 1
                        ),
                        ''
                    ) AS imagen_url
                FROM negocio.servicio s
                LEFT JOIN negocio.categoria_servicio cs
                    ON cs.categoria_servicio_id = s.categoria_servicio_id
                WHERE s.servicio_id = %s
                LIMIT 1
                """,
                [servicio_id],
            )
            row = cursor.fetchone()
        return self._serialize_servicio_row(row) if row else None

    def _get_categoria_id(self, categoria_db: str) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT categoria_servicio_id
                FROM negocio.categoria_servicio
                WHERE LOWER(codigo) = LOWER(%s)
                LIMIT 1
                """,
                [categoria_db],
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _normalize_galeria_urls(self, data: dict[str, Any]) -> list[str]:
        urls_raw = data.get("imagenes_galeria")
        urls: list[str] = []
        if isinstance(urls_raw, list):
            for item in urls_raw:
                value = str(item or "").strip()
                if value:
                    urls.append(value)

        # Compatibilidad si solo envían imagen_url.
        imagen_url = str(data.get("imagen_url", "")).strip()
        if not urls and imagen_url:
            urls = [imagen_url]
        return urls[:5]

    def _sync_servicio_imagenes(self, servicio_id: int, urls: list[str]) -> None:
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM negocio.servicio_imagen WHERE servicio_id = %s", [servicio_id])
            for idx, url in enumerate(urls, start=1):
                cursor.execute(
                    """
                    INSERT INTO negocio.servicio_imagen (servicio_id, url, orden, es_principal)
                    VALUES (%s, %s, %s, %s)
                    """,
                    [servicio_id, url, idx, idx == 1],
                )

    def _sync_barberos(self, servicio_id: int, barberos_ids: list[int]) -> None:
        valid_ids: set[int] = set()
        for item in barberos_ids:
            try:
                eid = int(item)
            except (TypeError, ValueError):
                continue
            if eid > 0:
                valid_ids.add(eid)

        with connection.cursor() as cursor:
            if valid_ids:
                cursor.execute(
                    """
                    SELECT DISTINCT e.empleado_id
                    FROM negocio.empleado e
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE e.empleado_id = ANY(%s)
                      AND LOWER(r.codigo) = 'barbero'
                    """,
                    [list(valid_ids)],
                )
                elegibles = {int(row[0]) for row in cursor.fetchall()}
                if elegibles != valid_ids:
                    raise ValueError("Uno o más barberos seleccionados no son válidos.")
            else:
                elegibles = set()

            cursor.execute("DELETE FROM negocio.barbero_servicio WHERE servicio_id = %s", [servicio_id])
            for empleado_id in sorted(elegibles):
                cursor.execute(
                    """
                    INSERT INTO negocio.barbero_servicio (empleado_id, servicio_id)
                    VALUES (%s, %s)
                    ON CONFLICT (empleado_id, servicio_id) DO NOTHING
                    """,
                    [empleado_id, servicio_id],
                )

    def _parse_etiquetas(self, etiquetas: Any) -> tuple[list[str], list[str]]:
        rostros: list[str] = []
        estilos: list[str] = []
        if not isinstance(etiquetas, list):
            return rostros, estilos

        for item in etiquetas:
            value = str(item or "").strip().lower()
            if value.startswith("rostro-"):
                code = value.replace("rostro-", "", 1).strip()
                if code:
                    rostros.append(code)
            elif value.startswith("estilo-"):
                code = value.replace("estilo-", "", 1).strip()
                if code:
                    estilos.append(code)
        # Quitar duplicados conservando orden.
        rostros = list(dict.fromkeys(rostros))
        estilos = list(dict.fromkeys(estilos))
        return rostros, estilos

    def _sync_etiquetas(self, servicio_id: int, etiquetas: Any) -> None:
        rostros, estilos = self._parse_etiquetas(etiquetas)
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM negocio.servicio_tipo_rostro WHERE servicio_id = %s", [servicio_id])
            cursor.execute("DELETE FROM negocio.servicio_estilo WHERE servicio_id = %s", [servicio_id])

            for code in rostros:
                cursor.execute(
                    """
                    SELECT tipo_rostro_id
                    FROM negocio.tipo_rostro
                    WHERE LOWER(codigo) = LOWER(%s)
                    LIMIT 1
                    """,
                    [code],
                )
                row = cursor.fetchone()
                if not row:
                    continue
                cursor.execute(
                    """
                    INSERT INTO negocio.servicio_tipo_rostro (servicio_id, tipo_rostro_id)
                    VALUES (%s, %s)
                    ON CONFLICT (servicio_id, tipo_rostro_id) DO NOTHING
                    """,
                    [servicio_id, int(row[0])],
                )

            for code in estilos:
                cursor.execute(
                    """
                    SELECT estilo_id
                    FROM negocio.estilo_recomendado
                    WHERE LOWER(codigo) = LOWER(%s)
                    LIMIT 1
                    """,
                    [code],
                )
                row = cursor.fetchone()
                if not row:
                    continue
                cursor.execute(
                    """
                    INSERT INTO negocio.servicio_estilo (servicio_id, estilo_id)
                    VALUES (%s, %s)
                    ON CONFLICT (servicio_id, estilo_id) DO NOTHING
                    """,
                    [servicio_id, int(row[0])],
                )

    def _build_detalle_relaciones(self, servicio_id: int) -> dict[str, Any]:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT url
                FROM negocio.servicio_imagen
                WHERE servicio_id = %s
                ORDER BY orden ASC
                """,
                [servicio_id],
            )
            galeria = [str(row[0] or "").strip() for row in cursor.fetchall() if str(row[0] or "").strip()]

            cursor.execute(
                """
                SELECT empleado_id
                FROM negocio.barbero_servicio
                WHERE servicio_id = %s
                ORDER BY empleado_id ASC
                """,
                [servicio_id],
            )
            barberos_ids = [int(row[0]) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT tr.codigo
                FROM negocio.servicio_tipo_rostro str
                JOIN negocio.tipo_rostro tr ON tr.tipo_rostro_id = str.tipo_rostro_id
                WHERE str.servicio_id = %s
                ORDER BY tr.tipo_rostro_id ASC
                """,
                [servicio_id],
            )
            rostros = [f"rostro-{str(row[0]).strip().lower()}" for row in cursor.fetchall() if row[0]]

            cursor.execute(
                """
                SELECT er.codigo
                FROM negocio.servicio_estilo se
                JOIN negocio.estilo_recomendado er ON er.estilo_id = se.estilo_id
                WHERE se.servicio_id = %s
                ORDER BY er.estilo_id ASC
                """,
                [servicio_id],
            )
            estilos = [f"estilo-{str(row[0]).strip().lower()}" for row in cursor.fetchall() if row[0]]

        return {
            "imagenes_galeria": galeria,
            "barberos_ids": barberos_ids,
            "etiquetas": rostros + estilos,
        }

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        s.servicio_id,
                        s.nombre,
                        COALESCE(s.descripcion, ''),
                        s.precio_base,
                        s.duracion_base_min,
                        s.activo,
                        COALESCE(cs.codigo, 'corte') AS categoria_codigo,
                        s.popular,
                        COALESCE(
                            (
                                SELECT si.url
                                FROM negocio.servicio_imagen si
                                WHERE si.servicio_id = s.servicio_id
                                ORDER BY si.orden ASC
                                LIMIT 1
                            ),
                            ''
                        ) AS imagen_url
                    FROM negocio.servicio s
                    LEFT JOIN negocio.categoria_servicio cs
                        ON cs.categoria_servicio_id = s.categoria_servicio_id
                    ORDER BY s.servicio_id ASC
                    """
                )
                rows = cursor.fetchall()
            servicios = [self._serialize_servicio_row(row) for row in rows]
            return Response({"ok": True, "servicios": servicios})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        nombre = str(data.get("nombre", "")).strip()
        descripcion = str(data.get("descripcion", "")).strip()
        precio = data.get("precio")
        duracion = data.get("duracion_minutos")
        categoria_db = self._normalize_categoria_db(str(data.get("categoria", "")).strip())
        activo = bool(data.get("activo", True))
        popular = bool(data.get("popular", False))
        imagenes_galeria = self._normalize_galeria_urls(data)
        barberos_ids = data.get("barberos_ids") if isinstance(data.get("barberos_ids"), list) else []
        etiquetas = data.get("etiquetas")

        if not nombre:
            return Response({"ok": False, "error": "El nombre del servicio es obligatorio."}, status=400)
        try:
            precio_num = float(precio)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "El precio es inválido."}, status=400)
        if precio_num < 0:
            return Response({"ok": False, "error": "El precio debe ser mayor o igual a 0."}, status=400)

        try:
            duracion_num = int(duracion)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "La duración es inválida."}, status=400)
        if duracion_num <= 0:
            return Response({"ok": False, "error": "La duración debe ser mayor a 0 minutos."}, status=400)

        try:
            categoria_id = self._get_categoria_id(categoria_db)
            if not categoria_id:
                return Response({"ok": False, "error": "Categoría de servicio inválida."}, status=400)

            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO negocio.servicio (
                            categoria_servicio_id, nombre, descripcion, precio_base, duracion_base_min, activo, popular
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        RETURNING servicio_id
                        """,
                        [categoria_id, nombre, descripcion or None, precio_num, duracion_num, activo, popular],
                    )
                    servicio_id = int(cursor.fetchone()[0])

                self._sync_servicio_imagenes(servicio_id, imagenes_galeria)
                self._sync_barberos(servicio_id, barberos_ids)
                self._sync_etiquetas(servicio_id, etiquetas)

            detalle = self._get_servicio_base(servicio_id) or {"id": servicio_id}
            detalle.update(self._build_detalle_relaciones(servicio_id))
            return Response({"ok": True, "mensaje": "Servicio creado correctamente.", "servicio": detalle})
        except ValueError as exc:
            return Response({"ok": False, "error": str(exc)}, status=400)
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminServicioDetalleView(AdminServiciosView):
    permission_classes = [IsAuthenticated]

    def get(self, request, servicio_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            base = self._get_servicio_base(servicio_id)
            if not base:
                return Response({"ok": False, "error": "Servicio no encontrado."}, status=404)
            base.update(self._build_detalle_relaciones(servicio_id))
            return Response({"ok": True, "servicio": base})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def put(self, request, servicio_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            actual = self._get_servicio_base(servicio_id)
            if not actual:
                return Response({"ok": False, "error": "Servicio no encontrado."}, status=404)

            nombre = str(data.get("nombre", actual["nombre"])).strip()
            descripcion = str(data.get("descripcion", actual["descripcion"])).strip()
            categoria_front = str(data.get("categoria", actual["categoria"])).strip()
            categoria_db = self._normalize_categoria_db(categoria_front)
            activo = bool(data.get("activo", actual["activo"]))
            popular = bool(data.get("popular", actual["popular"]))

            if not nombre:
                return Response({"ok": False, "error": "El nombre del servicio es obligatorio."}, status=400)

            precio_raw = data.get("precio", actual["precio"])
            duracion_raw = data.get("duracion_minutos", actual["duracion_minutos"])
            try:
                precio_num = float(precio_raw)
            except (TypeError, ValueError):
                return Response({"ok": False, "error": "El precio es inválido."}, status=400)
            if precio_num < 0:
                return Response({"ok": False, "error": "El precio debe ser mayor o igual a 0."}, status=400)
            try:
                duracion_num = int(duracion_raw)
            except (TypeError, ValueError):
                return Response({"ok": False, "error": "La duración es inválida."}, status=400)
            if duracion_num <= 0:
                return Response({"ok": False, "error": "La duración debe ser mayor a 0 minutos."}, status=400)

            categoria_id = self._get_categoria_id(categoria_db)
            if not categoria_id:
                return Response({"ok": False, "error": "Categoría de servicio inválida."}, status=400)

            imagenes_galeria = self._normalize_galeria_urls(data) if (
                "imagenes_galeria" in data or "imagen_url" in data
            ) else self._build_detalle_relaciones(servicio_id)["imagenes_galeria"]
            barberos_ids = data.get("barberos_ids") if isinstance(data.get("barberos_ids"), list) else None
            etiquetas = data.get("etiquetas") if "etiquetas" in data else None

            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE negocio.servicio
                        SET
                            categoria_servicio_id = %s,
                            nombre = %s,
                            descripcion = %s,
                            precio_base = %s,
                            duracion_base_min = %s,
                            activo = %s,
                            popular = %s
                        WHERE servicio_id = %s
                        """,
                        [
                            categoria_id,
                            nombre,
                            descripcion or None,
                            precio_num,
                            duracion_num,
                            activo,
                            popular,
                            servicio_id,
                        ],
                    )

                if imagenes_galeria is not None:
                    self._sync_servicio_imagenes(servicio_id, imagenes_galeria)
                if barberos_ids is not None:
                    self._sync_barberos(servicio_id, barberos_ids)
                if etiquetas is not None:
                    self._sync_etiquetas(servicio_id, etiquetas)

            base = self._get_servicio_base(servicio_id) or {"id": servicio_id}
            base.update(self._build_detalle_relaciones(servicio_id))
            return Response({"ok": True, "mensaje": "Servicio actualizado correctamente.", "servicio": base})
        except ValueError as exc:
            return Response({"ok": False, "error": str(exc)}, status=400)
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def delete(self, request, servicio_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        DELETE FROM negocio.servicio
                        WHERE servicio_id = %s
                        RETURNING servicio_id
                        """,
                        [servicio_id],
                    )
                    row = cursor.fetchone()
            if not row:
                return Response({"ok": False, "error": "Servicio no encontrado."}, status=404)
            return Response({"ok": True, "mensaje": "Servicio eliminado correctamente."})
        except DatabaseError as exc:
            return Response(
                {
                    "ok": False,
                    "error": (
                        "No se puede eliminar el servicio porque está relacionado con otros registros "
                        "(por ejemplo citas o ventas). Puedes desactivarlo en su lugar."
                    ),
                    "detail": str(exc),
                },
                status=409,
            )


class AdminProductosView(APIView):
    permission_classes = [IsAuthenticated]

    FRONT_TO_DB_CATEGORIA = {
        "cabello": "cabello",
        "barba": "barba",
        "accesorios": "accesorio",
        "accesorio": "accesorio",
        "kit": "kit",
        "facial": "facial",
    }
    DB_TO_FRONT_CATEGORIA = {
        "cabello": "cabello",
        "barba": "barba",
        "accesorio": "accesorios",
        "kit": "kit",
        "facial": "facial",
    }
    # Códigos reconocidos en negocio.categoria_producto; si no existe fila, se crea al guardar producto.
    CATEGORIA_PRODUCTO_NOMBRES: dict[str, str] = {
        "cabello": "Cabello",
        "barba": "Barba",
        "accesorio": "Accesorios",
        "kit": "Kits",
        "facial": "Facial",
    }

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        ELSE 99
                    END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return str(row[0] or "") if row else ""

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_negocio_admin(self, request) -> bool:
        return self._get_rol_codigo(request) in ("administrador", "admin")

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request) or self._is_negocio_admin(request)

    def _normalize_categoria_db(self, categoria_front: str | None) -> str:
        raw = str(categoria_front or "").strip().lower()
        return self.FRONT_TO_DB_CATEGORIA.get(raw, "cabello")

    def _get_categoria_id(self, categoria_db: str) -> int | None:
        raw = str(categoria_db or "").strip().lower()
        if not raw:
            return None
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT categoria_producto_id
                FROM negocio.categoria_producto
                WHERE LOWER(codigo) = LOWER(%s)
                LIMIT 1
                """,
                [raw],
            )
            row = cursor.fetchone()
            if row:
                return int(row[0])
            nombre = self.CATEGORIA_PRODUCTO_NOMBRES.get(raw)
            if not nombre:
                return None
            cursor.execute(
                """
                INSERT INTO negocio.categoria_producto (codigo, nombre)
                VALUES (%s, %s)
                RETURNING categoria_producto_id
                """,
                [raw, nombre],
            )
            ins = cursor.fetchone()
            return int(ins[0]) if ins else None

    def _get_or_create_marca_id(self, marca_nombre: str) -> int:
        marca = str(marca_nombre or "").strip()
        if not marca:
            marca = "Sin marca"
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT marca_id
                FROM negocio.marca
                WHERE LOWER(nombre) = LOWER(%s)
                LIMIT 1
                """,
                [marca],
            )
            row = cursor.fetchone()
            if row:
                return int(row[0])
            cursor.execute(
                """
                INSERT INTO negocio.marca (nombre, activa)
                VALUES (%s, TRUE)
                RETURNING marca_id
                """,
                [marca],
            )
            return int(cursor.fetchone()[0])

    def _normalize_galeria_urls(self, data: dict[str, Any]) -> list[str]:
        urls_raw = data.get("imagenes_galeria")
        urls: list[str] = []
        if isinstance(urls_raw, list):
            for item in urls_raw:
                value = str(item or "").strip()
                if value:
                    urls.append(value)
        imagen_url = str(data.get("imagen_url", "")).strip()
        if not urls and imagen_url:
            urls = [imagen_url]
        return urls[:5]

    def _normalize_peso_volumen(self, value: Any) -> str | None:
        raw = str(value or "").strip()
        if not raw:
            return None
        return raw[:60]

    def _sync_producto_imagenes(self, producto_id: int, urls: list[str]) -> None:
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM negocio.producto_imagen WHERE producto_id = %s", [producto_id])
            for idx, url in enumerate(urls, start=1):
                cursor.execute(
                    """
                    INSERT INTO negocio.producto_imagen (producto_id, url, orden, es_principal)
                    VALUES (%s, %s, %s, %s)
                    """,
                    [producto_id, url, idx, idx == 1],
                )

    def _upsert_stock(self, producto_id: int, stock_actual: int) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO negocio.inventario_existencia (producto_id, stock_actual, ultima_entrada)
                VALUES (%s, %s, CASE WHEN %s > 0 THEN NOW() ELSE NULL END)
                ON CONFLICT (producto_id)
                DO UPDATE SET stock_actual = EXCLUDED.stock_actual
                """,
                [producto_id, stock_actual, stock_actual],
            )

    def _serialize_producto_row(self, row: tuple) -> dict[str, Any]:
        categoria_db = str(row[4] or "").strip().lower()
        categoria_front = self.DB_TO_FRONT_CATEGORIA.get(categoria_db, categoria_db or "cabello")
        return {
            "id": int(row[0]),
            "nombre": row[1] or "",
            "marca": row[2] or "",
            "descripcion": row[3] or "",
            "peso_volumen": row[5] or "",
            "categoria": categoria_front,
            "precio": float(row[6] or 0),
            "stock": int(row[7] or 0),
            "stock_minimo": int(row[8] or 0),
            "imagen_url": row[9] or "",
            "activo": bool(row[10]),
            "destacado": bool(row[11]),
            "nuevo": False,
        }

    def _get_producto_base(self, producto_id: int) -> dict[str, Any] | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    p.producto_id,
                    p.nombre,
                    COALESCE(m.nombre, ''),
                    COALESCE(p.descripcion, ''),
                    COALESCE(cp.codigo, 'cabello') AS categoria_codigo,
                    COALESCE(p.peso_volumen, '') AS peso_volumen,
                    p.precio_venta,
                    COALESCE(ie.stock_actual, 0) AS stock_actual,
                    p.stock_minimo_alerta,
                    COALESCE(
                        (
                            SELECT pi.url
                            FROM negocio.producto_imagen pi
                            WHERE pi.producto_id = p.producto_id
                            ORDER BY pi.orden ASC
                            LIMIT 1
                        ),
                        ''
                    ) AS imagen_url,
                    (p.estado = 'activo' AND p.disponible_venta = TRUE) AS activo,
                    p.destacado
                FROM negocio.producto p
                LEFT JOIN negocio.marca m
                    ON m.marca_id = p.marca_id
                LEFT JOIN negocio.categoria_producto cp
                    ON cp.categoria_producto_id = p.categoria_producto_id
                LEFT JOIN negocio.inventario_existencia ie
                    ON ie.producto_id = p.producto_id
                WHERE p.producto_id = %s
                LIMIT 1
                """,
                [producto_id],
            )
            row = cursor.fetchone()
        return self._serialize_producto_row(row) if row else None

    def _build_producto_detalle(self, producto_id: int) -> dict[str, Any]:
        base = self._get_producto_base(producto_id) or {"id": producto_id}
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT url
                FROM negocio.producto_imagen
                WHERE producto_id = %s
                ORDER BY orden ASC
                """,
                [producto_id],
            )
            galeria = [str(row[0] or "").strip() for row in cursor.fetchall() if str(row[0] or "").strip()]
        base["imagenes_galeria"] = galeria
        return base

    def _build_productos_catalog_where(
        self, request, *, include_marca: bool
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = ["1=1"]
        params: list[Any] = []

        est = str(request.GET.get("estado", "") or "activo").strip().lower()
        if est == "activo":
            clauses.append("(p.estado = 'activo' AND p.disponible_venta = TRUE)")
        elif est == "todos":
            pass
        elif est == "disponible":
            clauses.append(
                "(p.estado = 'activo' AND p.disponible_venta = TRUE AND COALESCE(ie.stock_actual, 0) > 0)"
            )
        elif est == "bajo":
            clauses.append(
                "(p.estado = 'activo' AND p.disponible_venta = TRUE "
                "AND COALESCE(ie.stock_actual, 0) > 0 "
                "AND COALESCE(ie.stock_actual, 0) <= p.stock_minimo_alerta)"
            )
        elif est == "agotado":
            clauses.append(
                "(p.estado = 'activo' AND p.disponible_venta = TRUE AND COALESCE(ie.stock_actual, 0) = 0)"
            )
        else:
            clauses.append("(p.estado = 'activo' AND p.disponible_venta = TRUE)")

        cat_front = str(request.GET.get("categoria", "") or "").strip().lower()
        if cat_front:
            cat_db = self.FRONT_TO_DB_CATEGORIA.get(cat_front)
            if cat_db:
                clauses.append("LOWER(COALESCE(cp.codigo, '')) = LOWER(%s)")
                params.append(cat_db)

        if include_marca:
            marca_filt = str(request.GET.get("marca", "") or "").strip()
            if marca_filt:
                clauses.append("LOWER(TRIM(COALESCE(m.nombre, ''))) = LOWER(TRIM(%s))")
                params.append(marca_filt)

        q = str(request.GET.get("q", "") or "").strip()
        if q:
            like = f"%{q}%"
            clauses.append(
                "(p.nombre ILIKE %s OR COALESCE(m.nombre, '') ILIKE %s OR COALESCE(p.descripcion, '') ILIKE %s)"
            )
            params.extend([like, like, like])

        return " AND ".join(clauses), params

    def _productos_catalog_select_sql(self) -> str:
        return """
            SELECT
                p.producto_id,
                p.nombre,
                COALESCE(m.nombre, ''),
                COALESCE(p.descripcion, ''),
                COALESCE(cp.codigo, 'cabello') AS categoria_codigo,
                COALESCE(p.peso_volumen, '') AS peso_volumen,
                p.precio_venta,
                COALESCE(ie.stock_actual, 0) AS stock_actual,
                p.stock_minimo_alerta,
                COALESCE(
                    (
                        SELECT pi.url
                        FROM negocio.producto_imagen pi
                        WHERE pi.producto_id = p.producto_id
                        ORDER BY pi.orden ASC
                        LIMIT 1
                    ),
                    ''
                ) AS imagen_url,
                (p.estado = 'activo' AND p.disponible_venta = TRUE) AS activo,
                p.destacado
            FROM negocio.producto p
            LEFT JOIN negocio.marca m
                ON m.marca_id = p.marca_id
            LEFT JOIN negocio.categoria_producto cp
                ON cp.categoria_producto_id = p.categoria_producto_id
            LEFT JOIN negocio.inventario_existencia ie
                ON ie.producto_id = p.producto_id
        """

    def _get_productos_catalog_payload(self, request) -> dict[str, Any]:
        try:
            page = max(1, int(request.GET.get("page") or 1))
        except (TypeError, ValueError):
            page = 1
        try:
            per_page = min(100, max(1, int(request.GET.get("per_page") or 24)))
        except (TypeError, ValueError):
            per_page = 24
        offset = (page - 1) * per_page

        where_list, params_list = self._build_productos_catalog_where(request, include_marca=True)
        where_marcas, params_marcas = self._build_productos_catalog_where(request, include_marca=False)

        base_from = self._productos_catalog_select_sql()

        with connection.cursor() as cursor:
            cursor.execute(
                f"SELECT COUNT(*) FROM ({base_from} WHERE {where_list}) AS sub",
                params_list,
            )
            total = int(cursor.fetchone()[0] or 0)

            cursor.execute(
                f"""
                SELECT COUNT(*) FILTER (
                    WHERE COALESCE(ie.stock_actual, 0) > 0
                ) AS disp,
                COUNT(*) FILTER (
                    WHERE COALESCE(ie.stock_actual, 0) > 0
                      AND COALESCE(ie.stock_actual, 0) <= p.stock_minimo_alerta
                ) AS bajo,
                COUNT(*) FILTER (
                    WHERE COALESCE(ie.stock_actual, 0) = 0
                ) AS agot
                FROM negocio.producto p
                LEFT JOIN negocio.marca m ON m.marca_id = p.marca_id
                LEFT JOIN negocio.categoria_producto cp
                    ON cp.categoria_producto_id = p.categoria_producto_id
                LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                WHERE {where_list}
                """,
                params_list,
            )
            st_row = cursor.fetchone()
            disponibles = int(st_row[0] or 0)
            stock_bajo = int(st_row[1] or 0)
            agotados = int(st_row[2] or 0)

            cursor.execute(
                f"""
                SELECT DISTINCT TRIM(COALESCE(m.nombre, '')) AS nombre_marca
                FROM negocio.producto p
                LEFT JOIN negocio.marca m ON m.marca_id = p.marca_id
                LEFT JOIN negocio.categoria_producto cp
                    ON cp.categoria_producto_id = p.categoria_producto_id
                LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                WHERE {where_marcas}
                  AND TRIM(COALESCE(m.nombre, '')) <> ''
                ORDER BY nombre_marca ASC
                """,
                params_marcas,
            )
            marcas_filtro = [str(r[0]) for r in cursor.fetchall() if str(r[0] or "").strip()]

            list_params = list(params_list)
            list_params.extend([per_page, offset])
            cursor.execute(
                f"{base_from} WHERE {where_list} ORDER BY p.producto_id ASC LIMIT %s OFFSET %s",
                list_params,
            )
            rows = cursor.fetchall()

        productos = [self._serialize_producto_row(row) for row in rows]
        total_pages = max(1, math.ceil(total / per_page)) if per_page else 1
        return {
            "ok": True,
            "productos": productos,
            "total": total,
            "total_pages": total_pages,
            "page": page,
            "per_page": per_page,
            "stats": {
                "disponibles": disponibles,
                "stock_bajo": stock_bajo,
                "agotados": agotados,
            },
            "marcas_filtro": marcas_filtro,
        }

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            only_active = str(request.GET.get("activo", "")).strip() in {"1", "true", "True"}
            if only_active:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            p.producto_id,
                            p.nombre,
                            COALESCE(m.nombre, ''),
                            COALESCE(p.descripcion, ''),
                            COALESCE(cp.codigo, 'cabello') AS categoria_codigo,
                            COALESCE(p.peso_volumen, '') AS peso_volumen,
                            p.precio_venta,
                            COALESCE(ie.stock_actual, 0) AS stock_actual,
                            p.stock_minimo_alerta,
                            COALESCE(
                                (
                                    SELECT pi.url
                                    FROM negocio.producto_imagen pi
                                    WHERE pi.producto_id = p.producto_id
                                    ORDER BY pi.orden ASC
                                    LIMIT 1
                                ),
                                ''
                            ) AS imagen_url,
                            (p.estado = 'activo' AND p.disponible_venta = TRUE) AS activo,
                            p.destacado
                        FROM negocio.producto p
                        LEFT JOIN negocio.marca m
                            ON m.marca_id = p.marca_id
                        LEFT JOIN negocio.categoria_producto cp
                            ON cp.categoria_producto_id = p.categoria_producto_id
                        LEFT JOIN negocio.inventario_existencia ie
                            ON ie.producto_id = p.producto_id
                        WHERE (p.estado = 'activo' AND p.disponible_venta = TRUE)
                        ORDER BY p.producto_id ASC
                        """
                    )
                    rows = cursor.fetchall()
                productos = [self._serialize_producto_row(row) for row in rows]
                return Response({"ok": True, "productos": productos})

            if request.GET.get("page") is not None or request.GET.get("per_page") is not None:
                return Response(self._get_productos_catalog_payload(request))

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        p.producto_id,
                        p.nombre,
                        COALESCE(m.nombre, ''),
                        COALESCE(p.descripcion, ''),
                        COALESCE(cp.codigo, 'cabello') AS categoria_codigo,
                        COALESCE(p.peso_volumen, '') AS peso_volumen,
                        p.precio_venta,
                        COALESCE(ie.stock_actual, 0) AS stock_actual,
                        p.stock_minimo_alerta,
                        COALESCE(
                            (
                                SELECT pi.url
                                FROM negocio.producto_imagen pi
                                WHERE pi.producto_id = p.producto_id
                                ORDER BY pi.orden ASC
                                LIMIT 1
                            ),
                            ''
                        ) AS imagen_url,
                        (p.estado = 'activo' AND p.disponible_venta = TRUE) AS activo,
                        p.destacado
                    FROM negocio.producto p
                    LEFT JOIN negocio.marca m
                        ON m.marca_id = p.marca_id
                    LEFT JOIN negocio.categoria_producto cp
                        ON cp.categoria_producto_id = p.categoria_producto_id
                    LEFT JOIN negocio.inventario_existencia ie
                        ON ie.producto_id = p.producto_id
                    WHERE (%s = FALSE OR (p.estado = 'activo' AND p.disponible_venta = TRUE))
                    ORDER BY p.producto_id ASC
                    """
                    ,
                    [False],
                )
                rows = cursor.fetchall()
            productos = [self._serialize_producto_row(row) for row in rows]
            return Response({"ok": True, "productos": productos})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def post(self, request):
        if not (self._is_admin(request) or self._is_negocio_admin(request)):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        nombre = str(data.get("nombre", "")).strip()
        marca = str(data.get("marca", "")).strip()
        descripcion = str(data.get("descripcion", "")).strip()
        categoria_db = self._normalize_categoria_db(str(data.get("categoria", "")).strip())
        activo = bool(data.get("activo", True))
        destacado = bool(data.get("destacado", False))
        peso_volumen = self._normalize_peso_volumen(data.get("peso_volumen"))
        imagenes_galeria = self._normalize_galeria_urls(data)

        if not nombre:
            return Response({"ok": False, "error": "El nombre del producto es obligatorio."}, status=400)
        if not imagenes_galeria:
            return Response({"ok": False, "error": "Debes agregar al menos una imagen del producto."}, status=400)
        try:
            precio = float(data.get("precio", 0))
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "El precio es inválido."}, status=400)
        if precio < 0:
            return Response({"ok": False, "error": "El precio debe ser mayor o igual a 0."}, status=400)
        try:
            stock = int(data.get("stock", 0) or 0)
            stock_minimo = int(data.get("stock_minimo", 10) or 0)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "Stock o stock mínimo inválidos."}, status=400)
        if stock < 0 or stock_minimo < 0:
            return Response({"ok": False, "error": "Stock y stock mínimo deben ser >= 0."}, status=400)

        try:
            categoria_id = self._get_categoria_id(categoria_db)
            if not categoria_id:
                return Response({"ok": False, "error": "Categoría de producto inválida."}, status=400)

            with transaction.atomic():
                marca_id = self._get_or_create_marca_id(marca)
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO negocio.producto (
                            marca_id, categoria_producto_id, nombre, descripcion, precio_venta,
                            peso_volumen, stock_minimo_alerta, destacado, estado, disponible_venta
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING producto_id
                        """,
                        [
                            marca_id,
                            categoria_id,
                            nombre,
                            descripcion or None,
                            precio,
                            peso_volumen,
                            stock_minimo,
                            destacado,
                            "activo" if activo else "inactivo",
                            activo,
                        ],
                    )
                    producto_id = int(cursor.fetchone()[0])

                self._upsert_stock(producto_id, stock)
                self._sync_producto_imagenes(producto_id, imagenes_galeria)

            producto = self._build_producto_detalle(producto_id)
            return Response({"ok": True, "mensaje": "Producto creado correctamente.", "producto": producto})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminProductoDetalleView(AdminProductosView):
    permission_classes = [IsAuthenticated]

    def get(self, request, producto_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            producto = self._build_producto_detalle(producto_id)
            if not producto.get("nombre"):
                return Response({"ok": False, "error": "Producto no encontrado."}, status=404)
            return Response({"ok": True, "producto": producto})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def put(self, request, producto_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            actual = self._get_producto_base(producto_id)
            if not actual:
                return Response({"ok": False, "error": "Producto no encontrado."}, status=404)

            nombre = str(data.get("nombre", actual["nombre"])).strip()
            marca = str(data.get("marca", actual["marca"])).strip()
            descripcion = str(data.get("descripcion", actual["descripcion"])).strip()
            categoria_db = self._normalize_categoria_db(str(data.get("categoria", actual["categoria"])).strip())
            activo = bool(data.get("activo", actual["activo"]))
            destacado = bool(data.get("destacado", actual["destacado"]))
            peso_volumen = self._normalize_peso_volumen(data.get("peso_volumen", actual.get("peso_volumen")))

            if not nombre:
                return Response({"ok": False, "error": "El nombre del producto es obligatorio."}, status=400)
            try:
                precio = float(data.get("precio", actual["precio"]))
                stock_minimo = int(data.get("stock_minimo", actual["stock_minimo"]))
            except (TypeError, ValueError):
                return Response({"ok": False, "error": "Precio o stock mínimo inválidos."}, status=400)
            if precio < 0 or stock_minimo < 0:
                return Response({"ok": False, "error": "Precio y stock mínimo deben ser >= 0."}, status=400)

            categoria_id = self._get_categoria_id(categoria_db)
            if not categoria_id:
                return Response({"ok": False, "error": "Categoría de producto inválida."}, status=400)

            imagenes_galeria = self._normalize_galeria_urls(data) if (
                "imagenes_galeria" in data or "imagen_url" in data
            ) else self._build_producto_detalle(producto_id).get("imagenes_galeria", [])

            with transaction.atomic():
                marca_id = self._get_or_create_marca_id(marca)
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE negocio.producto
                        SET
                            marca_id = %s,
                            categoria_producto_id = %s,
                            nombre = %s,
                            descripcion = %s,
                            peso_volumen = %s,
                            precio_venta = %s,
                            stock_minimo_alerta = %s,
                            destacado = %s,
                            estado = %s,
                            disponible_venta = %s
                        WHERE producto_id = %s
                        """,
                        [
                            marca_id,
                            categoria_id,
                            nombre,
                            descripcion or None,
                            peso_volumen,
                            precio,
                            stock_minimo,
                            destacado,
                            "activo" if activo else "inactivo",
                            activo,
                            producto_id,
                        ],
                    )
                self._sync_producto_imagenes(producto_id, imagenes_galeria)

            producto = self._build_producto_detalle(producto_id)
            return Response({"ok": True, "mensaje": "Producto actualizado correctamente.", "producto": producto})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

    def delete(self, request, producto_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    # Limpiar existencia para permitir borrado físico del producto
                    # cuando no tiene relaciones de negocio (ventas/pedidos/movimientos).
                    cursor.execute(
                        "DELETE FROM negocio.inventario_existencia WHERE producto_id = %s",
                        [producto_id],
                    )
                    cursor.execute(
                        """
                        DELETE FROM negocio.producto
                        WHERE producto_id = %s
                        RETURNING producto_id
                        """,
                        [producto_id],
                    )
                    row = cursor.fetchone()
            if not row:
                return Response({"ok": False, "error": "Producto no encontrado."}, status=404)
            return Response({"ok": True, "mensaje": "Producto eliminado correctamente."})
        except DatabaseError as exc:
            return Response(
                {
                    "ok": False,
                    "error": (
                        "No se puede eliminar el producto porque está relacionado con otros registros "
                        "(por ejemplo ventas, pedidos o inventario). Puedes desactivarlo en su lugar."
                    ),
                    "detail": str(exc),
                },
                status=409,
            )


class AdminProductoStockView(AdminProductosView):
    permission_classes = [IsAuthenticated]

    def put(self, request, producto_id: int):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            cantidad = int(data.get("cantidad", 0))
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "Cantidad inválida."}, status=400)
        operacion = str(data.get("operacion", "sumar") or "sumar").strip().lower()
        if operacion not in {"sumar", "establecer"}:
            return Response({"ok": False, "error": "Operación inválida."}, status=400)
        if operacion == "sumar" and cantidad == 0:
            return Response({"ok": False, "error": "La cantidad no puede ser 0."}, status=400)
        if operacion == "establecer" and cantidad < 0:
            return Response({"ok": False, "error": "La cantidad no puede ser negativa."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SELECT producto_id FROM negocio.producto WHERE producto_id = %s", [producto_id])
                    if not cursor.fetchone():
                        return Response({"ok": False, "error": "Producto no encontrado."}, status=404)

                    cursor.execute(
                        """
                        INSERT INTO negocio.inventario_existencia (producto_id, stock_actual)
                        VALUES (%s, 0)
                        ON CONFLICT (producto_id) DO NOTHING
                        """,
                        [producto_id],
                    )
                    cursor.execute(
                        "SELECT stock_actual FROM negocio.inventario_existencia WHERE producto_id = %s FOR UPDATE",
                        [producto_id],
                    )
                    stock_actual = int((cursor.fetchone() or [0])[0] or 0)
                    delta = (cantidad - stock_actual) if operacion == "establecer" else cantidad
                    nuevo_stock = stock_actual + delta
                    if nuevo_stock < 0:
                        return Response({"ok": False, "error": "El stock resultante no puede ser negativo."}, status=400)
                    if delta == 0:
                        return Response({"ok": True, "stock_actual": stock_actual})

                    tipo_codigo = "entrada" if delta > 0 else "salida"
                    cursor.execute(
                        """
                        SELECT tipo_movimiento_id
                        FROM negocio.tipo_movimiento_inventario
                        WHERE LOWER(codigo) = LOWER(%s)
                        LIMIT 1
                        """,
                        [tipo_codigo],
                    )
                    row_tipo = cursor.fetchone()
                    if not row_tipo:
                        return Response({"ok": False, "error": "No existe el tipo de movimiento requerido."}, status=400)
                    tipo_movimiento_id = int(row_tipo[0])

                    empleado_id = None
                    email = str(getattr(request.user, "email", "") or "").strip()
                    username = str(getattr(request.user, "username", "") or "").strip()
                    if email or username:
                        cursor.execute(
                            """
                            SELECT e.empleado_id
                            FROM negocio.empleado e
                            JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                            WHERE (LOWER(u.email) = LOWER(%s) AND %s <> '')
                               OR (LOWER(u.username) = LOWER(%s) AND %s <> '')
                            LIMIT 1
                            """,
                            [email, email, username, username],
                        )
                        row_emp = cursor.fetchone()
                        empleado_id = int(row_emp[0]) if row_emp else None

                    notas_raw = str(data.get("notas", "") or "").strip()
                    # Regla de negocio: para secretaría la nota es obligatoria en entrada/salida/ajuste.
                    if self._is_secretaria(request) and not notas_raw:
                        return Response(
                            {
                                "ok": False,
                                "error": "La nota es obligatoria para secretaría. Especifica el motivo del movimiento.",
                            },
                            status=400,
                        )
                    notas = notas_raw or None
                    cursor.execute(
                        """
                        INSERT INTO negocio.inventario_movimiento (
                            producto_id,
                            tipo_movimiento_id,
                            empleado_id,
                            cantidad,
                            stock_anterior,
                            stock_posterior,
                            nota
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        [
                            producto_id,
                            tipo_movimiento_id,
                            empleado_id,
                            abs(delta),
                            stock_actual,
                            nuevo_stock,
                            notas,
                        ],
                    )

                    cursor.execute(
                        "SELECT stock_actual FROM negocio.inventario_existencia WHERE producto_id = %s",
                        [producto_id],
                    )
                    nuevo_stock_real = int((cursor.fetchone() or [nuevo_stock])[0] or nuevo_stock)

            return Response({"ok": True, "stock_actual": nuevo_stock_real})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminInventarioMovimientosView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _is_secretaria(self, request) -> bool:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        if not username and not email:
            return False
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT 1
                FROM negocio.usuario u
                JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (
                        (LOWER(u.username) = LOWER(%s) AND %s <> '')
                     OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                      )
                  AND LOWER(COALESCE(r.codigo, '')) = 'secretaria'
                LIMIT 1
                """,
                [username, username, email, email],
            )
            return bool(cursor.fetchone())

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def get(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            try:
                limit = int(request.GET.get("limit", 100))
            except (TypeError, ValueError):
                limit = 100
            limit = max(1, min(limit, 500))
            hoy = str(request.GET.get("hoy", "")).strip().lower() in {"1", "true", "si", "sí"}

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        COALESCE(tmi.codigo, 'ajuste') AS tipo_codigo,
                        COALESCE(p.nombre, 'Producto'),
                        im.cantidad,
                        im.fecha,
                        COALESCE(
                            NULLIF(TRIM(CONCAT(
                                COALESCE(pp.nombres, ''),
                                ' ',
                                COALESCE(pp.apellido_paterno, ''),
                                ' ',
                                COALESCE(pp.apellido_materno, '')
                            )), ''),
                            u.username,
                            'Sistema'
                        ) AS usuario,
                        COALESCE(im.nota, '')
                    FROM negocio.inventario_movimiento im
                    LEFT JOIN negocio.producto p ON p.producto_id = im.producto_id
                    LEFT JOIN negocio.tipo_movimiento_inventario tmi ON tmi.tipo_movimiento_id = im.tipo_movimiento_id
                    LEFT JOIN negocio.empleado e ON e.empleado_id = im.empleado_id
                    LEFT JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    WHERE (%s = FALSE OR DATE(im.fecha AT TIME ZONE 'America/Mexico_City') = CURRENT_DATE)
                    ORDER BY im.fecha DESC, im.movimiento_id DESC
                    LIMIT %s
                    """,
                    [hoy, limit],
                )
                rows = cursor.fetchall()

            movimientos = []
            for row in rows:
                raw_tipo = str(row[0] or "").strip().lower()
                if raw_tipo not in {"entrada", "salida", "ajuste"}:
                    tipo = "ajuste"
                else:
                    tipo = raw_tipo
                movimientos.append(
                    {
                        "tipo": tipo,
                        "producto": row[1] or "Producto",
                        "cantidad": int(row[2] or 0),
                        "fecha": row[3],
                        "usuario": row[4] or "Sistema",
                        "notas": row[5] or "",
                    }
                )
            return Response({"ok": True, "movimientos": movimientos})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class AdminInventarioSalidasMasivasView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        data = request.data if isinstance(request.data, dict) else {}
        items = data.get("items", [])
        origen = str(data.get("origen", "venta_tienda") or "venta_tienda").strip().lower()
        referencia = str(data.get("referencia", "") or "").strip()

        if origen not in {"venta_cliente", "venta_tienda"}:
            return Response({"ok": False, "error": "Origen inválido."}, status=400)
        if not isinstance(items, list) or not items:
            return Response({"ok": False, "error": "Debes enviar al menos un item de salida."}, status=400)

        normalizados: list[tuple[int, int]] = []
        for item in items:
            if not isinstance(item, dict):
                return Response({"ok": False, "error": "Formato de items inválido."}, status=400)
            try:
                producto_id = int(item.get("producto_id"))
                cantidad = int(item.get("cantidad"))
            except (TypeError, ValueError):
                return Response({"ok": False, "error": "Producto o cantidad inválidos."}, status=400)
            if producto_id <= 0 or cantidad <= 0:
                return Response({"ok": False, "error": "Producto y cantidad deben ser mayores a 0."}, status=400)
            normalizados.append((producto_id, cantidad))

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT tipo_movimiento_id
                        FROM negocio.tipo_movimiento_inventario
                        WHERE LOWER(codigo) = 'salida'
                        LIMIT 1
                        """
                    )
                    row_tipo = cursor.fetchone()
                    if not row_tipo:
                        return Response({"ok": False, "error": "No existe tipo de movimiento 'salida'."}, status=400)
                    tipo_movimiento_id = int(row_tipo[0])

                    empleado_id = None
                    email = str(getattr(request.user, "email", "") or "").strip()
                    username = str(getattr(request.user, "username", "") or "").strip()
                    if email or username:
                        cursor.execute(
                            """
                            SELECT e.empleado_id
                            FROM negocio.empleado e
                            JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                            WHERE (LOWER(u.email) = LOWER(%s) AND %s <> '')
                               OR (LOWER(u.username) = LOWER(%s) AND %s <> '')
                            LIMIT 1
                            """,
                            [email, email, username, username],
                        )
                        row_emp = cursor.fetchone()
                        empleado_id = int(row_emp[0]) if row_emp else None

                    procesados = 0
                    for producto_id, cantidad in normalizados:
                        cursor.execute("SELECT producto_id FROM negocio.producto WHERE producto_id = %s", [producto_id])
                        if not cursor.fetchone():
                            return Response({"ok": False, "error": f"Producto {producto_id} no encontrado."}, status=404)

                        cursor.execute(
                            """
                            INSERT INTO negocio.inventario_existencia (producto_id, stock_actual)
                            VALUES (%s, 0)
                            ON CONFLICT (producto_id) DO NOTHING
                            """,
                            [producto_id],
                        )
                        cursor.execute(
                            "SELECT stock_actual FROM negocio.inventario_existencia WHERE producto_id = %s FOR UPDATE",
                            [producto_id],
                        )
                        stock_actual = int((cursor.fetchone() or [0])[0] or 0)
                        nuevo_stock = stock_actual - cantidad
                        if nuevo_stock < 0:
                            return Response(
                                {"ok": False, "error": f"Stock insuficiente para producto {producto_id}."},
                                status=400,
                            )

                        nota = f"Salida masiva ({origen})"
                        if referencia:
                            nota = f"{nota} - {referencia}"
                        cursor.execute(
                            """
                            INSERT INTO negocio.inventario_movimiento (
                                producto_id,
                                tipo_movimiento_id,
                                empleado_id,
                                cantidad,
                                stock_anterior,
                                stock_posterior,
                                nota
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            """,
                            [producto_id, tipo_movimiento_id, empleado_id, cantidad, stock_actual, nuevo_stock, nota],
                        )
                        procesados += 1

            return Response({"ok": True, "mensaje": "Salidas registradas correctamente.", "items_procesados": procesados})
        except DatabaseError as exc:
            return db_structure_error_response(exc)

class AdminRespaldoDBDescargarView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _backups_dir(self) -> Path:
        root = Path(getattr(settings, "BASE_DIR", Path.cwd()))
        backups_dir = root / "respaldos_db"
        backups_dir.mkdir(parents=True, exist_ok=True)
        return backups_dir

    def get(self, request, archivo: str):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        safe_name = Path(str(archivo or "")).name
        if not safe_name.endswith(".zip"):
            return Response({"ok": False, "error": "Archivo inválido."}, status=400)
        target = self._backups_dir() / safe_name
        if not target.exists() or not target.is_file():
            return Response({"ok": False, "error": "Archivo no encontrado."}, status=404)
        from django.http import FileResponse

        resp = FileResponse(open(target, "rb"), as_attachment=True, filename=safe_name)
        resp["Content-Type"] = "application/zip"
        return resp


class AdminImageUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _get_rol_codigo(self, request) -> str:
        user = getattr(request, "user", None)
        if not user or not getattr(user, "is_authenticated", False):
            return ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario_rol ur
                JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE ur.usuario_id = %s
                ORDER BY CASE LOWER(COALESCE(r.codigo, ''))
                    WHEN 'admin' THEN 1
                    WHEN 'secretaria' THEN 2
                    WHEN 'barbero' THEN 3
                    WHEN 'cliente' THEN 4
                    ELSE 99
                END
                LIMIT 1
                """,
                [user.id],
            )
            row = cursor.fetchone()
            return (row[0] if row and row[0] else "").strip().lower()

    def _is_secretaria(self, request) -> bool:
        return self._get_rol_codigo(request) == "secretaria"

    def _is_admin_or_secretaria(self, request) -> bool:
        return self._is_admin(request) or self._is_secretaria(request)

    def post(self, request):
        if not self._is_admin_or_secretaria(request):
            return Response({"detail": "No autorizado."}, status=403)

        cloud_name = config("CLOUDINARY_CLOUD_NAME", default="").strip()
        api_key = config("CLOUDINARY_API_KEY", default="").strip()
        api_secret = config("CLOUDINARY_API_SECRET", default="").strip()
        if not cloud_name or not api_key or not api_secret:
            return Response({"ok": False, "error": "Faltan variables CLOUDINARY_* en el entorno del backend."}, status=500)

        cloudinary.config(
            cloud_name=cloud_name,
            api_key=api_key,
            api_secret=api_secret,
            secure=True,
        )

        folder = str(request.data.get("folder", "barberia") or "barberia").strip() or "barberia"
        image_file = request.FILES.get("image")
        image_data = request.data.get("image")

        if not image_file and not image_data:
            return Response({"ok": False, "error": "Debes enviar una imagen en el campo 'image'."}, status=400)

        try:
            if image_file:
                if not is_allowed_image_upload(image_file):
                    return Response({"ok": False, "error": "El archivo debe ser una imagen válida (JPG, PNG, WebP, HEIC, etc.)."}, status=400)
                if int(getattr(image_file, "size", 0) or 0) > 5 * 1024 * 1024:
                    return Response({"ok": False, "error": "La imagen supera el límite de 5 MB."}, status=400)
                result = cloudinary.uploader.upload(
                    image_file,
                    folder=f"stylo-barber/{folder}",
                    resource_type="image",
                    overwrite=False,
                )
            else:
                image_str = str(image_data or "").strip()
                if not image_str:
                    return Response({"ok": False, "error": "Imagen inválida."}, status=400)
                result = cloudinary.uploader.upload(
                    image_str,
                    folder=f"stylo-barber/{folder}",
                    resource_type="image",
                    overwrite=False,
                )

            return Response(
                {
                    "ok": True,
                    "url": result.get("secure_url") or result.get("url") or "",
                    "public_id": result.get("public_id"),
                }
            )
        except Exception as exc:
            return Response({"ok": False, "error": f"No se pudo subir la imagen: {exc}"}, status=502)


class AdminLogoUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        logo_file = request.FILES.get("logo")
        if not logo_file:
            return Response({"detail": "Debes enviar un archivo en el campo 'logo'."}, status=400)

        if not is_allowed_image_upload(logo_file):
            return Response({"detail": "El archivo debe ser una imagen valida (JPG, PNG, WebP, HEIC, etc.)."}, status=400)

        # Limite simple de 5 MB para evitar cargas excesivas.
        if getattr(logo_file, "size", 0) > 5 * 1024 * 1024:
            return Response({"detail": "La imagen supera el limite de 5 MB."}, status=400)

        cloud_name = config("CLOUDINARY_CLOUD_NAME", default="").strip()
        api_key = config("CLOUDINARY_API_KEY", default="").strip()
        api_secret = config("CLOUDINARY_API_SECRET", default="").strip()

        if not cloud_name or not api_key or not api_secret:
            return Response(
                {"detail": "Faltan variables CLOUDINARY_* en el entorno del backend."},
                status=500,
            )

        cloudinary.config(
            cloud_name=cloud_name,
            api_key=api_key,
            api_secret=api_secret,
            secure=True,
        )

        try:
            result = cloudinary.uploader.upload(
                logo_file,
                folder="stylo-barber/logo",
                resource_type="image",
                overwrite=True,
            )
            return Response(
                {
                    "logo_url": result.get("secure_url") or result.get("url") or "",
                    "public_id": result.get("public_id"),
                }
            )
        except Exception as exc:
            return Response({"detail": f"No se pudo subir el logo a Cloudinary: {exc}"}, status=502)


class AdminRespaldoDBView(APIView):
    permission_classes = [IsAuthenticated]

    ALLOWED_EXPORT_SCHEMAS = {"negocio", "stg", "rpt"}

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def _is_valid_identifier(self, value: str) -> bool:
        return bool(re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", value or ""))

    def _format_bytes(self, value: int | None) -> str:
        size = int(value or 0)
        units = ["B", "KB", "MB", "GB", "TB"]
        idx = 0
        size_float = float(size)
        while size_float >= 1024 and idx < len(units) - 1:
            size_float /= 1024.0
            idx += 1
        if idx == 0:
            return f"{int(size_float)} {units[idx]}"
        return f"{size_float:.2f} {units[idx]}"

    def _listar_respaldos(self) -> list[dict[str, Any]]:
        # Mantener compatible: si la tabla no existe, regresamos vacío.
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        nombre_archivo,
                        COALESCE(tamano_bytes, 0) AS size_bytes,
                        fecha_generacion
                    FROM negocio.respaldo_bd
                    ORDER BY fecha_generacion DESC
                    LIMIT 50
                    """
                )
                rows = cursor.fetchall() or []
        except Exception:
            return []

        items: list[dict[str, Any]] = []
        for nombre_archivo, size_bytes, fecha_generacion in rows:
            fecha_iso = None
            try:
                if fecha_generacion and hasattr(fecha_generacion, "isoformat"):
                    fecha_iso = fecha_generacion.isoformat()
            except Exception:
                fecha_iso = None
            items.append(
                {
                    "archivo": str(nombre_archivo or ""),
                    "size_bytes": int(size_bytes or 0),
                    "size_humano": self._format_bytes(int(size_bytes or 0)),
                    "fecha": fecha_iso,
                }
            )
        return items

    def _get_status(self) -> dict[str, Any]:
        with connection.cursor() as cursor:
            cursor.execute("SELECT version(), current_database()")
            row = cursor.fetchone() or ["PostgreSQL", ""]
            version_txt = str(row[0] or "PostgreSQL")
            db_name = str(row[1] or "")

            cursor.execute("SELECT pg_database_size(current_database())")
            size_row = cursor.fetchone() or [0]
            db_size = int(size_row[0] or 0)

        respaldos = self._listar_respaldos()
        ultima_ejecucion = respaldos[0]["fecha"] if respaldos and respaldos[0].get("fecha") else None
        pg_dump_bin = shutil.which("pg_dump") or ""
        pg_dumpall_bin = shutil.which("pg_dumpall") or ""
        return {
            "ok": True,
            "db_vendor": "PostgreSQL",
            "db_version": version_txt,
            "db_name": db_name,
            "db_size_bytes": db_size,
            "db_size_humano": self._format_bytes(db_size),
            "ultima_ejecucion": ultima_ejecucion,
            "respaldos": respaldos[:50],
            "pg_dump_disponible": bool(pg_dump_bin),
            "pg_dumpall_disponible": bool(pg_dumpall_bin),
            "respaldo_completo_soportado": bool(pg_dump_bin),
        }

    def _list_tables(self, schema_filter: str | None = None) -> list[dict[str, Any]]:
        with connection.cursor() as cursor:
            if schema_filter:
                cursor.execute(
                    """
                    SELECT
                        t.table_schema,
                        t.table_name,
                        COALESCE(s.n_live_tup::bigint, 0) AS rows_est
                    FROM information_schema.tables t
                    LEFT JOIN pg_stat_user_tables s
                      ON s.schemaname = t.table_schema
                     AND s.relname = t.table_name
                    WHERE t.table_type = 'BASE TABLE'
                      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
                      AND t.table_schema = %s
                    ORDER BY t.table_schema ASC, t.table_name ASC
                    """,
                    [schema_filter],
                )
            else:
                cursor.execute(
                    """
                    SELECT
                        t.table_schema,
                        t.table_name,
                        COALESCE(s.n_live_tup::bigint, 0) AS rows_est
                    FROM information_schema.tables t
                    LEFT JOIN pg_stat_user_tables s
                      ON s.schemaname = t.table_schema
                     AND s.relname = t.table_name
                    WHERE t.table_type = 'BASE TABLE'
                      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY t.table_schema ASC, t.table_name ASC
                    """
                )
            rows = cursor.fetchall() or []

        return [{"schema": str(r[0]), "table": str(r[1]), "rows_est": int(r[2] or 0)} for r in rows]

    def _backups_dir(self) -> Path:
        root = Path(getattr(settings, "BASE_DIR", Path.cwd()))
        backups_dir = root / "respaldos_db"
        backups_dir.mkdir(parents=True, exist_ok=True)
        return backups_dir

    def _dump_table_to_csv(self, schema_name: str, table_name: str) -> bytes:
        query_select = SQL("SELECT * FROM {}.{}").format(Identifier(schema_name), Identifier(table_name))
        query_copy = SQL("COPY (SELECT * FROM {}.{}) TO STDOUT WITH CSV HEADER").format(
            Identifier(schema_name), Identifier(table_name)
        )
        with connection.cursor() as cursor:
            output = io.StringIO()
            if hasattr(cursor, "copy_expert"):
                cursor.copy_expert(str(query_copy), output)
                return output.getvalue().encode("utf-8-sig")
            cursor.execute(query_select)
            writer = csv.writer(output)
            headers = [col[0] for col in (cursor.description or [])]
            if headers:
                writer.writerow(headers)
            while True:
                chunk = cursor.fetchmany(2000)
                if not chunk:
                    break
                writer.writerows(chunk)
            return output.getvalue().encode("utf-8-sig")

    def _count_table_rows(self, schema_name: str, table_name: str) -> int:
        query = SQL("SELECT COUNT(*) FROM {}.{}").format(Identifier(schema_name), Identifier(table_name))
        with connection.cursor() as cursor:
            cursor.execute(query)
            return int((cursor.fetchone() or [0])[0] or 0)

    def _count_table_columns(self, schema_name: str, table_name: str) -> int:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = %s
                  AND table_name = %s
                """,
                [schema_name, table_name],
            )
            return int((cursor.fetchone() or [0])[0] or 0)

    def _db_conn_params(self) -> dict[str, str]:
        db = (getattr(settings, "DATABASES", {}) or {}).get("default", {}) or {}
        return {
            "engine": str(db.get("ENGINE", "") or ""),
            "name": str(db.get("NAME", "") or ""),
            "user": str(db.get("USER", "") or ""),
            "password": str(db.get("PASSWORD", "") or ""),
            "host": str(db.get("HOST", "") or ""),
            "port": str(db.get("PORT", "") or ""),
        }

    def _pg_subprocess_env(self, conn: dict[str, str]) -> dict[str, str]:
        """
        Entorno para pg_dump / pg_dumpall (PGPASSWORD).

        PGOPTIONS con search_path está desactivado por defecto: en algunos hosts
        (p. ej. Neon/pooler) puede hacer fallar la conexión del cliente libpq.
        Las tablas del respaldo lógico van con -t esquema.tabla explícito.
        Activa con PG_DUMP_PGOPTIONS_SEARCH_PATH=True en .env si lo necesitas.
        """
        env = os.environ.copy()
        if conn.get("password"):
            env["PGPASSWORD"] = conn["password"]
        if config("PG_DUMP_PGOPTIONS_SEARCH_PATH", default=False, cast=bool):
            sp = "private,public,negocio,stg,rpt"
            prev = (env.get("PGOPTIONS") or "").strip()
            env["PGOPTIONS"] = (f"-c search_path={sp}" + (f" {prev}" if prev else "")).strip()
        return env

    @staticmethod
    def _pg_dump_run(cmd: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3600,
        )

    def _backup_row_counts(self, qualified_tables: list[str]) -> tuple[list[dict[str, Any]], int]:
        """Filas por tabla usando la conexión Django (misma BD y search_path que la app)."""
        out: list[dict[str, Any]] = []
        total = 0
        for full in qualified_tables:
            parts = str(full or "").split(".", 1)
            if len(parts) != 2:
                continue
            schema_name, table_name = parts[0].strip().lower(), parts[1].strip().lower()
            if not self._is_valid_identifier(schema_name) or not self._is_valid_identifier(table_name):
                continue
            n = -1
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        SQL("SELECT COUNT(*) FROM {}.{}").format(
                            Identifier(schema_name),
                            Identifier(table_name),
                        )
                    )
                    n = int((cursor.fetchone() or [0])[0] or 0)
            except Exception:
                n = -1
            out.append({"tabla": f"{schema_name}.{table_name}", "filas": n})
            if n >= 0:
                total += n
        return out, total

    def _build_pg_base_args(self, conn: dict[str, str]) -> list[str]:
        args: list[str] = []
        if conn.get("host"):
            args += ["-h", conn["host"]]
        if conn.get("port"):
            args += ["-p", conn["port"]]
        if conn.get("user"):
            args += ["-U", conn["user"]]
        return args

    def _file_response_zip_delete_after(self, zip_path: Path, zip_name: str, size: int):
        """Sirve el ZIP desde disco y borra el temporal al cerrar el descriptor (evita duplicar el ZIP en RAM)."""
        from django.http import FileResponse

        fh = open(zip_path, "rb")
        real_close = fh.close

        def close_and_unlink() -> None:
            real_close()
            try:
                zip_path.unlink(missing_ok=True)
            except OSError:
                pass

        fh.close = close_and_unlink  # type: ignore[method-assign]
        resp = FileResponse(fh, content_type="application/zip", as_attachment=True, filename=zip_name)
        resp["Content-Length"] = str(size)
        return resp

    def _crear_respaldo_completo_zip(self) -> tuple[Path, str, int]:
        if not shutil.which("pg_dump"):
            raise RuntimeError(
                "No se encontró pg_dump en el servidor. En Render: añade en build.sh "
                "`apt-get update && apt-get install -y postgresql-client` o despliega con el Dockerfile del repo "
                "(incluye postgresql-client)."
            )
        conn = self._db_conn_params()
        if "postgresql" not in conn.get("engine", "").lower():
            raise RuntimeError("El respaldo completo solo está soportado para PostgreSQL.")
        if not conn.get("name"):
            raise RuntimeError("No se pudo resolver el nombre de la base de datos para el respaldo.")

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_name = f"respaldo_completo_{ts}.zip"

        env = self._pg_subprocess_env(conn)

        work = Path(tempfile.mkdtemp(prefix="stylo_backup_"))
        out_path: Path | None = None
        try:
            dump_file = work / f"db_full_{ts}.dump"
            globals_file = work / f"roles_usuarios_{ts}.sql"

            cmd_dump = [
                "pg_dump",
                *self._build_pg_base_args(conn),
                "-d",
                conn["name"],
                "-F",
                "c",
                "-b",
                "-v",
                "--no-owner",
                "--no-privileges",
                "-f",
                str(dump_file),
            ]
            proc_dump = self._pg_dump_run(cmd_dump, env)
            if proc_dump.returncode != 0 or not dump_file.exists():
                err = (proc_dump.stderr or proc_dump.stdout or "").strip()
                raise RuntimeError(f"No se pudo generar el dump completo con pg_dump: {err or 'error desconocido'}")

            globals_ok = False
            globals_warning = ""
            if shutil.which("pg_dumpall"):
                cmd_globals = [
                    "pg_dumpall",
                    *self._build_pg_base_args(conn),
                    "--globals-only",
                    "-f",
                    str(globals_file),
                ]
                proc_globals = self._pg_dump_run(cmd_globals, env)
                globals_ok = proc_globals.returncode == 0 and globals_file.exists()
                if not globals_ok:
                    err = (proc_globals.stderr or proc_globals.stdout or "").strip()
                    globals_warning = err or "pg_dumpall no pudo volcar roles (omitido en BD administradas)."
                    if globals_file.exists():
                        try:
                            globals_file.unlink()
                        except OSError:
                            pass
            else:
                globals_warning = "pg_dumpall no está instalado; el ZIP solo incluye el dump de la base."

            dump_bytes = int(dump_file.stat().st_size) if dump_file.exists() else 0
            zip_work = work / zip_name
            with zipfile.ZipFile(zip_work, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(dump_file, arcname=dump_file.name)
                if globals_ok:
                    zf.write(globals_file, arcname=globals_file.name)
                manifest = {
                    "generado_en": datetime.now(timezone.utc).isoformat(),
                    "motor": "PostgreSQL",
                    "tipo": "completo",
                    "incluye": [
                        "estructura",
                        "datos",
                        "indices",
                        "triggers",
                        "funciones",
                        "secuencias",
                    ],
                    "roles_usuarios_incluidos": globals_ok,
                    "metricas": {
                        "archivo_dump_custom_bytes": dump_bytes,
                        "nota": "El formato -Fc es binario y comprimido; tamaños pequeños son normales si hay pocas filas.",
                    },
                }
                if globals_warning:
                    manifest["roles_usuarios_advertencia"] = globals_warning
                if dump_bytes < 12_000:
                    manifest.setdefault("metricas", {})["advertencia"] = (
                        "Dump completo muy pequeño: suele indicar BD casi vacía, otra DATABASE_URL que la de la app, "
                        "o revisar panel Neon/Render (rama correcta)."
                    )
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

            fd, pathname = tempfile.mkstemp(prefix="stylo_full_", suffix=".zip")
            os.close(fd)
            out_path = Path(pathname)
            shutil.copy2(zip_work, out_path)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        if out_path is None or not out_path.is_file():
            raise RuntimeError("No se pudo materializar el archivo ZIP de respaldo.")
        size = int(out_path.stat().st_size)
        return out_path, zip_name, size

    def _logical_backup_table_sets(self) -> dict[str, list[str]]:
        return {
            "citas": [
                "negocio.cita",
                "negocio.cita_estado_historial",
                "negocio.anticipo_cita",
                "negocio.estado_cita",
                "negocio.metodo_pago_catalogo",
                "negocio.usuario",
                "negocio.empleado",
                "negocio.servicio",
            ],
            "compras": [
                "negocio.pedido",
                "negocio.pedido_item",
                "negocio.pedido_estado_historial",
                "negocio.estado_pedido",
                "negocio.metodo_entrega",
                "negocio.metodo_pago_catalogo",
                "negocio.direccion_usuario",
                "negocio.usuario",
                "negocio.producto",
            ],
            "inventario": [
                "negocio.producto",
                "negocio.producto_imagen",
                "negocio.marca",
                "negocio.categoria_producto",
                "negocio.inventario_existencia",
                "negocio.inventario_movimiento",
                "negocio.tipo_movimiento_inventario",
                "negocio.empleado",
            ],
            "servicios": [
                "negocio.servicio",
                "negocio.servicio_imagen",
                "negocio.categoria_servicio",
                "negocio.tipo_rostro",
                "negocio.estilo_recomendado",
                "negocio.servicio_tipo_rostro",
                "negocio.servicio_estilo",
                "negocio.barbero_servicio",
                "negocio.empleado",
            ],
        }

    def _crear_respaldo_logico_zip(self, kind: str) -> tuple[Path, str, int]:
        if not shutil.which("pg_dump"):
            raise RuntimeError(
                "No se encontró pg_dump en el servidor. Instala postgresql-client en la imagen o build de Render."
            )
        conn = self._db_conn_params()
        if "postgresql" not in conn.get("engine", "").lower():
            raise RuntimeError("El respaldo lógico solo está soportado para PostgreSQL.")
        if not conn.get("name"):
            raise RuntimeError("No se pudo resolver el nombre de la base de datos para el respaldo.")

        sets = self._logical_backup_table_sets()
        if kind not in sets:
            raise RuntimeError("Tipo de respaldo lógico inválido.")

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_name = f"respaldo_logico_{kind}_{ts}.zip"

        env = self._pg_subprocess_env(conn)
        filas_info, filas_total = self._backup_row_counts(sets[kind])

        work = Path(tempfile.mkdtemp(prefix="stylo_backup_logic_"))
        out_path: Path | None = None
        try:
            dump_file = work / f"db_logic_{kind}_{ts}.dump"

            table_args: list[str] = []
            for full in sets[kind]:
                table_args += ["-t", full]

            cmd_dump = [
                "pg_dump",
                *self._build_pg_base_args(conn),
                "-d",
                conn["name"],
                "-F",
                "c",
                "-b",
                "-v",
                "--no-owner",
                "--no-privileges",
                *table_args,
                "-f",
                str(dump_file),
            ]
            proc_dump = self._pg_dump_run(cmd_dump, env)
            if proc_dump.returncode != 0 or not dump_file.exists():
                err = (proc_dump.stderr or proc_dump.stdout or "").strip()
                raise RuntimeError(f"No se pudo generar el dump lógico con pg_dump: {err or 'error desconocido'}")

            dump_bytes = int(dump_file.stat().st_size)
            zip_work = work / zip_name
            with zipfile.ZipFile(zip_work, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(dump_file, arcname=dump_file.name)
                metricas: dict[str, Any] = {
                    "archivo_dump_custom_bytes": dump_bytes,
                    "filas_por_tabla": filas_info,
                    "filas_totales_contadas": filas_total,
                }
                adv: list[str] = []
                if any(int(r.get("filas", 0) or 0) < 0 for r in filas_info):
                    adv.append("No se pudo leer el conteo en al menos una tabla (permisos o tabla inexistente).")
                known_counts = [r for r in filas_info if int(r.get("filas", -1) or -1) >= 0]
                if known_counts and all(int(r["filas"]) == 0 for r in known_counts):
                    adv.append(
                        "Todas las tablas del módulo tienen 0 filas en esta BD: el ZIP pequeño es coherente con datos vacíos."
                    )
                elif filas_total > 0 and dump_bytes < 2048:
                    adv.append(
                        "Hay filas contadas en BD pero el dump es muy pequeño: revisa que pg_dump use la misma DATABASE_URL "
                        "y el mismo host que el backend."
                    )
                if adv:
                    metricas["advertencias"] = adv
                manifest = {
                    "generado_en": datetime.now(timezone.utc).isoformat(),
                    "motor": "PostgreSQL",
                    "tipo": "logico",
                    "modulo": kind,
                    "tablas": sets[kind],
                    "metricas": metricas,
                }
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

            fd, pathname = tempfile.mkstemp(prefix="stylo_logic_", suffix=".zip")
            os.close(fd)
            out_path = Path(pathname)
            shutil.copy2(zip_work, out_path)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        if out_path is None or not out_path.is_file():
            raise RuntimeError("No se pudo materializar el archivo ZIP de respaldo lógico.")
        size = int(out_path.stat().st_size)
        return out_path, zip_name, size

    def _registrar_respaldo_historial(self, request, nombre_archivo: str, size_bytes: int) -> None:
        try:
            user_id = getattr(getattr(request, "user", None), "id", None)
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO negocio.respaldo_bd (nombre_archivo, motor, tamano_bytes, generado_por, descarga_url, fecha_generacion)
                    VALUES (%s, %s, %s, %s, %s, NOW())
                    """,
                    [nombre_archivo, "PostgreSQL", int(size_bytes or 0), user_id, None],
                )
        except Exception:
            return

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        action = str(request.GET.get("action", "status") or "status").strip().lower()
        try:
            if action == "status":
                return Response(self._get_status())
            if action == "tables":
                schema_name = str(request.GET.get("schema", "") or "").strip().lower()
                if schema_name and not self._is_valid_identifier(schema_name):
                    return Response({"ok": False, "error": "Esquema inválido."}, status=400)
                if schema_name and schema_name not in self.ALLOWED_EXPORT_SCHEMAS:
                    return Response({"ok": False, "error": "Esquema no permitido."}, status=400)
                tables = self._list_tables(schema_name or None)
                return Response({"ok": True, "tables": tables})
            return Response({"ok": False, "error": "Acción no soportada."}, status=400)
        except DatabaseError as exc:
            return db_structure_error_response(exc)
        except Exception as exc:
            return Response({"ok": False, "error": str(exc)}, status=500)

    def post(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        action = str(data.get("action", "") or "").strip().lower()
        if action not in {"create_backup", "create_backup_full", "create_backup_logical", "create_backup_tables", "export_csv"}:
            return Response({"ok": False, "error": "Acción inválida."}, status=400)

        if action == "export_csv":
            schema_name = str(data.get("schema", "") or "").strip().lower()
            table_name = str(data.get("table", "") or "").strip().lower()
            if not self._is_valid_identifier(schema_name) or not self._is_valid_identifier(table_name):
                return Response({"ok": False, "error": "Esquema o tabla inválidos."}, status=400)
            if schema_name not in self.ALLOWED_EXPORT_SCHEMAS:
                return Response({"ok": False, "error": "Esquema no permitido para exportación."}, status=400)
            try:
                content = self._dump_table_to_csv(schema_name, table_name)
                row_count = self._count_table_rows(schema_name, table_name)
                column_count = self._count_table_columns(schema_name, table_name)
            except DatabaseError as exc:
                return db_structure_error_response(exc)
            filename = f"{schema_name}.{table_name}.csv"
            return Response(
                {
                    "ok": True,
                    "filename": filename,
                    "row_count": row_count,
                    "column_count": column_count,
                    "content_base64": base64.b64encode(content).decode("ascii"),
                }
            )

        if action in {"create_backup", "create_backup_full"}:
            try:
                zip_path, zip_name, size = self._crear_respaldo_completo_zip()
                self._registrar_respaldo_historial(request, zip_name, size)
                return self._file_response_zip_delete_after(zip_path, zip_name, size)
            except RuntimeError as exc:
                return Response({"ok": False, "error": str(exc)}, status=500)
            except Exception as exc:
                logger.exception("respaldo BD completo")
                return Response(
                    {"ok": False, "error": f"No se pudo completar el respaldo: {exc}"},
                    status=500,
                )

        if action == "create_backup_logical":
            kind = str(data.get("kind", "") or "").strip().lower()
            try:
                zip_path, zip_name, size = self._crear_respaldo_logico_zip(kind)
                self._registrar_respaldo_historial(request, zip_name, size)
                return self._file_response_zip_delete_after(zip_path, zip_name, size)
            except RuntimeError as exc:
                return Response({"ok": False, "error": str(exc)}, status=500)
            except Exception as exc:
                logger.exception("respaldo BD lógico kind=%s", kind)
                return Response(
                    {"ok": False, "error": f"No se pudo completar el respaldo lógico: {exc}"},
                    status=500,
                )

        include_tables = data.get("tables", [])
        selected: list[tuple[str, str]] = []
        if isinstance(include_tables, list) and include_tables:
            for item in include_tables:
                if not isinstance(item, dict):
                    continue
                schema_name = str(item.get("schema", "") or "").strip().lower()
                table_name = str(item.get("table", "") or "").strip().lower()
                if not self._is_valid_identifier(schema_name) or not self._is_valid_identifier(table_name):
                    continue
                if schema_name not in self.ALLOWED_EXPORT_SCHEMAS:
                    continue
                selected.append((schema_name, table_name))
        else:
            schema_filter = str(data.get("schema", "") or "").strip().lower()
            if schema_filter and not self._is_valid_identifier(schema_filter):
                return Response({"ok": False, "error": "Esquema inválido."}, status=400)
            for t in self._list_tables(schema_filter or None):
                schema_name = str(t["schema"])
                table_name = str(t["table"])
                if schema_name in self.ALLOWED_EXPORT_SCHEMAS:
                    selected.append((schema_name, table_name))

        selected = list(dict.fromkeys(selected))
        if not selected:
            return Response({"ok": False, "error": "No hay tablas seleccionadas para respaldar."}, status=400)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_name = f"respaldo_bd_{ts}.zip"
        zip_path = self._backups_dir() / zip_name

        try:
            with zipfile.ZipFile(zip_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                manifest = {
                    "generado_en": datetime.now(timezone.utc).isoformat(),
                    "motor": "PostgreSQL",
                    "tablas": [f"{s}.{t}" for s, t in selected],
                }
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

                for schema_name, table_name in selected:
                    csv_bytes = self._dump_table_to_csv(schema_name, table_name)
                    zf.writestr(f"{schema_name}.{table_name}.csv", csv_bytes)

            return Response(
                {
                    "ok": True,
                    "mensaje": "Respaldo generado correctamente.",
                    "archivo": zip_name,
                    "size_bytes": zip_path.stat().st_size,
                    "size_humano": self._format_bytes(zip_path.stat().st_size),
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)
        except Exception as exc:
            return Response({"ok": False, "error": f"No se pudo generar el respaldo: {exc}"}, status=500)


class AdminMonitoreoBDView(APIView):
    permission_classes = [IsAuthenticated]

    def _is_admin(self, request) -> bool:
        return bool(request.user and request.user.is_authenticated and (request.user.is_staff or request.user.is_superuser))

    def get(self, request):
        if not self._is_admin(request):
            return Response({"detail": "No autorizado."}, status=403)
        try:
            start = datetime.now(timezone.utc)
            with connection.cursor() as cursor:
                cursor.execute("SELECT version()")
                version_row = cursor.fetchone() or ["PostgreSQL"]
                motor = str(version_row[0] or "PostgreSQL")

                cursor.execute("SELECT NOW()")
                now_row = cursor.fetchone() or [None]
                raw_now = now_row[0] if now_row else None
                ts = raw_now.isoformat() if raw_now is not None and hasattr(raw_now, "isoformat") else None

                # Latencia backend->BD (ms): tiempo de roundtrip de esta consulta.
                # Nota: esto mide latencia+overhead local, pero sirve como señal.
                latency_ms = max(0, int((datetime.now(timezone.utc) - start).total_seconds() * 1000))

                # Conexiones actuales + máximo configurado.
                cursor.execute("SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()")
                conns_row = cursor.fetchone() or [0]
                conexiones = int(conns_row[0] or 0)
                conexiones_max = 100
                try:
                    cursor.execute("SELECT COALESCE(current_setting('max_connections', true), '100')")
                    conexiones_max = int((cursor.fetchone() or ["100"])[0] or 100)
                except Exception:
                    conexiones_max = 100

                # Ops/s aproximadas desde pg_stat_database (desde reset).
                ops_seg = 0
                cache_hit = 0
                bloqueos = 0
                try:
                    cursor.execute(
                        """
                        SELECT
                          COALESCE(xact_commit,0) + COALESCE(xact_rollback,0) AS xacts,
                          COALESCE(blks_hit,0) AS hit,
                          COALESCE(blks_read,0) AS read,
                          stats_reset
                        FROM pg_stat_database
                        WHERE datname = current_database()
                        LIMIT 1
                        """
                    )
                    row = cursor.fetchone() or [0, 0, 0, None]
                    xacts = int(row[0] or 0)
                    hit = int(row[1] or 0)
                    read = int(row[2] or 0)
                    reset_at = row[3]
                    denom = hit + read
                    cache_hit = int(round((hit / denom) * 100)) if denom > 0 else 0
                    if reset_at and hasattr(reset_at, "timestamp"):
                        seconds = max(1.0, (datetime.now(timezone.utc) - reset_at).total_seconds())
                        ops_seg = int(round(xacts / seconds))
                except Exception:
                    ops_seg = 0
                    cache_hit = 0

                # Bloqueos activos (locks no concedidos o locks pesados).
                try:
                    cursor.execute("SELECT COUNT(*) FROM pg_locks WHERE granted = FALSE")
                    bloqueos = int((cursor.fetchone() or [0])[0] or 0)
                except Exception:
                    bloqueos = 0

                # Tabla stats (top por lecturas/escrituras). Incluye estimación de filas.
                tablas: list[dict[str, Any]] = []
                try:
                    cursor.execute(
                        """
                        SELECT
                          schemaname,
                          relname,
                          COALESCE(n_live_tup,0) AS filas,
                          COALESCE(idx_scan,0) + COALESCE(seq_scan,0) AS lecturas,
                          COALESCE(n_tup_ins,0) + COALESCE(n_tup_upd,0) + COALESCE(n_tup_del,0) AS escrituras
                        FROM pg_stat_user_tables
                        ORDER BY (COALESCE(idx_scan,0) + COALESCE(seq_scan,0)) DESC, relname ASC
                        LIMIT 120
                        """
                    )
                    for schemaname, relname, filas, lecturas, escrituras in cursor.fetchall() or []:
                        tablas.append(
                            {
                                "tabla": str(relname or ""),
                                "esquema": str(schemaname or ""),
                                "filas": int(filas or 0),
                                "lecturas": int(lecturas or 0),
                                "escrituras": int(escrituras or 0),
                            }
                        )
                except Exception:
                    tablas = []

                # Salud: conectividad, replication, vacuum pendiente, cache hit, bloqueos.
                salud: list[dict[str, Any]] = []
                salud.append({"label": "Conectividad", "valor": "OK", "estado": "ok"})

                try:
                    cursor.execute("SELECT COUNT(*) FROM pg_stat_replication")
                    repl = int((cursor.fetchone() or [0])[0] or 0)
                    salud.append({"label": "Replicación", "valor": f"{repl} réplica(s)", "estado": "ok" if repl > 0 else "warn"})
                except Exception:
                    salud.append({"label": "Replicación", "valor": "No disponible", "estado": "warn"})

                # Vacuum pendiente: tablas con dead tuples grandes (señal).
                try:
                    cursor.execute(
                        """
                        SELECT COUNT(*)
                        FROM pg_stat_user_tables
                        WHERE COALESCE(n_dead_tup,0) > 5000
                        """
                    )
                    vac = int((cursor.fetchone() or [0])[0] or 0)
                    salud.append({"label": "Vacuum pendiente", "valor": f"{vac} tabla(s)", "estado": "warn" if vac > 0 else "ok"})
                except Exception:
                    salud.append({"label": "Vacuum pendiente", "valor": "No disponible", "estado": "warn"})

                salud.append({"label": "Cache hit", "valor": f"{cache_hit}%", "estado": "ok" if cache_hit >= 95 else "warn"})
                salud.append({"label": "Bloqueos largos", "valor": f"{bloqueos}" if bloqueos else "Ninguno", "estado": "warn" if bloqueos else "ok"})

                # Logs: intenta pg_stat_statements (si existe). Si no, devuelve vacío.
                logs: list[dict[str, Any]] = []
                try:
                    cursor.execute(
                        """
                        SELECT
                          to_char(now(), 'HH24:MI:SS') AS hora,
                          current_schema() AS esquema,
                          LEFT(replace(regexp_replace(query, '\\s+', ' ', 'g'), '\"', ''), 180) AS operacion,
                          GREATEST(0, ROUND(mean_exec_time))::int AS duracion_ms
                        FROM pg_stat_statements
                        ORDER BY mean_exec_time DESC
                        LIMIT 30
                        """
                    )
                    for hora, esquema, operacion, duracion_ms in cursor.fetchall() or []:
                        logs.append(
                            {
                                "hora": str(hora or ""),
                                "esquema": str(esquema or ""),
                                "operacion": str(operacion or ""),
                                "duracion_ms": int(duracion_ms or 0),
                            }
                        )
                except Exception:
                    logs = []

            # Respuesta compatible con el frontend actual (monitoreo-bd.component.ts)
            return Response(
                {
                    "ok": True,
                    "motor": motor,
                    "latencia_ms": latency_ms,
                    "conexiones": conexiones,
                    "conexiones_max": conexiones_max,
                    "ops_seg": ops_seg,
                    "cache_hit": cache_hit,
                    "bloqueos": bloqueos,
                    "tablas": tablas,
                    "salud": salud,
                    "logs": logs,
                    "ts": ts,
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)
        except Exception as exc:
            return Response({"ok": False, "error": str(exc)}, status=500)

