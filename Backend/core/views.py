from django.contrib.auth import get_user_model
from django.contrib.auth import authenticate
from django.contrib.auth.hashers import make_password
from datetime import date, datetime
from django.db import connection
from django.db import transaction
from django.utils import timezone
from django.core import signing
from django.core.cache import cache
from django.conf import settings
from django.db.utils import DatabaseError
from django.utils.crypto import constant_time_compare
from rest_framework.permissions import IsAuthenticated
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from core.timezone_mx import combine_fecha_hora_mx, sql_citas_ocupadas_dia
from rest_framework.views import APIView
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.throttling import SimpleRateThrottle
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework_simplejwt.tokens import RefreshToken
from core.mail_utils import build_otp_email_pair, send_stylo_transactional
from core.upload_utils import is_allowed_image_upload
import random
import secrets
import json
import re
import hashlib
import hmac
import logging
import base64
import time
import cloudinary
import cloudinary.uploader
from cryptography.fernet import Fernet, InvalidToken
from decouple import config
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

logger = logging.getLogger(__name__)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    ROLE_MAP_DB_TO_FRONT = {
        "administrador": "admin",
        "admin": "admin",
        "barbero": "barbero",
        "secretaria": "secretaria",
        "cliente": "cliente",
    }

    def _get_front_role(self, request_user) -> str:
        # Prioriza el rol de negocio (tablas negocio.usuario / negocio.usuario_rol / negocio.rol).
        # Si no se puede resolver, usa fallback por flags Django para no romper login.
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT r.codigo
                    FROM negocio.usuario u
                    LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE LOWER(u.username) = LOWER(%s) OR LOWER(u.email) = LOWER(%s)
                    ORDER BY
                        CASE
                            WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'barbero' THEN 3
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'cliente' THEN 4
                            ELSE 99
                        END
                    LIMIT 1
                    """,
                    [request_user.username, request_user.email],
                )
                row = cursor.fetchone()
            if row and row[0]:
                return self.ROLE_MAP_DB_TO_FRONT.get(str(row[0]).strip().lower(), "cliente")
        except Exception:
            pass

        if request_user.is_superuser or request_user.is_staff:
            return "admin"
        return "cliente"

    def get(self, request):
        rol = self._get_front_role(request.user)
        return Response(
            {
                "id": request.user.id,
                "username": request.user.username,
                "email": request.user.email,
                "is_staff": request.user.is_staff,
                "is_superuser": request.user.is_superuser,
                "rol": rol,
                "is_authenticated": True,
            }
        )


class PerfilView(APIView):
    permission_classes = [IsAuthenticated]

    def _resolver_usuario_negocio_id(self, request) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') AND (LOWER(email) = LOWER(%s) AND %s <> '') THEN 1
                        WHEN (LOWER(email) = LOWER(%s) AND %s <> '') THEN 2
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') THEN 3
                        ELSE 99
                    END,
                    usuario_id DESC
                LIMIT 1
                """,
                [username, username, email, email, username, username, email, email, email, email, username, username],
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _direccion_texto(self, row: Any) -> str:
        if not row:
            return ""
        calle, numero_ext, numero_int, colonia, municipio, estado_geo, cp = row
        partes = [str(calle or "").strip()]
        if numero_ext:
            partes.append(f"#{str(numero_ext).strip()}")
        if numero_int:
            partes.append(f"Int {str(numero_int).strip()}")
        zona = ", ".join([str(x).strip() for x in [colonia, municipio, estado_geo] if x and str(x).strip()])
        if zona:
            partes.append(zona)
        if cp and str(cp).strip():
            partes.append(f"CP {str(cp).strip()}")
        return " - ".join([p for p in partes if p]).strip()

    def _perfil_cache_key(self, request) -> str:
        return f"perfil_api:v1:{request.user.pk}"

    def get(self, request):
        try:
            cache_key = self._perfil_cache_key(request)
            cached = cache.get(cache_key)
            if cached is not None:
                return Response(cached)

            usuario_id = self._resolver_usuario_negocio_id(request)
            if not usuario_id:
                return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)

            with connection.cursor() as cursor:
                # Una sola ida a BD: usuario + perfil + dirección principal (antes: 2 consultas).
                cursor.execute(
                    """
                    SELECT
                        u.email,
                        u.username,
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE(pp.telefono, ''),
                        pp.fecha_nacimiento,
                        COALESCE(pp.avatar_url, ''),
                        d.calle,
                        d.numero_ext,
                        d.numero_int,
                        d.colonia,
                        d.municipio,
                        d.estado_geo,
                        d.cp
                    FROM negocio.usuario u
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    LEFT JOIN negocio.direccion_usuario d
                        ON d.usuario_id = u.usuario_id
                       AND d.es_principal = TRUE
                    WHERE u.usuario_id = %s
                    ORDER BY d.direccion_id ASC NULLS LAST
                    LIMIT 1
                    """,
                    [usuario_id],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Perfil no encontrado."}, status=404)

                direccion_row = row[7:14]

            perfil = {
                "email": row[0] or "",
                "username": row[1] or "",
                "nombre": row[2] or "",
                "apellido": row[3] or "",
                "telefono": row[4] or "",
                "fecha_nacimiento": str(row[5]) if row[5] else "",
                "avatar_url": row[6] or "",
                "direccion": self._direccion_texto(direccion_row),
            }
            body = {"ok": True, "perfil": perfil}
            ttl = int(getattr(settings, "PERFIL_API_CACHE_SECONDS", 30) or 0)
            if ttl > 0:
                cache.set(cache_key, body, timeout=ttl)
            return Response(body)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo cargar el perfil."}, status=500)

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        nombre = str(data.get("nombre", "")).strip()
        apellido = str(data.get("apellido", "")).strip()
        telefono = re.sub(r"\D+", "", str(data.get("telefono", "") or ""))
        fecha_nacimiento_raw = str(data.get("fecha_nacimiento", "") or "").strip()
        direccion = str(data.get("direccion", "") or "").strip()
        avatar_url = str(data.get("avatar_url", "") or "").strip()

        if len(nombre) < 2:
            return Response({"ok": False, "error": "El nombre debe tener al menos 2 caracteres."}, status=400)
        if telefono and (len(telefono) < 10 or len(telefono) > 15):
            return Response({"ok": False, "error": "El teléfono debe tener entre 10 y 15 dígitos."}, status=400)

        fecha_nacimiento_val: date | None = None
        if fecha_nacimiento_raw:
            try:
                fecha_nacimiento_val = date.fromisoformat(fecha_nacimiento_raw)
            except ValueError:
                return Response({"ok": False, "error": "Fecha de nacimiento inválida (YYYY-MM-DD)."}, status=400)
            if fecha_nacimiento_val > timezone.localdate():
                return Response({"ok": False, "error": "La fecha de nacimiento no puede ser futura."}, status=400)

        try:
            usuario_id = self._resolver_usuario_negocio_id(request)
            if not usuario_id:
                return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)

            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO negocio.perfil_persona (
                            usuario_id, nombres, apellido_paterno, telefono, fecha_nacimiento, avatar_url
                        )
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (usuario_id) DO UPDATE SET
                            nombres = EXCLUDED.nombres,
                            apellido_paterno = EXCLUDED.apellido_paterno,
                            telefono = EXCLUDED.telefono,
                            fecha_nacimiento = EXCLUDED.fecha_nacimiento,
                            avatar_url = NULLIF(EXCLUDED.avatar_url, '')
                        """,
                        [usuario_id, nombre, apellido or None, telefono or None, fecha_nacimiento_val, avatar_url],
                    )

                    if direccion:
                        cursor.execute(
                            """
                            UPDATE negocio.direccion_usuario
                            SET es_principal = FALSE
                            WHERE usuario_id = %s
                            """,
                            [usuario_id],
                        )
                        cursor.execute(
                            """
                            INSERT INTO negocio.direccion_usuario (
                                usuario_id, calle, numero_ext, numero_int, colonia, municipio, estado_geo, cp, referencias, es_principal
                            )
                            VALUES (%s, %s, NULL, NULL, NULL, NULL, NULL, NULL, NULL, TRUE)
                            """,
                            [usuario_id, direccion],
                        )
                    else:
                        cursor.execute(
                            """
                            UPDATE negocio.direccion_usuario
                            SET es_principal = FALSE
                            WHERE usuario_id = %s
                            """,
                            [usuario_id],
                        )

            cache.delete(self._perfil_cache_key(request))
            return self.get(request)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo actualizar el perfil."}, status=500)


class PerfilCambiarContrasenaView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        actual = str(data.get("contrasena_actual", "") or "")
        nueva = str(data.get("nueva_contrasena", "") or "")

        if not actual or not nueva:
            return Response({"ok": False, "error": "Debes enviar contraseña actual y nueva."}, status=400)
        if len(nueva) < 8:
            return Response({"ok": False, "error": "La nueva contraseña debe tener al menos 8 caracteres."}, status=400)
        if actual == nueva:
            return Response({"ok": False, "error": "La nueva contraseña debe ser distinta a la actual."}, status=400)

        user_model = get_user_model()
        auth_user = user_model.objects.filter(pk=request.user.pk).first()
        if not auth_user:
            return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)
        if not auth_user.check_password(actual):
            return Response({"ok": False, "error": "La contraseña actual es incorrecta."}, status=400)

        auth_user.set_password(nueva)
        auth_user.save(update_fields=["password"])
        return Response({"ok": True, "mensaje": "Contraseña actualizada correctamente."})


class PerfilAvatarUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        # Usa el mismo origen de variables que los endpoints admin para mantener consistencia.
        cloud_name = config("CLOUDINARY_CLOUD_NAME", default="").strip()
        api_key = config("CLOUDINARY_API_KEY", default="").strip()
        api_secret = config("CLOUDINARY_API_SECRET", default="").strip()
        if not cloud_name or not api_key or not api_secret:
            return Response({"ok": False, "error": "Faltan variables CLOUDINARY_* en backend."}, status=500)

        image_file = request.FILES.get("image")
        if not image_file:
            return Response({"ok": False, "error": "Debes enviar una imagen en el campo 'image'."}, status=400)
        if not is_allowed_image_upload(image_file):
            return Response({"ok": False, "error": "El archivo debe ser una imagen válida (JPG, PNG, WebP, HEIC, etc.)."}, status=400)
        if int(getattr(image_file, "size", 0) or 0) > 5 * 1024 * 1024:
            return Response({"ok": False, "error": "La imagen supera el límite de 5 MB."}, status=400)

        cloudinary.config(cloud_name=cloud_name, api_key=api_key, api_secret=api_secret, secure=True)
        try:
            result = cloudinary.uploader.upload(
                image_file,
                folder="stylo-barber/avatars",
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


class ClienteComprobanteUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def _normalizar_folder(self, folder_raw: str) -> str:
        folder = re.sub(r"[^a-zA-Z0-9_-]", "_", str(folder_raw or "").strip().lower())
        folder = folder[:40] if folder else "comprobantes"
        if not folder:
            folder = "comprobantes"
        return folder

    def post(self, request):
        cloud_name = config("CLOUDINARY_CLOUD_NAME", default="").strip()
        api_key = config("CLOUDINARY_API_KEY", default="").strip()
        api_secret = config("CLOUDINARY_API_SECRET", default="").strip()
        if not cloud_name or not api_key or not api_secret:
            return Response({"ok": False, "error": "Faltan variables CLOUDINARY_* en backend."}, status=500)

        image_file = request.FILES.get("image")
        if not image_file:
            return Response({"ok": False, "error": "Debes enviar una imagen en el campo 'image'."}, status=400)
        if not is_allowed_image_upload(image_file):
            return Response({"ok": False, "error": "El archivo debe ser una imagen válida (JPG, PNG, WebP, HEIC, etc.)."}, status=400)
        if int(getattr(image_file, "size", 0) or 0) > 5 * 1024 * 1024:
            return Response({"ok": False, "error": "La imagen supera el límite de 5 MB."}, status=400)

        folder_suffix = self._normalizar_folder(request.data.get("folder", "comprobantes"))
        cloudinary.config(cloud_name=cloud_name, api_key=api_key, api_secret=api_secret, secure=True)
        try:
            result = cloudinary.uploader.upload(
                image_file,
                folder=f"stylo-barber/{folder_suffix}",
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


class Perfil2FAPreferenciaView(APIView):
    permission_classes = [IsAuthenticated]

    def _to_bool(self, value, default: bool = True) -> bool:
        if isinstance(value, bool):
            return value
        if value is None:
            return default
        if isinstance(value, (int, float)):
            return value != 0
        text = str(value).strip().lower()
        if text in {"true", "1", "si", "sí", "on", "yes"}:
            return True
        if text in {"false", "0", "no", "off"}:
            return False
        return default

    def _resolver_usuario_negocio_id(self, request) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                ORDER BY
                    CASE
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') AND (LOWER(email) = LOWER(%s) AND %s <> '') THEN 1
                        WHEN (LOWER(email) = LOWER(%s) AND %s <> '') THEN 2
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') THEN 3
                        ELSE 99
                    END,
                    usuario_id DESC
                LIMIT 1
                """,
                [username, username, email, email, username, username, email, email, email, email, username, username],
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _obtener_contexto_2fa(self, usuario_id: int) -> tuple[bool, str, str]:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    COALESCE(u.verificacion_2fa, TRUE) AS verificacion_2fa,
                    COALESCE(u.proveedor_auth, 'local') AS proveedor_auth,
                    COALESCE(r.codigo, 'cliente') AS rol_codigo
                FROM negocio.usuario u
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE u.usuario_id = %s
                ORDER BY
                    CASE
                        WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'barbero' THEN 3
                        WHEN LOWER(COALESCE(r.codigo, '')) = 'cliente' THEN 4
                        ELSE 99
                    END
                LIMIT 1
                """,
                [usuario_id],
            )
            row = cursor.fetchone()
        if not row:
            return (True, "local", "cliente")
        return (bool(row[0]), str(row[1] or "local").strip().lower(), str(row[2] or "cliente").strip().lower())

    def get(self, request):
        try:
            usuario_id = self._resolver_usuario_negocio_id(request)
            if not usuario_id:
                return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)
            enabled, proveedor, _rol = self._obtener_contexto_2fa(usuario_id)
            puede_gestionar = True
            return Response(
                {
                    "ok": True,
                    "email_2fa": bool(enabled),
                    "puede_gestionar": puede_gestionar,
                    "motivo_bloqueo": "",
                    "proveedor_auth": proveedor,
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo consultar la configuración 2FA."}, status=500)

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        if "email_2fa" not in data:
            return Response({"ok": False, "error": "Campo 'email_2fa' requerido."}, status=400)
        enabled = self._to_bool(data.get("email_2fa"), default=True)
        try:
            usuario_id = self._resolver_usuario_negocio_id(request)
            if not usuario_id:
                return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)
            _actual, _proveedor, _rol = self._obtener_contexto_2fa(usuario_id)
            username = str(getattr(request.user, "username", "") or "").strip()
            email = str(getattr(request.user, "email", "") or "").strip()
            with connection.cursor() as cursor:
                # Actualiza primero el registro exacto que usa GET /api/perfil/2fa/.
                cursor.execute(
                    """
                    UPDATE negocio.usuario
                    SET verificacion_2fa = %s
                    WHERE usuario_id = %s
                    """,
                    [enabled, usuario_id],
                )
                # Refuerzo de consistencia para posibles filas espejo por credenciales.
                cursor.execute(
                    """
                    UPDATE negocio.usuario
                    SET verificacion_2fa = %s
                    WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                       OR (LOWER(email) = LOWER(%s) AND %s <> '')
                    """,
                    [enabled, username, username, email, email],
                )
            persisted, proveedor, _rol = self._obtener_contexto_2fa(usuario_id)
            return Response({"ok": True, "email_2fa": bool(persisted), "proveedor_auth": proveedor})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo actualizar la configuración 2FA."}, status=500)


class EmailOrUsernameTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        username_or_email = attrs.get("username", "").strip()
        user_model = get_user_model()

        if "@" in username_or_email:
            user = user_model.objects.filter(email__iexact=username_or_email).first()
            if user:
                attrs["username"] = user.get_username()

        return super().validate(attrs)


class EmailOrUsernameTokenObtainPairView(TokenObtainPairView):
    serializer_class = EmailOrUsernameTokenObtainPairSerializer


class LoginAnonRateThrottle(SimpleRateThrottle):
    scope = "login_anon"

    def get_cache_key(self, request, view):
        ip = self.get_ident(request) or "unknown"
        return self.cache_format % {"scope": self.scope, "ident": ip}


class LoginUserRateThrottle(SimpleRateThrottle):
    scope = "login_user"

    def get_cache_key(self, request, view):
        raw = ""
        if isinstance(request.data, dict):
            raw = str(request.data.get("email", "") or request.data.get("username", "")).strip().lower()
        ident = raw or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class Login2FAVerifyRateThrottle(SimpleRateThrottle):
    scope = "login_2fa_verify"

    def get_cache_key(self, request, view):
        temp = ""
        if isinstance(request.data, dict):
            temp = str(request.data.get("tempToken", "")).strip()
        ident = temp or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class Login2FAResendRateThrottle(SimpleRateThrottle):
    scope = "login_2fa_resend"

    def get_cache_key(self, request, view):
        temp = ""
        if isinstance(request.data, dict):
            temp = str(request.data.get("tempToken", "")).strip()
        ident = temp or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class RegisterAnonRateThrottle(SimpleRateThrottle):
    scope = "register_anon"

    def get_cache_key(self, request, view):
        ip = self.get_ident(request) or "unknown"
        return self.cache_format % {"scope": self.scope, "ident": ip}


class RegisterUserRateThrottle(SimpleRateThrottle):
    scope = "register_user"

    def get_cache_key(self, request, view):
        raw = ""
        if isinstance(request.data, dict):
            raw = str(request.data.get("correo", "")).strip().lower()
        ident = raw or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class RecoveryAnonRateThrottle(SimpleRateThrottle):
    scope = "recovery_anon"

    def get_cache_key(self, request, view):
        ip = self.get_ident(request) or "unknown"
        return self.cache_format % {"scope": self.scope, "ident": ip}


class RecoveryEmailRateThrottle(SimpleRateThrottle):
    scope = "recovery_email"

    def get_cache_key(self, request, view):
        raw = ""
        if isinstance(request.data, dict):
            raw = str(request.data.get("email", "") or request.data.get("correo", "")).strip().lower()
        ident = raw or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class RecoveryVerifyRateThrottle(SimpleRateThrottle):
    scope = "recovery_verify"

    def get_cache_key(self, request, view):
        temp = ""
        if isinstance(request.data, dict):
            temp = str(request.data.get("tempToken", "")).strip()
        ident = temp or (self.get_ident(request) or "unknown")
        ident = hashlib.sha256(ident.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class LoginView(APIView):
    """
    Política de acceso:
    - admin/secretaria/barbero: login directo sin 2FA adicional.
    - cliente con proveedor local: requiere OTP por email.
    - cliente con proveedor google: login directo (sin OTP adicional).
    """

    TEMP_TOKEN_SALT = "login-2fa-temp-token"
    OTP_EXP_MINUTES = 10
    throttle_classes = [LoginAnonRateThrottle, LoginUserRateThrottle]
    USERNAME_EMAIL_REGEX = re.compile(r"^[A-Za-z0-9_.@+\-]{3,254}$")

    ROLE_MAP_DB_TO_FRONT = {
        "administrador": "admin",
        "admin": "admin",
        "barbero": "barbero",
        "secretaria": "secretaria",
        "cliente": "cliente",
    }

    def _mask_email(self, email: str) -> str:
        if "@" not in email:
            return email
        local, domain = email.split("@", 1)
        if len(local) <= 2:
            safe_local = local[0] + "*"
        else:
            safe_local = local[0] + ("*" * (len(local) - 2)) + local[-1]
        return f"{safe_local}@{domain}"

    def _resolve_role_and_provider(self, username: str, email: str) -> tuple[str, str]:
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COALESCE(r.codigo, 'cliente') AS rol_codigo,
                           COALESCE(u.proveedor_auth, 'local') AS proveedor_auth
                    FROM negocio.usuario u
                    LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE LOWER(u.username) = LOWER(%s) OR LOWER(u.email) = LOWER(%s)
                    ORDER BY
                        CASE
                            WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'barbero' THEN 3
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'cliente' THEN 4
                            ELSE 99
                        END
                    LIMIT 1
                    """,
                    [username, email],
                )
                row = cursor.fetchone()
            if not row:
                return ("cliente", "local")
            rol = self.ROLE_MAP_DB_TO_FRONT.get(str(row[0] or "cliente").strip().lower(), "cliente")
            proveedor = str(row[1] or "local").strip().lower() or "local"
            return (rol, proveedor)
        except Exception:
            return ("cliente", "local")

    def _issue_tokens(self, user):
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token), str(refresh)

    def _is_cliente_2fa_habilitado(self, username: str, email: str) -> bool:
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COALESCE(verificacion_2fa, TRUE)
                    FROM negocio.usuario
                    WHERE LOWER(username) = LOWER(%s) OR LOWER(email) = LOWER(%s)
                    ORDER BY usuario_id DESC
                    LIMIT 1
                    """,
                    [username, email],
                )
                row = cursor.fetchone()
            if not row:
                return True
            return bool(row[0])
        except Exception:
            return True

    def _save_login_otp(self, username: str, email: str, codigo: str) -> int:
        expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
        with connection.cursor() as cursor:
            # Invalida OTPs previos de login para evitar confusión.
            cursor.execute(
                """
                UPDATE negocio.codigo_verificacion cv
                SET usado = TRUE
                FROM negocio.usuario u
                WHERE cv.usuario_id = u.usuario_id
                  AND cv.tipo = '2fa_login'
                  AND cv.usado = FALSE
                  AND (LOWER(u.username) = LOWER(%s) OR LOWER(u.email) = LOWER(%s))
                """,
                [username, email],
            )
            cursor.execute(
                """
                INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                SELECT u.usuario_id, %s, '2fa_login', %s, FALSE
                FROM negocio.usuario u
                WHERE LOWER(u.username) = LOWER(%s) OR LOWER(u.email) = LOWER(%s)
                LIMIT 1
                RETURNING usuario_id
                """,
                [codigo, expira_en, username, email],
            )
            row = cursor.fetchone()
            if not row:
                raise DatabaseError("No se encontró usuario de negocio para guardar OTP de login.")
            return int(row[0])

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        asunto = "Tu código de verificación — Stylo Barber Connect"
        plain, html_body = build_otp_email_pair(
            eyebrow="Seguridad",
            title="Código de acceso",
            lead="Introduce este código en la pantalla de verificación para completar tu inicio de sesión.",
            codigo=codigo,
            minutes=self.OTP_EXP_MINUTES,
            footer="Si no intentaste iniciar sesión, ignora este mensaje.",
        )
        return send_stylo_transactional(email, asunto, plain, html_body)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        username_or_email = str(data.get("email", "") or data.get("username", "")).strip()
        password = str(data.get("password", "")).strip()
        if not username_or_email or not password:
            return Response({"ok": False, "error": "Correo/usuario y contraseña son obligatorios."}, status=400)
        if len(username_or_email) > 254 or len(password) > 128:
            return Response({"ok": False, "error": "Formato de credenciales inválido."}, status=400)
        if "\x00" in username_or_email or "\x00" in password:
            return Response({"ok": False, "error": "Formato de credenciales inválido."}, status=400)
        if not self.USERNAME_EMAIL_REGEX.match(username_or_email):
            return Response({"ok": False, "error": "Formato de credenciales inválido."}, status=400)

        user_model = get_user_model()
        login_username = username_or_email
        if "@" in username_or_email:
            user_by_email = user_model.objects.filter(email__iexact=username_or_email).first()
            if user_by_email:
                login_username = user_by_email.get_username()

        user = authenticate(request=request, username=login_username, password=password)
        if not user:
            return Response({"ok": False, "error": "Credenciales incorrectas."}, status=401)
        if not user.is_active:
            return Response({"ok": False, "error": "Tu cuenta está inactiva."}, status=403)

        rol, proveedor = self._resolve_role_and_provider(user.get_username(), user.email)
        # Fallback seguro: cuentas administrativas de Django nunca deben pasar por 2FA de cliente.
        if rol == "cliente" and (user.is_superuser or user.is_staff):
            rol = "admin"
            proveedor = "local"
        requiere_2fa = rol == "cliente" and proveedor != "google" and self._is_cliente_2fa_habilitado(login_username, user.email)

        if not requiere_2fa:
            access, refresh = self._issue_tokens(user)
            return Response(
                {
                    "ok": True,
                    "requires2fa": False,
                    "access": access,
                    "refresh": refresh,
                    "usuario": {
                        "id": user.id,
                        "username": user.username,
                        "email": user.email,
                        "rol": rol,
                    },
                }
            )

        codigo = f"{secrets.randbelow(1_000_000):06d}"
        try:
            negocio_user_id = self._save_login_otp(user.get_username(), user.email, codigo)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo preparar la verificación 2FA."}, status=500)

        temp_token = signing.dumps(
            {"u": negocio_user_id, "du": user.id, "e": user.email, "r": rol, "p": "login_2fa"},
            salt=self.TEMP_TOKEN_SALT,
        )
        enviado = self._send_otp_email(user.email, codigo)
        payload = {
            "ok": True,
            "requires2fa": True,
            "tempToken": temp_token,
            "canal": "email",
            "destino": self._mask_email(user.email),
            "mensaje": "Te enviamos un código de verificación por correo.",
        }
        if not enviado:
            payload["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                payload["codigo_debug"] = codigo
        return Response(payload)


class GoogleLoginView(APIView):
    """
    Login con Google/Firebase:
    - Verifica idToken contra endpoint oficial de Google.
    - Si el usuario existe, emite JWT según su rol de negocio.
    - Si no existe, lo crea como cliente (sin alterar estructura BD).
    """

    ROLE_MAP_DB_TO_FRONT = LoginView.ROLE_MAP_DB_TO_FRONT
    throttle_classes = [LoginAnonRateThrottle]

    def _dev_decode_firebase_token(self, id_token: str) -> dict:
        # Fallback SOLO para desarrollo local cuando DEBUG=True.
        try:
            parts = id_token.split(".")
            if len(parts) != 3:
                return {"ok": False}
            payload_b64 = parts[1]
            padding = "=" * ((4 - len(payload_b64) % 4) % 4)
            payload_json = base64.urlsafe_b64decode((payload_b64 + padding).encode("utf-8")).decode("utf-8")
            payload = json.loads(payload_json or "{}")
        except Exception:
            return {"ok": False}

        exp = int(payload.get("exp", 0) or 0)
        if exp <= int(time.time()):
            return {"ok": False}

        email = str(payload.get("email", "")).strip().lower()
        if not email:
            return {"ok": False}

        email_verified = payload.get("email_verified", False)
        if not bool(email_verified):
            return {"ok": False}

        sub = str(payload.get("sub", "")).strip()
        if not sub:
            return {"ok": False}

        provider = str(((payload.get("firebase") or {}).get("sign_in_provider") or "")).strip().lower()
        if provider and provider not in ("google.com", "password", "custom"):
            return {"ok": False}

        return {
            "ok": True,
            "email": email,
            "sub": sub,
            "name": str(payload.get("name", "")).strip(),
        }

    def _verify_google_id_token(self, id_token: str) -> dict:
        firebase_api_key = str(getattr(settings, "FIREBASE_WEB_API_KEY", "") or "").strip()
        expected_project = str(getattr(settings, "FIREBASE_PROJECT_ID", "") or "").strip()

        # 1) Validación principal para tokens emitidos por Firebase Auth.
        if firebase_api_key:
            lookup_url = (
                "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="
                + urllib_parse.quote(firebase_api_key)
            )
            req = urllib_request.Request(
                url=lookup_url,
                data=json.dumps({"idToken": id_token}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib_request.urlopen(req, timeout=10) as response:
                    if 200 <= response.getcode() < 300:
                        payload = json.loads(response.read().decode("utf-8") or "{}")
                        users = payload.get("users") or []
                        if users:
                            info = users[0] or {}
                            email = str(info.get("email", "")).strip().lower()
                            if not email:
                                return {"ok": False, "error": "No se pudo obtener el correo de Google."}
                            if not bool(info.get("emailVerified")):
                                return {"ok": False, "error": "Tu correo de Google no está verificado."}
                            return {
                                "ok": True,
                                "email": email,
                                "sub": str(info.get("localId", "")).strip(),
                                "name": str(info.get("displayName", "")).strip(),
                            }
            except urllib_error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8")
                except Exception:
                    body = ""
                _ = body or "Token de Google inválido o expirado."
            except (urllib_error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
                pass

        # 2) Fallback para tokens OAuth2 de Google (no Firebase).
        verify_url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib_parse.quote(id_token)
        req = urllib_request.Request(verify_url, method="GET")
        try:
            with urllib_request.urlopen(req, timeout=10) as response:
                if response.getcode() < 200 or response.getcode() >= 300:
                    return {"ok": False, "error": "No se pudo validar el token de Google."}
                payload_raw = response.read().decode("utf-8")
                payload = json.loads(payload_raw or "{}")
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
            if bool(getattr(settings, "DEBUG", False)):
                dev_payload = self._dev_decode_firebase_token(id_token)
                if dev_payload.get("ok"):
                    return dev_payload
            if firebase_api_key:
                return {"ok": False, "error": "Token inválido o expirado."}
            return {
                "ok": False,
                "error": "Token inválido o expirado. Configura FIREBASE_WEB_API_KEY en backend para validar Firebase ID tokens.",
            }

        issuer = str(payload.get("iss", "")).strip().lower()
        if issuer not in ("accounts.google.com", "https://accounts.google.com"):
            return {"ok": False, "error": "Emisor de token de Google inválido."}

        email = str(payload.get("email", "")).strip().lower()
        if not email:
            return {"ok": False, "error": "No se pudo obtener el correo de Google."}

        email_verified = str(payload.get("email_verified", "")).strip().lower()
        if email_verified not in ("true", "1"):
            return {"ok": False, "error": "Tu correo de Google no está verificado."}

        audience = str(payload.get("aud", "")).strip()
        if expected_project and audience and audience != expected_project:
            return {"ok": False, "error": "El token no corresponde al proyecto Firebase configurado."}

        return {
            "ok": True,
            "email": email,
            "sub": str(payload.get("sub", "")).strip(),
            "name": str(payload.get("name", "")).strip(),
        }

    def _resolve_role_and_provider(self, username: str, email: str) -> tuple[str, str]:
        return LoginView()._resolve_role_and_provider(username, email)

    def _issue_tokens(self, user):
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token), str(refresh)

    def _generate_unique_username(self, email: str) -> str:
        user_model = get_user_model()
        base = (email.split("@", 1)[0] if "@" in email else email).strip().lower()
        base = re.sub(r"[^a-z0-9._-]", "", base) or "usuario"
        candidate = base[:150]
        idx = 1
        while user_model.objects.filter(username__iexact=candidate).exists():
            suffix = f"_{idx}"
            candidate = f"{base[: max(1, 150 - len(suffix))]}{suffix}"
            idx += 1
        return candidate

    def _ensure_negocio_user(self, user, email: str, firebase_uid: str) -> None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE LOWER(email) = LOWER(%s)
                LIMIT 1
                """,
                [email],
            )
            row = cursor.fetchone()
            if row:
                usuario_id = int(row[0])
                cursor.execute(
                    """
                    UPDATE negocio.usuario
                    SET username = %s,
                        proveedor_auth = COALESCE(NULLIF(proveedor_auth, ''), 'google'),
                        firebase_uid = COALESCE(NULLIF(%s, ''), firebase_uid),
                        verificado = TRUE,
                        activo = TRUE
                    WHERE usuario_id = %s
                    """,
                    [user.username, firebase_uid or "", usuario_id],
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO negocio.usuario (
                        email, username, password_hash, activo, verificado, verificacion_2fa, proveedor_auth, firebase_uid
                    )
                    VALUES (%s, %s, NULL, TRUE, TRUE, FALSE, 'google', %s)
                    RETURNING usuario_id
                    """,
                    [email, user.username, firebase_uid or None],
                )
                usuario_id = int(cursor.fetchone()[0])

            cursor.execute(
                "SELECT rol_id FROM negocio.rol WHERE LOWER(codigo) = 'cliente' LIMIT 1"
            )
            rol_row = cursor.fetchone()
            if rol_row:
                rol_id = int(rol_row[0])
                cursor.execute(
                    """
                    INSERT INTO negocio.usuario_rol (usuario_id, rol_id)
                    VALUES (%s, %s)
                    ON CONFLICT (usuario_id, rol_id) DO NOTHING
                    """,
                    [usuario_id, rol_id],
                )

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        id_token = str(data.get("idToken", "")).strip()
        if not id_token:
            return Response({"ok": False, "error": "Token de Google obligatorio."}, status=400)

        verified = self._verify_google_id_token(id_token)
        if not verified.get("ok"):
            return Response({"ok": False, "error": verified.get("error", "No se pudo validar Google.")}, status=401)

        email = str(verified.get("email", "")).strip().lower()
        firebase_uid = str(verified.get("sub", "")).strip()

        user_model = get_user_model()
        user = user_model.objects.filter(email__iexact=email).first()
        if not user:
            username = self._generate_unique_username(email)
            user = user_model(username=username, email=email, is_active=True)
            user.set_unusable_password()
            user.save()
        elif not user.is_active:
            return Response({"ok": False, "error": "Tu cuenta está inactiva."}, status=403)

        try:
            with transaction.atomic():
                self._ensure_negocio_user(user, email, firebase_uid)
        except DatabaseError as exc:
            logger.exception("Google login: fallo al sincronizar negocio.usuario")
            if settings.DEBUG:
                return Response(
                    {"ok": False, "error": f"No se pudo preparar tu sesión con Google: {exc}"},
                    status=500,
                )
            return Response(
                {
                    "ok": False,
                    "error": (
                        "No se pudo preparar tu sesión con Google. "
                        "Suele deberse a que la base de datos en Render/Neon no tiene aplicado el script SQL del proyecto "
                        "(esquema negocio y tablas como negocio.usuario), o DATABASE_URL apunta a otra BD distinta a la que usas en local. "
                        "Ejecuta STYLO_BARBER_CONNECT_EJECUTAR.md en el editor SQL de Neon y vuelve a intentar."
                    ),
                },
                status=500,
            )

        rol, _proveedor = self._resolve_role_and_provider(user.get_username(), user.email)
        if rol == "cliente" and (user.is_superuser or user.is_staff):
            rol = "admin"

        access, refresh = self._issue_tokens(user)
        return Response(
            {
                "ok": True,
                "access": access,
                "refresh": refresh,
                "usuario": {
                    "id": user.id,
                    "username": user.username,
                    "email": user.email,
                    "rol": rol,
                },
            }
        )


class Login2FAVerificarView(APIView):
    TEMP_TOKEN_SALT = LoginView.TEMP_TOKEN_SALT
    OTP_EXP_MINUTES = LoginView.OTP_EXP_MINUTES
    throttle_classes = [Login2FAVerifyRateThrottle]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        temp_token = str(data.get("tempToken", "")).strip()
        codigo = str(data.get("codigo", "")).strip()
        if not temp_token or not codigo:
            return Response({"ok": False, "error": "Token temporal y código son obligatorios."}, status=400)

        try:
            payload = signing.loads(temp_token, salt=self.TEMP_TOKEN_SALT, max_age=self.OTP_EXP_MINUTES * 60)
        except signing.BadSignature:
            return Response({"ok": False, "error": "Token temporal inválido o expirado."}, status=400)

        if payload.get("p") != "login_2fa":
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_id = int(payload.get("u", 0) or 0)
        if not user_id:
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT codigo_id
                    FROM negocio.codigo_verificacion
                    WHERE usuario_id = %s
                      AND tipo = '2fa_login'
                      AND usado = FALSE
                      AND codigo = %s
                      AND expira_en >= NOW()
                    ORDER BY codigo_id DESC
                    LIMIT 1
                    """,
                    [user_id, codigo],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Código incorrecto o expirado."}, status=400)
                codigo_id = int(row[0])
                cursor.execute("UPDATE negocio.codigo_verificacion SET usado = TRUE WHERE codigo_id = %s", [codigo_id])
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo validar el código."}, status=500)

        user_model = get_user_model()
        user = None
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT username, email
                    FROM negocio.usuario
                    WHERE usuario_id = %s
                    LIMIT 1
                    """,
                    [user_id],
                )
                row = cursor.fetchone()
            if row:
                username = str(row[0] or "").strip()
                email = str(row[1] or "").strip()
                if username:
                    user = user_model.objects.filter(username__iexact=username).first()
                if not user and email:
                    user = user_model.objects.filter(email__iexact=email).first()
        except DatabaseError:
            user = None

        if not user:
            # Compatibilidad con tokens viejos emitidos con id de Django.
            django_user_id = int(payload.get("du", 0) or payload.get("u", 0) or 0)
            if django_user_id:
                user = user_model.objects.filter(id=django_user_id).first()

        if not user or not user.is_active:
            return Response({"ok": False, "error": "Usuario no válido para iniciar sesión."}, status=403)

        # Rol para redirección en frontend
        rol = str(payload.get("r") or "cliente")
        refresh = RefreshToken.for_user(user)
        return Response(
            {
                "ok": True,
                "access": str(refresh.access_token),
                "refresh": str(refresh),
                "usuario": {
                    "id": user.id,
                    "username": user.username,
                    "email": user.email,
                    "rol": rol,
                },
            }
        )


class Login2FASolicitarCodigoView(APIView):
    TEMP_TOKEN_SALT = LoginView.TEMP_TOKEN_SALT
    OTP_EXP_MINUTES = LoginView.OTP_EXP_MINUTES
    throttle_classes = [Login2FAResendRateThrottle]

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        asunto = "Nuevo código de verificación — Stylo Barber Connect"
        plain, html_body = build_otp_email_pair(
            eyebrow="Seguridad",
            title="Nuevo código de acceso",
            lead="Generamos un código nuevo por seguridad. Úsalo en la pantalla de verificación 2FA.",
            codigo=codigo,
            minutes=self.OTP_EXP_MINUTES,
            footer="Si no fuiste tú, cambia tu contraseña y revisa la actividad de tu cuenta.",
        )
        return send_stylo_transactional(email, asunto, plain, html_body)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        temp_token = str(data.get("tempToken", "")).strip()
        if not temp_token:
            return Response({"ok": False, "error": "Token temporal requerido."}, status=400)

        try:
            payload = signing.loads(temp_token, salt=self.TEMP_TOKEN_SALT, max_age=self.OTP_EXP_MINUTES * 60)
        except signing.BadSignature:
            return Response({"ok": False, "error": "Token temporal inválido o expirado."}, status=400)
        if payload.get("p") != "login_2fa":
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_id = int(payload.get("u", 0) or 0)
        email = str(payload.get("e", "")).strip()
        if not user_id or not email:
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        codigo = f"{secrets.randbelow(1_000_000):06d}"
        expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE negocio.codigo_verificacion
                    SET usado = TRUE
                    WHERE usuario_id = %s AND tipo = '2fa_login' AND usado = FALSE
                    """,
                    [user_id],
                )
                cursor.execute(
                    """
                    INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                    VALUES (%s, %s, '2fa_login', %s, FALSE)
                    """,
                    [user_id, codigo, expira_en],
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo reenviar el código."}, status=500)

        enviado = self._send_otp_email(email, codigo)

        response = {"ok": True, "mensaje": "Código reenviado."}
        if not enviado:
            response["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                response["codigo_debug"] = codigo
        return Response(response)


class RegisterView(APIView):
    TEMP_TOKEN_SALT = "register-otp-temp-token"
    OTP_EXP_MINUTES = 10
    throttle_classes = [RegisterAnonRateThrottle, RegisterUserRateThrottle]
    USERNAME_REGEX = re.compile(r"^[A-Za-z0-9_.+\-]{4,150}$")
    EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}$")
    PHONE_REGEX = re.compile(r"^\d{10,15}$")

    def _mask_email(self, email: str) -> str:
        if "@" not in email:
            return email
        local, domain = email.split("@", 1)
        if len(local) <= 2:
            safe_local = local[0] + "*"
        else:
            safe_local = local[0] + ("*" * (len(local) - 2)) + local[-1]
        return f"{safe_local}@{domain}"

    def _normalize_bool(self, value) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        text = str(value or "").strip().lower()
        return text in {"1", "true", "si", "sí", "on", "yes"}

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        asunto = "Verifica tu registro — Stylo Barber Connect"
        plain, html_body = build_otp_email_pair(
            eyebrow="Registro",
            title="Confirma tu correo",
            lead="Completa la verificación de tu cuenta con el siguiente código OTP.",
            codigo=codigo,
            minutes=self.OTP_EXP_MINUTES,
            footer="Si no creaste una cuenta en Stylo Barber Connect, puedes ignorar este correo.",
        )
        return send_stylo_transactional(email, asunto, plain, html_body)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}

        nombre = str(data.get("nombre", "")).strip()
        ap_paterno = str(data.get("apellidopaterno", "")).strip()
        ap_materno = str(data.get("apellidomaterno", "")).strip()
        username = str(data.get("username", "")).strip()
        correo = str(data.get("correo", "")).strip().lower()
        contrasena = str(data.get("contrasena", ""))
        telefono = re.sub(r"\D+", "", str(data.get("telefono", "")))
        pregunta = str(data.get("preguntasecreta", "")).strip()
        respuesta = str(data.get("respuestasecreta", "")).strip()
        acepta_terminos = self._normalize_bool(data.get("aceptaTerminos"))

        if not all([nombre, ap_paterno, ap_materno, username, correo, contrasena, telefono, pregunta, respuesta]):
            return Response({"ok": False, "error": "Todos los campos son obligatorios."}, status=400)
        if len(nombre) < 2 or len(ap_paterno) < 2 or len(ap_materno) < 2:
            return Response({"ok": False, "error": "Nombre y apellidos deben tener al menos 2 caracteres."}, status=400)
        if not self.USERNAME_REGEX.match(username):
            return Response({"ok": False, "error": "Username inválido. Usa mínimo 4 caracteres alfanuméricos."}, status=400)
        if not self.EMAIL_REGEX.match(correo):
            return Response({"ok": False, "error": "Correo inválido."}, status=400)
        if not self.PHONE_REGEX.match(telefono):
            return Response({"ok": False, "error": "Teléfono inválido. Debe tener entre 10 y 15 dígitos."}, status=400)
        if len(contrasena) < 8:
            return Response({"ok": False, "error": "La contraseña debe tener al menos 8 caracteres."}, status=400)
        if not re.search(r"[A-Z]", contrasena) or not re.search(r"[a-z]", contrasena) or not re.search(r"\d", contrasena) or not re.search(r"[!@#$%^&*(),.?\":{}|<>\[\]\\\/_+\-=~`]", contrasena):
            return Response({"ok": False, "error": "La contraseña debe incluir mayúscula, minúscula, número y carácter especial."}, status=400)
        if not acepta_terminos:
            return Response({"ok": False, "error": "Debes aceptar términos y privacidad para registrarte."}, status=400)

        user_model = get_user_model()
        if user_model.objects.filter(username__iexact=username).exists():
            return Response({"ok": False, "error": "El username ya está registrado."}, status=409)
        if user_model.objects.filter(email__iexact=correo).exists():
            return Response({"ok": False, "error": "El correo ya está registrado."}, status=409)

        codigo = f"{secrets.randbelow(1_000_000):06d}"
        expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
        codigo_debug = None

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT 1
                        FROM negocio.usuario
                        WHERE LOWER(email) = LOWER(%s) OR LOWER(username) = LOWER(%s)
                        LIMIT 1
                        """,
                        [correo, username],
                    )
                    if cursor.fetchone():
                        return Response({"ok": False, "error": "El usuario o correo ya está registrado."}, status=409)

                    user_model.objects.create_user(
                        username=username,
                        email=correo,
                        password=contrasena,
                    )

                    cursor.execute(
                        """
                        INSERT INTO negocio.usuario (
                            email, username, password_hash, activo, verificado, verificacion_2fa, proveedor_auth
                        )
                        VALUES (%s, %s, %s, TRUE, FALSE, TRUE, 'local')
                        RETURNING usuario_id
                        """,
                        [correo, username, make_password(contrasena)],
                    )
                    usuario_id = int(cursor.fetchone()[0])

                    cursor.execute(
                        "SELECT rol_id FROM negocio.rol WHERE LOWER(codigo) = 'cliente' LIMIT 1"
                    )
                    rol_row = cursor.fetchone()
                    if rol_row:
                        rol_id = int(rol_row[0])
                    else:
                        cursor.execute(
                            """
                            INSERT INTO negocio.rol (codigo, nombre, descripcion)
                            VALUES ('cliente', 'Cliente', 'Rol por defecto para clientes registrados')
                            RETURNING rol_id
                            """
                        )
                        rol_id = int(cursor.fetchone()[0])

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
                            usuario_id, nombres, apellido_paterno, apellido_materno, telefono,
                            acepto_privacidad, acepto_terminos, fecha_aceptacion
                        )
                        VALUES (%s, %s, %s, %s, %s, TRUE, TRUE, NOW())
                        """,
                        [usuario_id, nombre, ap_paterno, ap_materno, telefono],
                    )

                    cursor.execute(
                        "SELECT pregunta_id FROM negocio.pregunta_seguridad WHERE texto = %s LIMIT 1",
                        [pregunta],
                    )
                    preg_row = cursor.fetchone()
                    if preg_row:
                        pregunta_id = int(preg_row[0])
                    else:
                        cursor.execute(
                            "INSERT INTO negocio.pregunta_seguridad (texto) VALUES (%s) RETURNING pregunta_id",
                            [pregunta],
                        )
                        pregunta_id = int(cursor.fetchone()[0])

                    cursor.execute(
                        """
                        INSERT INTO negocio.respuesta_seguridad (usuario_id, pregunta_id, respuesta_hash)
                        VALUES (%s, %s, %s)
                        """,
                        [usuario_id, pregunta_id, make_password(respuesta)],
                    )

                    cursor.execute(
                        """
                        UPDATE negocio.codigo_verificacion
                        SET usado = TRUE
                        WHERE usuario_id = %s AND tipo = 'verificar_email' AND usado = FALSE
                        """,
                        [usuario_id],
                    )
                    cursor.execute(
                        """
                        INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                        VALUES (%s, %s, 'verificar_email', %s, FALSE)
                        """,
                        [usuario_id, codigo, expira_en],
                    )
        except Exception:
            # Si algo falla en negocio.*, limpiamos el usuario Django creado dentro de la transacción.
            user_model.objects.filter(username__iexact=username, email__iexact=correo).delete()
            return Response({"ok": False, "error": "No se pudo completar el registro. Intenta de nuevo."}, status=500)

        temp_token = signing.dumps(
            {"u": usuario_id, "e": correo, "p": "register_otp"},
            salt=self.TEMP_TOKEN_SALT,
        )
        email_enviado = self._send_otp_email(correo, codigo)
        payload = {
            "ok": True,
            "tempToken": temp_token,
            "destino": self._mask_email(correo),
            "email_enviado": email_enviado,
            "mensaje": "Código OTP enviado a tu correo para verificar tu cuenta.",
        }
        if not email_enviado:
            payload["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                codigo_debug = codigo
                payload["codigo_otp"] = codigo_debug
        return Response(payload, status=201)


class VerifyRegisterOTPView(APIView):
    TEMP_TOKEN_SALT = RegisterView.TEMP_TOKEN_SALT
    OTP_EXP_MINUTES = RegisterView.OTP_EXP_MINUTES
    throttle_classes = [Login2FAVerifyRateThrottle]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        temp_token = str(data.get("tempToken", "")).strip()
        codigo = str(data.get("codigo", "")).strip()
        if not temp_token or not codigo:
            return Response({"ok": False, "error": "Token temporal y código son obligatorios."}, status=400)

        try:
            payload = signing.loads(temp_token, salt=self.TEMP_TOKEN_SALT, max_age=self.OTP_EXP_MINUTES * 60)
        except signing.BadSignature:
            return Response({"ok": False, "error": "Token temporal inválido o expirado."}, status=400)

        if payload.get("p") != "register_otp":
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_id = int(payload.get("u", 0) or 0)
        if not user_id:
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        username = None
        email = None
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT codigo_id
                    FROM negocio.codigo_verificacion
                    WHERE usuario_id = %s
                      AND tipo = 'verificar_email'
                      AND usado = FALSE
                      AND codigo = %s
                      AND expira_en >= NOW()
                    ORDER BY codigo_id DESC
                    LIMIT 1
                    """,
                    [user_id, codigo],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Código incorrecto o expirado."}, status=400)
                codigo_id = int(row[0])
                cursor.execute("UPDATE negocio.codigo_verificacion SET usado = TRUE WHERE codigo_id = %s", [codigo_id])
                cursor.execute(
                    """
                    UPDATE negocio.usuario
                    SET verificado = TRUE, fecha_actualizacion = NOW()
                    WHERE usuario_id = %s
                    """,
                    [user_id],
                )
                cursor.execute(
                    """
                    SELECT username, email
                    FROM negocio.usuario
                    WHERE usuario_id = %s
                    LIMIT 1
                    """,
                    [user_id],
                )
                urow = cursor.fetchone()
                if urow:
                    username = str(urow[0] or "").strip()
                    email = str(urow[1] or "").strip()
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo validar el código de registro."}, status=500)

        user_model = get_user_model()
        user = None
        if username:
            user = user_model.objects.filter(username__iexact=username).first()
        if not user and email:
            user = user_model.objects.filter(email__iexact=email).first()
        if not user or not user.is_active:
            return Response({"ok": False, "error": "Cuenta verificada, pero no se pudo iniciar sesión."}, status=200)

        refresh = RefreshToken.for_user(user)
        return Response(
            {
                "ok": True,
                "mensaje": "Cuenta verificada correctamente.",
                "access": str(refresh.access_token),
                "refresh": str(refresh),
                "usuario": {
                    "id": user.id,
                    "username": user.username,
                    "email": user.email,
                    "rol": "cliente",
                },
            }
        )


class ReenviarRegistroOTPView(APIView):
    OTP_EXP_MINUTES = RegisterView.OTP_EXP_MINUTES
    throttle_classes = [Login2FAResendRateThrottle]

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        return RegisterView()._send_otp_email(email, codigo)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        correo = str(data.get("correo", "") or data.get("email", "")).strip().lower()
        if not correo:
            return Response({"ok": False, "error": "Correo requerido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT usuario_id
                    FROM negocio.usuario
                    WHERE LOWER(email) = LOWER(%s) AND proveedor_auth = 'local'
                    LIMIT 1
                    """,
                    [correo],
                )
                row = cursor.fetchone()
                if not row:
                    # Respuesta genérica para no filtrar existencia de cuentas.
                    return Response({"ok": True, "mensaje": "Si el correo existe, se reenviará un código OTP."})

                usuario_id = int(row[0])
                codigo = f"{secrets.randbelow(1_000_000):06d}"
                expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
                cursor.execute(
                    """
                    UPDATE negocio.codigo_verificacion
                    SET usado = TRUE
                    WHERE usuario_id = %s AND tipo = 'verificar_email' AND usado = FALSE
                    """,
                    [usuario_id],
                )
                cursor.execute(
                    """
                    INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                    VALUES (%s, %s, 'verificar_email', %s, FALSE)
                    """,
                    [usuario_id, codigo, expira_en],
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo reenviar el código OTP."}, status=500)

        enviado = self._send_otp_email(correo, codigo)
        response = {"ok": True, "mensaje": "Código OTP reenviado."}
        if not enviado:
            response["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                response["codigo_otp"] = codigo
        return Response(response)


class RecuperarOTPView(APIView):
    TEMP_TOKEN_SALT = "recovery-otp-temp-token"
    OTP_EXP_MINUTES = 10
    EMAIL_REGEX = RegisterView.EMAIL_REGEX
    throttle_classes = [RecoveryAnonRateThrottle, RecoveryEmailRateThrottle]

    def _mask_email(self, email: str) -> str:
        if "@" not in email:
            return email
        local, domain = email.split("@", 1)
        if len(local) <= 2:
            safe_local = local[0] + "*"
        else:
            safe_local = local[0] + ("*" * (len(local) - 2)) + local[-1]
        return f"{safe_local}@{domain}"

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        asunto = "Recuperación de contraseña — Stylo Barber Connect"
        plain, html_body = build_otp_email_pair(
            eyebrow="Recuperación",
            title="Restablecer contraseña",
            lead="Usa este código en la web para continuar con el cambio de contraseña. Nadie de nuestro equipo te lo pedirá por otro canal.",
            codigo=codigo,
            minutes=self.OTP_EXP_MINUTES,
            footer="Si no solicitaste recuperar la contraseña, ignora este mensaje.",
        )
        return send_stylo_transactional(email, asunto, plain, html_body)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        email = str(data.get("email", "")).strip().lower()
        if not email or not self.EMAIL_REGEX.match(email):
            return Response({"ok": False, "error": "Correo inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT usuario_id, proveedor_auth
                    FROM negocio.usuario
                    WHERE LOWER(email) = LOWER(%s)
                    LIMIT 1
                    """,
                    [email],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": True, "mensaje": "Si el correo existe, se enviará un código de recuperación."})
                usuario_id = int(row[0])
                proveedor = str(row[1] or "local").strip().lower()
                if proveedor != "local":
                    return Response(
                        {
                            "ok": True,
                            "mensaje": "Esta cuenta usa inicio de sesión externo. Usa 'Iniciar con Google'.",
                        }
                    )

                codigo = f"{secrets.randbelow(1_000_000):06d}"
                expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
                cursor.execute(
                    """
                    UPDATE negocio.codigo_verificacion
                    SET usado = TRUE
                    WHERE usuario_id = %s AND tipo = 'recuperar_password' AND usado = FALSE
                    """,
                    [usuario_id],
                )
                cursor.execute(
                    """
                    INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                    VALUES (%s, %s, 'recuperar_password', %s, FALSE)
                    """,
                    [usuario_id, codigo, expira_en],
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo iniciar la recuperación de contraseña."}, status=500)

        temp_token = signing.dumps(
            {"u": usuario_id, "e": email, "p": "recover_otp"},
            salt=self.TEMP_TOKEN_SALT,
        )
        enviado = self._send_otp_email(email, codigo)
        payload = {
            "ok": True,
            "tempToken": temp_token,
            "destino": self._mask_email(email),
            "email_enviado": enviado,
            "mensaje": "Código OTP enviado para recuperar contraseña.",
        }
        if not enviado:
            payload["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                payload["codigo_otp"] = codigo
        return Response(payload)


class VerificarOTPRecuperacionView(APIView):
    TEMP_TOKEN_SALT = RecuperarOTPView.TEMP_TOKEN_SALT
    OTP_EXP_MINUTES = RecuperarOTPView.OTP_EXP_MINUTES
    VERIFIED_TOKEN_SALT = "recovery-otp-verified-temp-token"
    throttle_classes = [RecoveryVerifyRateThrottle]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        temp_token = str(data.get("tempToken", "")).strip()
        codigo = str(data.get("codigo", "")).strip()
        if not temp_token or not codigo:
            return Response({"ok": False, "error": "Token temporal y código son obligatorios."}, status=400)

        try:
            payload = signing.loads(
                temp_token,
                salt=self.TEMP_TOKEN_SALT,
                max_age=self.OTP_EXP_MINUTES * 60,
            )
        except signing.BadSignature:
            return Response({"ok": False, "error": "Token temporal inválido o expirado."}, status=400)

        if payload.get("p") != "recover_otp":
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_id = int(payload.get("u", 0) or 0)
        email = str(payload.get("e", "")).strip().lower()
        if not user_id or not email:
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT codigo_id
                    FROM negocio.codigo_verificacion
                    WHERE usuario_id = %s
                      AND tipo = 'recuperar_password'
                      AND usado = FALSE
                      AND codigo = %s
                      AND expira_en >= NOW()
                    ORDER BY codigo_id DESC
                    LIMIT 1
                    """,
                    [user_id, codigo],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Código incorrecto o expirado."}, status=400)
                codigo_id = int(row[0])
                cursor.execute(
                    "UPDATE negocio.codigo_verificacion SET usado = TRUE WHERE codigo_id = %s",
                    [codigo_id],
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo verificar el código OTP."}, status=500)

        verified_token = signing.dumps(
            {"u": user_id, "e": email, "p": "recover_otp_verified"},
            salt=self.VERIFIED_TOKEN_SALT,
        )
        return Response(
            {
                "ok": True,
                "mensaje": "Código verificado correctamente.",
                "tempToken": verified_token,
            }
        )


class ReenviarOTPRecuperacionView(APIView):
    OTP_EXP_MINUTES = RecuperarOTPView.OTP_EXP_MINUTES
    EMAIL_REGEX = RecuperarOTPView.EMAIL_REGEX
    throttle_classes = [RecoveryAnonRateThrottle, RecoveryEmailRateThrottle]

    def _send_otp_email(self, email: str, codigo: str) -> bool:
        return RecuperarOTPView()._send_otp_email(email, codigo)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        email = str(data.get("email", "") or data.get("correo", "")).strip().lower()
        if not email or not self.EMAIL_REGEX.match(email):
            return Response({"ok": False, "error": "Correo inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT usuario_id, proveedor_auth
                    FROM negocio.usuario
                    WHERE LOWER(email) = LOWER(%s)
                    LIMIT 1
                    """,
                    [email],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": True, "mensaje": "Si el correo existe, se reenviará un código OTP."})
                usuario_id = int(row[0])
                proveedor = str(row[1] or "local").strip().lower()
                if proveedor != "local":
                    return Response({"ok": True, "mensaje": "Esta cuenta usa inicio de sesión externo."})

                codigo = f"{secrets.randbelow(1_000_000):06d}"
                expira_en = timezone.now() + timezone.timedelta(minutes=self.OTP_EXP_MINUTES)
                cursor.execute(
                    """
                    UPDATE negocio.codigo_verificacion
                    SET usado = TRUE
                    WHERE usuario_id = %s AND tipo = 'recuperar_password' AND usado = FALSE
                    """,
                    [usuario_id],
                )
                cursor.execute(
                    """
                    INSERT INTO negocio.codigo_verificacion (usuario_id, codigo, tipo, expira_en, usado)
                    VALUES (%s, %s, 'recuperar_password', %s, FALSE)
                    """,
                    [usuario_id, codigo, expira_en],
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo reenviar el código OTP."}, status=500)

        enviado = self._send_otp_email(email, codigo)
        response = {"ok": True, "mensaje": "Código OTP reenviado.", "email_enviado": enviado}
        if not enviado:
            response["mensaje"] = "No se pudo enviar el correo en este momento."
            if settings.DEBUG:
                response["codigo_otp"] = codigo
        return Response(response)


class ActualizarContrasenaOTPView(APIView):
    VERIFIED_TOKEN_SALT = VerificarOTPRecuperacionView.VERIFIED_TOKEN_SALT
    VERIFIED_MAX_AGE_MIN = 30
    throttle_classes = [RecoveryVerifyRateThrottle]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        temp_token = str(data.get("tempToken", "")).strip()
        nueva = str(data.get("nuevaContrasena", "")).strip()
        if not temp_token or not nueva:
            return Response({"ok": False, "error": "Token temporal y nueva contraseña son obligatorios."}, status=400)
        if len(nueva) < 8:
            return Response({"ok": False, "error": "La contraseña debe tener al menos 8 caracteres."}, status=400)
        if not re.search(r"[A-Z]", nueva) or not re.search(r"[a-z]", nueva) or not re.search(r"\d", nueva):
            return Response({"ok": False, "error": "La contraseña debe incluir mayúscula, minúscula y número."}, status=400)

        try:
            payload = signing.loads(
                temp_token,
                salt=self.VERIFIED_TOKEN_SALT,
                max_age=self.VERIFIED_MAX_AGE_MIN * 60,
            )
        except signing.BadSignature:
            return Response({"ok": False, "error": "Token temporal inválido o expirado."}, status=400)

        if payload.get("p") != "recover_otp_verified":
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_id = int(payload.get("u", 0) or 0)
        email = str(payload.get("e", "")).strip().lower()
        if not user_id or not email:
            return Response({"ok": False, "error": "Token temporal inválido."}, status=400)

        user_model = get_user_model()

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT username, email
                        FROM negocio.usuario
                        WHERE usuario_id = %s AND LOWER(email) = LOWER(%s)
                        LIMIT 1
                        """,
                        [user_id, email],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "No se encontró la cuenta para actualizar contraseña."}, status=404)
                    username = str(row[0] or "").strip()
                    correo = str(row[1] or "").strip().lower()

                    cursor.execute(
                        """
                        UPDATE negocio.usuario
                        SET password_hash = %s, fecha_actualizacion = NOW()
                        WHERE usuario_id = %s
                        """,
                        [make_password(nueva), user_id],
                    )

                django_user = None
                if username:
                    django_user = user_model.objects.filter(username__iexact=username).first()
                if not django_user:
                    django_user = user_model.objects.filter(email__iexact=correo).first()
                if not django_user:
                    return Response({"ok": False, "error": "No se encontró la cuenta de autenticación."}, status=404)

                django_user.set_password(nueva)
                django_user.save(update_fields=["password"])
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo actualizar la contraseña."}, status=500)

        return Response({"ok": True, "mensaje": "Contraseña actualizada correctamente."})


class ClienteDashboardStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def _resolver_usuario_negocio_id(self, request) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        user_pk = int(getattr(request.user, "id", 0) or 0)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                   OR (usuario_id = %s AND %s > 0)
                ORDER BY
                    CASE
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') AND (LOWER(email) = LOWER(%s) AND %s <> '') THEN 1
                        WHEN (usuario_id = %s AND %s > 0) THEN 2
                        WHEN (LOWER(email) = LOWER(%s) AND %s <> '') THEN 3
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') THEN 4
                        ELSE 99
                    END,
                    usuario_id DESC
                LIMIT 1
                """,
                [
                    username, username, email, email, user_pk, user_pk,
                    username, username, email, email, user_pk, user_pk, email, email, username, username,
                ],
            )
            row = cursor.fetchone()
        return int(row[0]) if row else None

    def get(self, request):
        try:
            cliente_id = self._resolver_usuario_negocio_id(request)
            if not cliente_id:
                return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE(pp.avatar_url, ''),
                        COALESCE(u.email, '')
                    FROM negocio.usuario u
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    WHERE u.usuario_id = %s
                    LIMIT 1
                    """,
                    [cliente_id],
                )
                row_user = cursor.fetchone() or ("", "", "", "")
                nombre, apellido, avatar_url, email = row_user

                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM negocio.cita c
                    WHERE c.cliente_usuario_id = %s
                    """,
                    [cliente_id],
                )
                citas_totales = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE c.cliente_usuario_id = %s
                      AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                    """,
                    [cliente_id],
                )
                citas_completadas = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE c.cliente_usuario_id = %s
                      AND LOWER(COALESCE(ec.codigo, '')) IN ('pendiente', 'confirmada')
                    """,
                    [cliente_id],
                )
                citas_pendientes = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM negocio.pedido p
                    WHERE p.cliente_usuario_id = %s
                      AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                    """,
                    [cliente_id],
                )
                total_pedidos = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COUNT(*)
                    FROM negocio.pedido p
                    JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    WHERE p.cliente_usuario_id = %s
                      AND COALESCE(p.notas, '') NOT ILIKE '%%CLIP_PAGO_FALLIDO_AUTOCANCEL%%'
                      AND LOWER(COALESCE(ep.codigo, '')) IN ('pendiente', 'aceptado', 'en_camino')
                    """,
                    [cliente_id],
                )
                pedidos_activos = int((cursor.fetchone() or [0])[0] or 0)

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(p.total), 0)
                    FROM negocio.pedido p
                    JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE p.cliente_usuario_id = %s
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
                    [cliente_id],
                )
                gasto_pedidos = Decimal(str((cursor.fetchone() or [0])[0] or "0"))

                cursor.execute(
                    """
                    SELECT COALESCE(SUM(c.precio_total), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE c.cliente_usuario_id = %s
                      AND LOWER(COALESCE(ec.codigo, '')) = 'completada'
                    """,
                    [cliente_id],
                )
                gasto_citas = Decimal(str((cursor.fetchone() or [0])[0] or "0"))

                gasto_total = float((gasto_pedidos + gasto_citas).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

                cursor.execute(
                    """
                    SELECT
                        c.cita_id,
                        COALESCE(s.nombre, ''),
                        COALESCE(si.url, ''),
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha_local,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora_local,
                        COALESCE(c.duracion_min, 0),
                        LOWER(COALESCE(ec.codigo, 'pendiente')),
                        COALESCE(c.precio_total, 0),
                        COALESCE(ac.total_anticipo, 0)
                    FROM negocio.cita c
                    JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN LATERAL (
                        SELECT url
                        FROM negocio.servicio_imagen
                        WHERE servicio_id = s.servicio_id
                        ORDER BY es_principal DESC, orden ASC, servicio_imagen_id ASC
                        LIMIT 1
                    ) si ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT SUM(monto_anticipo) AS total_anticipo
                        FROM negocio.anticipo_cita
                        WHERE cita_id = c.cita_id
                          AND estado_validacion IN ('pendiente', 'validado')
                    ) ac ON TRUE
                    WHERE c.cliente_usuario_id = %s
                      AND LOWER(COALESCE(ec.codigo, '')) IN ('pendiente', 'confirmada', 'en_curso')
                      AND c.fecha_hora >= NOW()
                    ORDER BY c.fecha_hora ASC
                    LIMIT 1
                    """,
                    [cliente_id],
                )
                row_cita = cursor.fetchone()

            proxima_cita = None
            if row_cita:
                proxima_cita = {
                    "id": int(row_cita[0]),
                    "servicio_nombre": str(row_cita[1] or ""),
                    "servicio_imagen": str(row_cita[2] or ""),
                    "fecha": str(row_cita[3] or ""),
                    "hora": str(row_cita[4] or ""),
                    "duracion_minutos": int(row_cita[5] or 0),
                    "estado": str(row_cita[6] or "pendiente"),
                    "precio_total": float(Decimal(str(row_cita[7] or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                    "anticipo_pagado": float(Decimal(str(row_cita[8] or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                }

            return Response(
                {
                    "ok": True,
                    "stats": {
                        "citas_totales": citas_totales,
                        "citas_completadas": citas_completadas,
                        "citas_pendientes": citas_pendientes,
                        "total_pedidos": total_pedidos,
                        "pedidos_activos": pedidos_activos,
                        "gasto_total": gasto_total,
                        "proxima_cita": proxima_cita,
                        "nombre": str(nombre or ""),
                        "apellido": str(apellido or ""),
                        "avatar_url": str(avatar_url or ""),
                        "email": str(email or ""),
                    },
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo cargar el dashboard del cliente."}, status=500)


class CitaPoliticaPagoView(APIView):
    permission_classes = [IsAuthenticated]

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def get(self, request):
        cliente_id_raw = str(request.query_params.get("cliente_id", "") or "").strip()
        if not cliente_id_raw:
            return Response({"ok": False, "error": "cliente_id es obligatorio."}, status=400)
        try:
            cliente_id = int(cliente_id_raw)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "cliente_id inválido."}, status=400)
        if cliente_id <= 0:
            return Response({"ok": False, "error": "cliente_id inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        COALESCE(pa.porcentaje_anticipo, 50),
                        COALESCE(pa.citas_penalizacion, 3),
                        COALESCE(pa.tiempo_espera_maximo_min, 10)
                    FROM negocio.politica_anticipo pa
                    ORDER BY pa.politica_anticipo_id DESC
                    LIMIT 1
                    """
                )
                row_pol = cursor.fetchone()
                porcentaje_anticipo = int(self._to_money(row_pol[0] if row_pol else 50))
                citas_penalizacion = int(row_pol[1] if row_pol else 3)
                tiempo_espera_maximo = int(row_pol[2] if row_pol else 10)

                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE c.cliente_usuario_id = %s
                      AND LOWER(COALESCE(ec.codigo, '')) = 'no_asistio'
                    """,
                    [cliente_id],
                )
                total_inasistencias = int((cursor.fetchone() or [0])[0] or 0)
                penalizado = total_inasistencias > 0
                citas_restantes_penalizacion = citas_penalizacion if penalizado else 0

                cursor.execute(
                    """
                    SELECT
                        COALESCE(cb.banco_nombre, ''),
                        COALESCE(cb.numero_cuenta, cb.clabe, ''),
                        COALESCE(cb.titular, '')
                    FROM negocio.cuenta_bancaria cb
                    WHERE COALESCE(cb.activa, TRUE) = TRUE
                    ORDER BY cb.cuenta_bancaria_id DESC
                    LIMIT 1
                    """
                )
                row_bank = cursor.fetchone()
                banco_nombre = str(row_bank[0] or "") if row_bank else ""
                banco_cuenta = str(row_bank[1] or "") if row_bank else ""
                banco_titular = str(row_bank[2] or "") if row_bank else ""
                tiene_banco = bool(banco_nombre and banco_cuenta)

            return Response(
                {
                    "ok": True,
                    "requiere_anticipo": penalizado,
                    "porcentaje_anticipo": porcentaje_anticipo,
                    "penalizado": penalizado,
                    "total_inasistencias": total_inasistencias,
                    "citas_restantes_penalizacion": citas_restantes_penalizacion,
                    "citas_penalizacion_total": citas_penalizacion,
                    "tiempo_espera_maximo": tiempo_espera_maximo,
                    "tiene_banco": tiene_banco,
                    "banco_nombre": banco_nombre,
                    "banco_cuenta": banco_cuenta,
                    "banco_titular": banco_titular,
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo cargar la política de pago."}, status=500)


class CitasView(APIView):
    permission_classes = [IsAuthenticated]
    SLOT_MINUTES = 20

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _to_minutes(self, t) -> int:
        if t is None:
            return -1
        if isinstance(t, str):
            try:
                tt = datetime.strptime(t.strip()[:5], "%H:%M").time()
            except Exception:
                return -1
        else:
            tt = t
        return int(tt.hour) * 60 + int(tt.minute)

    def _resolver_usuario_negocio_id(self, request, cliente_id_hint: int | None = None) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        user_pk = int(getattr(request.user, "id", 0) or 0)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                   OR (usuario_id = %s AND %s > 0)
                ORDER BY
                    CASE
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') AND (LOWER(email) = LOWER(%s) AND %s <> '') THEN 1
                        WHEN (usuario_id = %s AND %s > 0) THEN 2
                        WHEN (LOWER(email) = LOWER(%s) AND %s <> '') THEN 3
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') THEN 4
                        ELSE 99
                    END,
                    usuario_id DESC
                LIMIT 1
                """,
                [
                    username, username, email, email, user_pk, user_pk,
                    username, username, email, email, user_pk, user_pk, email, email, username, username,
                ],
            )
            row = cursor.fetchone()
            if row:
                return int(row[0])

            if cliente_id_hint and cliente_id_hint > 0:
                cursor.execute(
                    """
                    SELECT usuario_id
                    FROM negocio.usuario
                    WHERE usuario_id = %s
                      AND (
                            (LOWER(username) = LOWER(%s) AND %s <> '')
                         OR (LOWER(email) = LOWER(%s) AND %s <> '')
                         OR (%s > 0 AND usuario_id = %s)
                      )
                    LIMIT 1
                    """,
                    [cliente_id_hint, username, username, email, email, user_pk, user_pk],
                )
                hinted = cursor.fetchone()
                if hinted:
                    return int(hinted[0])
        return None

    def _registrar_desfase_horario_si_aplica(
        self,
        cita_id: int,
        cliente_id: int,
        fecha_solicitada: str,
        hora_solicitada: str,
        fecha_guardada: str,
        hora_guardada: str,
    ) -> None:
        fs = str(fecha_solicitada or "").strip()
        hs = str(hora_solicitada or "").strip()[:5]
        fg = str(fecha_guardada or "").strip()
        hg = str(hora_guardada or "").strip()[:5]
        if fs != fg or hs != hg:
            logger.warning(
                "Posible desfase horario detectado en cita_id=%s cliente_id=%s solicitado=%s %s guardado=%s %s",
                cita_id,
                cliente_id,
                fs,
                hs,
                fg,
                hg,
            )

    def get(self, request):
        cliente_id = self._resolver_usuario_negocio_id(request)
        if not cliente_id:
            return Response({"ok": False, "error": "Usuario no encontrado."}, status=404)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        c.cita_id,
                        c.servicio_id,
                        COALESCE(s.nombre, ''),
                        COALESCE(si.url, ''),
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha_local,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora_local,
                        COALESCE(c.duracion_min, 0),
                        LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado_codigo,
                        COALESCE(c.precio_total, 0),
                        COALESCE(ac.total_anticipo, 0),
                        COALESCE(c.notas, ''),
                        c.fecha_creacion
                    FROM negocio.cita c
                    JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                    LEFT JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN LATERAL (
                        SELECT url
                        FROM negocio.servicio_imagen
                        WHERE servicio_id = c.servicio_id
                        ORDER BY es_principal DESC, orden ASC, servicio_imagen_id ASC
                        LIMIT 1
                    ) si ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT SUM(monto_anticipo) AS total_anticipo
                        FROM negocio.anticipo_cita
                        WHERE cita_id = c.cita_id
                          AND estado_validacion IN ('pendiente', 'validado')
                    ) ac ON TRUE
                    WHERE c.cliente_usuario_id = %s
                    ORDER BY c.fecha_hora DESC, c.cita_id DESC
                    """,
                    [cliente_id],
                )
                rows = cursor.fetchall()

            citas = []
            for row in rows:
                citas.append(
                    {
                        "id": int(row[0]),
                        "servicio_id": int(row[1]),
                        "servicio_nombre": str(row[2] or ""),
                        "servicio_imagen": str(row[3] or ""),
                        "fecha": str(row[4] or ""),
                        "hora": str(row[5] or ""),
                        "duracion_minutos": int(row[6] or 0),
                        "estado": str(row[7] or "pendiente"),
                        "precio_total": float(Decimal(str(row[8] or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                        "anticipo_pagado": float(Decimal(str(row[9] or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
                        "notas": str(row[10] or ""),
                        "fecha_creacion": row[11].isoformat() if row[11] else "",
                    }
                )

            return Response({"ok": True, "citas": citas})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudieron cargar tus citas."}, status=500)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        try:
            cliente_id = int(data.get("cliente_id", 0) or 0)
            barbero_id = int(data.get("barbero_id", 0) or 0)
            servicio_id = int(data.get("servicio_id", 0) or 0)
            duracion_min = int(data.get("duracion_minutos", 0) or 0)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "IDs o duración inválidos."}, status=400)

        fecha_str = str(data.get("fecha", "") or "").strip()
        hora_str = str(data.get("hora", "") or "").strip()
        comprobante_pago = str(data.get("comprobante_pago", "") or "").strip()
        notas = str(data.get("notas", "") or "").strip()
        codigo_descuento = str(data.get("codigo_descuento", "") or "").strip().upper()
        descuento_monto = self._to_money(data.get("descuento_monto", 0))
        precio_total = self._to_money(data.get("precio_total", 0))
        anticipo_pagado = self._to_money(data.get("anticipo_pagado", 0))

        if cliente_id <= 0 or barbero_id <= 0 or servicio_id <= 0:
            return Response({"ok": False, "error": "cliente_id, barbero_id y servicio_id son obligatorios."}, status=400)
        if duracion_min <= 0:
            return Response({"ok": False, "error": "duracion_minutos inválida."}, status=400)
        if precio_total <= Decimal("0.00"):
            return Response({"ok": False, "error": "precio_total debe ser mayor a cero."}, status=400)
        if anticipo_pagado < Decimal("0.00") or anticipo_pagado > precio_total:
            return Response({"ok": False, "error": "anticipo_pagado fuera de rango."}, status=400)

        try:
            fecha_obj = date.fromisoformat(fecha_str)
            hora_obj = datetime.strptime(hora_str[:5], "%H:%M").time()
        except ValueError:
            return Response({"ok": False, "error": "Fecha u hora inválida."}, status=400)

        inicio_min = int(hora_obj.hour) * 60 + int(hora_obj.minute)
        if inicio_min % self.SLOT_MINUTES != 0:
            return Response({"ok": False, "error": "Ese horario no está disponible."}, status=400)
        fin_min = inicio_min + duracion_min

        usuario_negocio_id = self._resolver_usuario_negocio_id(request, cliente_id_hint=cliente_id)
        if not usuario_negocio_id:
            return Response({"ok": False, "error": "No autorizado para crear citas para este usuario."}, status=403)
        # Nunca confiar en cliente_id enviado por el frontend.
        cliente_id = int(usuario_negocio_id)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT e.empleado_id, e.empresa_id
                        FROM negocio.empleado e
                        JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
                        JOIN negocio.rol r ON r.rol_id = ur.rol_id
                        WHERE e.empleado_id = %s
                          AND COALESCE(e.activo, FALSE) = TRUE
                          AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                        LIMIT 1
                        """,
                        [barbero_id],
                    )
                    row_barbero = cursor.fetchone()
                    if not row_barbero:
                        return Response({"ok": False, "error": "Barbero no válido."}, status=400)
                    empresa_id = int(row_barbero[1])

                    cursor.execute(
                        """
                        SELECT COALESCE(s.precio_base, 0), COALESCE(s.duracion_base_min, 0), COALESCE(s.activo, FALSE)
                        FROM negocio.servicio s
                        WHERE s.servicio_id = %s
                        LIMIT 1
                        """,
                        [servicio_id],
                    )
                    row_serv = cursor.fetchone()
                    if not row_serv:
                        return Response({"ok": False, "error": "Servicio no encontrado."}, status=404)
                    precio_base = self._to_money(row_serv[0])
                    duracion_base = int(row_serv[1] or 0)
                    activo_serv = bool(row_serv[2])
                    if not activo_serv:
                        return Response({"ok": False, "error": "Servicio inactivo."}, status=400)
                    if duracion_base > 0 and duracion_min != duracion_base:
                        duracion_min = duracion_base
                        fin_min = inicio_min + duracion_min
                    if precio_total > precio_base:
                        return Response({"ok": False, "error": "precio_total no puede exceder el precio del servicio."}, status=400)

                    cursor.execute(
                        """
                        SELECT 1
                        FROM negocio.barbero_servicio
                        WHERE empleado_id = %s AND servicio_id = %s
                        LIMIT 1
                        """,
                        [barbero_id, servicio_id],
                    )
                    if not cursor.fetchone():
                        return Response({"ok": False, "error": "El barbero no está asignado a ese servicio."}, status=400)

                    dia_semana = int(fecha_obj.weekday())
                    cursor.execute(
                        """
                        SELECT COALESCE(abierto, FALSE), hora_apertura, hora_cierre
                        FROM negocio.horario_negocio
                        WHERE empresa_id = %s AND dia_semana = %s
                        LIMIT 1
                        """,
                        [empresa_id, dia_semana],
                    )
                    row_neg = cursor.fetchone()
                    if not row_neg or not bool(row_neg[0]):
                        return Response({"ok": False, "error": "El negocio no abre ese día."}, status=400)
                    neg_ini = self._to_minutes(row_neg[1])
                    neg_fin = self._to_minutes(row_neg[2])
                    if inicio_min < neg_ini or fin_min > neg_fin:
                        return Response({"ok": False, "error": "Horario fuera de atención del negocio."}, status=400)

                    cursor.execute(
                        """
                        SELECT COALESCE(trabaja, FALSE), hora_inicio, hora_fin
                        FROM negocio.empleado_horario_dia
                        WHERE empleado_id = %s AND dia_semana = %s
                        LIMIT 1
                        """,
                        [barbero_id, dia_semana],
                    )
                    row_emp = cursor.fetchone()
                    if not row_emp or not bool(row_emp[0]):
                        return Response({"ok": False, "error": "El barbero no trabaja ese día."}, status=400)
                    emp_ini = self._to_minutes(row_emp[1])
                    emp_fin = self._to_minutes(row_emp[2])
                    if inicio_min < emp_ini or fin_min > emp_fin:
                        return Response({"ok": False, "error": "Horario fuera de jornada del barbero."}, status=400)

                    cursor.execute(
                        """
                        SELECT 1
                        FROM negocio.empleado_dia_libre
                        WHERE empleado_id = %s
                          AND fecha = %s
                          AND LOWER(COALESCE(estado, '')) = 'aprobado'
                        LIMIT 1
                        """,
                        [barbero_id, fecha_obj],
                    )
                    if cursor.fetchone():
                        return Response({"ok": False, "error": "El barbero tiene día libre aprobado."}, status=400)

                    cursor.execute(
                        """
                        SELECT 1
                        FROM negocio.empleado_vacacion
                        WHERE empleado_id = %s
                          AND %s BETWEEN fecha_inicio AND fecha_fin
                          AND LOWER(COALESCE(estado, '')) = 'aprobada'
                        LIMIT 1
                        """,
                        [barbero_id, fecha_obj],
                    )
                    if cursor.fetchone():
                        return Response({"ok": False, "error": "El barbero está en vacaciones aprobadas."}, status=400)

                    cursor.execute(
                        """
                        SELECT hora_inicio, hora_fin
                        FROM negocio.empleado_descanso
                        WHERE empleado_id = %s AND dia_semana = %s
                        """,
                        [barbero_id, dia_semana],
                    )
                    for d0, d1 in cursor.fetchall():
                        d_ini = self._to_minutes(d0)
                        d_fin = self._to_minutes(d1)
                        if inicio_min < d_fin and d_ini < fin_min:
                            return Response({"ok": False, "error": "La cita invade horario de descanso del barbero."}, status=400)

                    cursor.execute(
                        sql_citas_ocupadas_dia(),
                        [barbero_id, fecha_obj],
                    )
                    for hora_local, dmin in cursor.fetchall():
                        if not hora_local:
                            continue
                        c_ini = int(hora_local.hour) * 60 + int(hora_local.minute)
                        c_fin = c_ini + int(dmin or 0)
                        if inicio_min < c_fin and c_ini < fin_min:
                            return Response({"ok": False, "error": "Ese horario ya está ocupado."}, status=400)

                    cursor.execute(
                        """
                        SELECT estado_cita_id
                        FROM negocio.estado_cita
                        WHERE LOWER(COALESCE(codigo, '')) IN ('pendiente', 'confirmada')
                        ORDER BY CASE WHEN LOWER(codigo) = 'pendiente' THEN 1 ELSE 2 END
                        LIMIT 1
                        """
                    )
                    row_estado = cursor.fetchone()
                    if not row_estado:
                        return Response({"ok": False, "error": "No hay estado de cita configurado."}, status=500)
                    estado_cita_id = int(row_estado[0])

                    fecha_hora_dt = combine_fecha_hora_mx(fecha_obj, hora_obj)
                    notas_final = notas
                    if codigo_descuento or descuento_monto > 0:
                        promo_payload = {
                            "codigo": codigo_descuento,
                            "descuento_monto": str(descuento_monto),
                            "precio_base": str(precio_base),
                            "precio_total": str(precio_total),
                        }
                        marker = f"[PROMO_CITA]{json.dumps(promo_payload, ensure_ascii=False)}"
                        notas_final = f"{notas_final}\n{marker}".strip() if notas_final else marker

                    cursor.execute(
                        """
                        INSERT INTO negocio.cita (
                            cliente_usuario_id,
                            empleado_id,
                            servicio_id,
                            estado_cita_id,
                            silla_id,
                            fecha_hora,
                            duracion_min,
                            precio_total,
                            notas,
                            creado_por_rol
                        )
                        VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, 'cliente')
                        RETURNING cita_id
                        """,
                        [
                            cliente_id,
                            barbero_id,
                            servicio_id,
                            estado_cita_id,
                            fecha_hora_dt,
                            duracion_min,
                            precio_total,
                            notas_final or None,
                        ],
                    )
                    cita_id = int(cursor.fetchone()[0])

                    cursor.execute(
                        """
                        INSERT INTO negocio.cita_estado_historial (cita_id, estado_cita_id, cambiado_por_usuario_id, motivo)
                        VALUES (%s, %s, %s, %s)
                        """,
                        [cita_id, estado_cita_id, cliente_id, "Creación desde checkout cliente"],
                    )

                    # Validación defensiva para detectar desfases de horario en persistencia.
                    cursor.execute(
                        """
                        SELECT
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD'),
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI')
                        FROM negocio.cita c
                        WHERE c.cita_id = %s
                        LIMIT 1
                        """,
                        [cita_id],
                    )
                    row_guardada = cursor.fetchone()
                    if row_guardada:
                        self._registrar_desfase_horario_si_aplica(
                            cita_id=cita_id,
                            cliente_id=cliente_id,
                            fecha_solicitada=fecha_str,
                            hora_solicitada=hora_str,
                            fecha_guardada=str(row_guardada[0] or ""),
                            hora_guardada=str(row_guardada[1] or ""),
                        )

                    if anticipo_pagado > Decimal("0.00") and comprobante_pago:
                        cursor.execute(
                            """
                            SELECT metodo_pago_id
                            FROM negocio.metodo_pago_catalogo
                            WHERE LOWER(COALESCE(codigo, '')) = 'transferencia'
                            LIMIT 1
                            """
                        )
                        row_mp = cursor.fetchone()
                        if row_mp:
                            metodo_pago_id = int(row_mp[0])
                            cursor.execute(
                                """
                                INSERT INTO negocio.anticipo_cita (
                                    cita_id, monto_anticipo, metodo_pago_id, comprobante_url, estado_validacion
                                )
                                VALUES (%s, %s, %s, %s, 'pendiente')
                                """,
                                [cita_id, anticipo_pagado, metodo_pago_id, comprobante_pago],
                            )

            return Response(
                {
                    "ok": True,
                    "id": cita_id,
                    "fecha": fecha_str,
                    "hora": hora_str[:5],
                    "precio_total": float(precio_total),
                    "anticipo_pagado": float(anticipo_pagado),
                    "comprobante_pago": comprobante_pago,
                },
                status=201,
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo crear la cita."}, status=500)


class SecretariaCitasTransferenciasView(APIView):
    permission_classes = [IsAuthenticated]

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _resolver_usuario_negocio_id(self, request) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                ORDER BY usuario_id ASC
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        return int(row[0]) if row else None

    def _resolver_rol(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
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

    def _ensure_permiso(self, request):
        rol = self._resolver_rol(request)
        if rol not in {"secretaria", "administrador", "admin"}:
            return Response({"ok": False, "error": "No autorizado."}, status=403)
        return None

    def _estado_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            """
            SELECT estado_cita_id
            FROM negocio.estado_cita
            WHERE LOWER(COALESCE(codigo, '')) = LOWER(%s)
            LIMIT 1
            """,
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _extraer_cancelacion_desde_notas(self, notas: str) -> tuple[str, str]:
        txt = str(notas or "")
        marker = "[CITA_CANCELACION]"
        if marker not in txt:
            return "", ""
        payload = txt.split(marker)[-1].strip()
        try:
            data = json.loads(payload)
            return str(data.get("motivo", "") or ""), str(data.get("notas", "") or "")
        except Exception:
            return "", ""

    def _append_marker(self, notas: str, marker: str, payload: dict[str, Any]) -> str:
        block = f"[{marker}]{json.dumps(payload, ensure_ascii=False)}"
        base = str(notas or "").strip()
        return f"{base}\n{block}".strip() if base else block

    def get(self, request, cita_id: int | None = None):
        permiso = self._ensure_permiso(request)
        if permiso:
            return permiso
        try:
            with connection.cursor() as cursor:
                if cita_id is None:
                    cursor.execute(
                        """
                        SELECT
                            c.cita_id,
                            TRIM(
                                COALESCE(pp.nombres, '') || ' ' ||
                                COALESCE(pp.apellido_paterno, '') || ' ' ||
                                COALESCE(pp.apellido_materno, '')
                            ) AS cliente_nombre,
                            COALESCE(u.email, '') AS cliente_email,
                            COALESCE(pp.telefono, '') AS cliente_telefono,
                            COALESCE(s.nombre, '') AS servicio_nombre,
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha_local,
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora_local,
                            LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado,
                            COALESCE(c.precio_total, 0) AS precio_total,
                            COALESCE(ac.monto_anticipo, 0) AS anticipo_pagado,
                            COALESCE(ac.comprobante_url, '') AS comprobante_pago,
                            LOWER(COALESCE(ac.estado_validacion, 'pendiente')) = 'validado' AS anticipo_validado,
                            c.fecha_creacion
                        FROM negocio.cita c
                        JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                        LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                        JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                        LEFT JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                        LEFT JOIN LATERAL (
                            SELECT
                                ac.anticipo_id,
                                ac.monto_anticipo,
                                ac.comprobante_url,
                                ac.estado_validacion
                            FROM negocio.anticipo_cita ac
                            JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = ac.metodo_pago_id
                            WHERE ac.cita_id = c.cita_id
                              AND LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                            ORDER BY ac.fecha_envio DESC, ac.anticipo_id DESC
                            LIMIT 1
                        ) ac ON TRUE
                        WHERE COALESCE(ac.monto_anticipo, 0) > 0
                        ORDER BY
                            CASE
                                WHEN LOWER(COALESCE(ac.estado_validacion, 'pendiente')) = 'pendiente' THEN 1
                                WHEN LOWER(COALESCE(ac.estado_validacion, 'pendiente')) = 'validado' THEN 2
                                ELSE 3
                            END,
                            c.fecha_hora ASC,
                            c.cita_id ASC
                        """
                    )
                    rows = cursor.fetchall()
                    citas = []
                    for row in rows:
                        citas.append(
                            {
                                "id": int(row[0]),
                                "cliente_nombre": str(row[1] or ""),
                                "cliente_email": str(row[2] or ""),
                                "cliente_telefono": str(row[3] or ""),
                                "servicio_nombre": str(row[4] or ""),
                                "fecha": str(row[5] or ""),
                                "hora": str(row[6] or ""),
                                "estado": str(row[7] or "pendiente"),
                                "precio_total": float(self._to_money(row[8])),
                                "anticipo_pagado": float(self._to_money(row[9])),
                                "comprobante_pago": str(row[10] or ""),
                                "anticipo_validado": bool(row[11]),
                                "fecha_creacion": row[12].isoformat() if row[12] else "",
                            }
                        )
                    return Response({"ok": True, "citas": citas})

                cursor.execute(
                    """
                    SELECT
                        c.cita_id,
                        c.cliente_usuario_id,
                        TRIM(
                            COALESCE(pp.nombres, '') || ' ' ||
                            COALESCE(pp.apellido_paterno, '') || ' ' ||
                            COALESCE(pp.apellido_materno, '')
                        ) AS cliente_nombre,
                        COALESCE(u.email, '') AS cliente_email,
                        COALESCE(pp.telefono, '') AS cliente_telefono,
                        TRIM(COALESCE(ppb.nombres, '') || ' ' || COALESCE(ppb.apellido_paterno, '')) AS barbero_nombre,
                        COALESCE(s.nombre, '') AS servicio_nombre,
                        COALESCE(si.url, '') AS servicio_imagen,
                        COALESCE(s.precio_base, 0) AS servicio_precio,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha_local,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora_local,
                        COALESCE(c.duracion_min, 0),
                        LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado,
                        COALESCE(c.precio_total, 0) AS precio_total,
                        COALESCE(ac.monto_anticipo, 0) AS anticipo_pagado,
                        COALESCE(ac.comprobante_url, '') AS comprobante_pago,
                        LOWER(COALESCE(ac.estado_validacion, 'pendiente')) = 'validado' AS anticipo_validado,
                        COALESCE(c.notas, '') AS notas,
                        c.fecha_creacion,
                        c.fecha_actualizacion
                    FROM negocio.cita c
                    JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    JOIN negocio.empleado eb ON eb.empleado_id = c.empleado_id
                    JOIN negocio.usuario ub ON ub.usuario_id = eb.usuario_id
                    LEFT JOIN negocio.perfil_persona ppb ON ppb.usuario_id = ub.usuario_id
                    JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                    LEFT JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN LATERAL (
                        SELECT url
                        FROM negocio.servicio_imagen
                        WHERE servicio_id = c.servicio_id
                        ORDER BY es_principal DESC, orden ASC, servicio_imagen_id ASC
                        LIMIT 1
                    ) si ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT
                            ac.anticipo_id,
                            ac.monto_anticipo,
                            ac.comprobante_url,
                            ac.estado_validacion
                        FROM negocio.anticipo_cita ac
                        JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = ac.metodo_pago_id
                        WHERE ac.cita_id = c.cita_id
                          AND LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                        ORDER BY ac.fecha_envio DESC, ac.anticipo_id DESC
                        LIMIT 1
                    ) ac ON TRUE
                    WHERE c.cita_id = %s
                    LIMIT 1
                    """,
                    [cita_id],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Cita no encontrada."}, status=404)
                motivo_cancelacion, notas_cancelacion = self._extraer_cancelacion_desde_notas(str(row[17] or ""))
                precio_total = self._to_money(row[13])
                anticipo = self._to_money(row[14])
                restante = max(Decimal("0.00"), precio_total - anticipo)
                return Response(
                    {
                        "ok": True,
                        "cita": {
                            "id": int(row[0]),
                            "cliente_id": int(row[1]),
                            "cliente_nombre": str(row[2] or ""),
                            "cliente_email": str(row[3] or ""),
                            "cliente_telefono": str(row[4] or ""),
                            "barbero_nombre": str(row[5] or ""),
                            "servicio_nombre": str(row[6] or ""),
                            "servicio_imagen": str(row[7] or ""),
                            "servicio_precio": float(self._to_money(row[8])),
                            "fecha": str(row[9] or ""),
                            "hora": str(row[10] or ""),
                            "duracion_minutos": int(row[11] or 0),
                            "estado": str(row[12] or "pendiente"),
                            "precio_total": float(precio_total),
                            "anticipo_pagado": float(anticipo),
                            "comprobante_pago": str(row[15] or ""),
                            "anticipo_validado": bool(row[16]),
                            "restante": float(restante),
                            "notas": str(row[17] or ""),
                            "motivo_cancelacion": motivo_cancelacion,
                            "notas_cancelacion": notas_cancelacion,
                            "fecha_creacion": row[18].isoformat() if row[18] else "",
                            "fecha_modificacion": row[19].isoformat() if row[19] else "",
                        },
                    }
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo consultar transferencias de citas."}, status=500)

    def put(self, request, cita_id: int):
        permiso = self._ensure_permiso(request)
        if permiso:
            return permiso
        data = request.data if isinstance(request.data, dict) else {}
        marcar_validado = bool(data.get("anticipo_validado", False))
        rechazar_comprobante = bool(data.get("rechazar_comprobante", False))
        estado_nuevo = str(data.get("estado", "") or "").strip().lower()
        notas_cancelacion = str(data.get("notas_cancelacion", "") or "").strip()
        usuario_validador_id = self._resolver_usuario_negocio_id(request)
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            c.cita_id,
                            c.estado_cita_id,
                            COALESCE(c.notas, ''),
                            ac.anticipo_id,
                            COALESCE(ac.estado_validacion, 'pendiente')
                        FROM negocio.cita c
                        LEFT JOIN LATERAL (
                            SELECT
                                ac.anticipo_id,
                                ac.estado_validacion
                            FROM negocio.anticipo_cita ac
                            JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = ac.metodo_pago_id
                            WHERE ac.cita_id = c.cita_id
                              AND LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                            ORDER BY ac.fecha_envio DESC, ac.anticipo_id DESC
                            LIMIT 1
                        ) ac ON TRUE
                        WHERE c.cita_id = %s
                        LIMIT 1
                        """,
                        [cita_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Cita no encontrada."}, status=404)
                    _cita_id, estado_actual_id, notas_actuales, anticipo_id, estado_validacion_actual = row

                    if marcar_validado and anticipo_id:
                        cursor.execute(
                            """
                            UPDATE negocio.anticipo_cita
                            SET estado_validacion = 'validado',
                                fecha_validacion = NOW(),
                                validado_por_usuario_id = %s
                            WHERE anticipo_id = %s
                            """,
                            [usuario_validador_id, int(anticipo_id)],
                        )
                        estado_confirmada = self._estado_id(cursor, "confirmada")
                        if estado_confirmada:
                            cursor.execute(
                                "UPDATE negocio.cita SET estado_cita_id = %s WHERE cita_id = %s",
                                [estado_confirmada, cita_id],
                            )
                        notas_final = self._append_marker(
                            str(notas_actuales or ""),
                            "ANTICIPO_VALIDADO",
                            {"por_usuario_id": usuario_validador_id, "fecha": timezone.now().isoformat()},
                        )
                        cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas_final, cita_id])
                        return Response({"ok": True, "mensaje": "Anticipo validado y cita confirmada.", "horario_liberado": False})

                    if rechazar_comprobante and anticipo_id:
                        cursor.execute(
                            """
                            UPDATE negocio.anticipo_cita
                            SET estado_validacion = 'rechazado',
                                fecha_validacion = NOW(),
                                validado_por_usuario_id = %s
                            WHERE anticipo_id = %s
                            """,
                            [usuario_validador_id, int(anticipo_id)],
                        )
                        estado_cancelada = self._estado_id(cursor, "cancelada")
                        if not estado_cancelada:
                            return Response({"ok": False, "error": "No existe estado cancelada."}, status=500)
                        cursor.execute(
                            "UPDATE negocio.cita SET estado_cita_id = %s WHERE cita_id = %s",
                            [estado_cancelada, cita_id],
                        )
                        notas_final = self._append_marker(
                            str(notas_actuales or ""),
                            "CITA_CANCELACION",
                            {
                                "motivo": "comprobante_invalido",
                                "notas": notas_cancelacion or "Comprobante rechazado por secretaría",
                                "por_usuario_id": usuario_validador_id,
                                "fecha": timezone.now().isoformat(),
                            },
                        )
                        cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas_final, cita_id])
                        return Response(
                            {
                                "ok": True,
                                "mensaje": "Comprobante rechazado. Cita cancelada y horario liberado.",
                                "motivo_cancelacion": "comprobante_invalido",
                                "horario_liberado": True,
                            }
                        )

                    if estado_nuevo:
                        estado_id = self._estado_id(cursor, estado_nuevo)
                        if not estado_id:
                            return Response({"ok": False, "error": f"Estado '{estado_nuevo}' no válido."}, status=400)
                        cursor.execute(
                            "UPDATE negocio.cita SET estado_cita_id = %s WHERE cita_id = %s",
                            [estado_id, cita_id],
                        )
                        horario_liberado = estado_nuevo == "cancelada"
                        notas_final = str(notas_actuales or "")
                        motivo = ""
                        if horario_liberado:
                            motivo = str(data.get("motivo_cancelacion", "") or "").strip() or "secretaria_cancelo"
                            notas_final = self._append_marker(
                                notas_final,
                                "CITA_CANCELACION",
                                {
                                    "motivo": motivo,
                                    "notas": notas_cancelacion or "Cancelada por secretaría",
                                    "por_usuario_id": usuario_validador_id,
                                    "fecha": timezone.now().isoformat(),
                                },
                            )
                            cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas_final, cita_id])
                        cursor.execute(
                            """
                            INSERT INTO negocio.cita_estado_historial (cita_id, estado_cita_id, cambiado_por_usuario_id, motivo)
                            VALUES (%s, %s, %s, %s)
                            """,
                            [cita_id, estado_id, usuario_validador_id, f"Cambio por secretaría a {estado_nuevo}"],
                        )
                        return Response(
                            {
                                "ok": True,
                                "mensaje": "Cita actualizada correctamente.",
                                "motivo_cancelacion": motivo,
                                "horario_liberado": horario_liberado,
                            }
                        )

                    # Si no llegó acción explícita, devolver estado actual para evitar errores silenciosos.
                    return Response(
                        {
                            "ok": True,
                            "mensaje": "Sin cambios aplicados.",
                            "estado_validacion_actual": str(estado_validacion_actual or ""),
                            "estado_cita_id": int(estado_actual_id or 0),
                        }
                    )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo actualizar la cita."}, status=500)


class SecretariaDashboardView(APIView):
    """Resumen del día para secretaría: mismas reglas de negocio que el panel admin (solo lectura)."""

    permission_classes = [IsAuthenticated]

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _resolver_rol(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
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

    def _ensure_permiso(self, request):
        rol = self._resolver_rol(request)
        if rol not in {"secretaria", "administrador", "admin"}:
            return Response({"ok": False, "error": "No autorizado."}, status=403)
        return None

    def _row_value(self, row: Any, idx: int, default: Any = 0) -> Any:
        if not row:
            return default
        if idx < 0 or idx >= len(row):
            return default
        return row[idx] if row[idx] is not None else default

    def get(self, request):
        permiso = self._ensure_permiso(request)
        if permiso:
            return permiso
        try:
            with connection.cursor() as cursor:
                # Ventas del día (misma lógica que AdminDashboardView).
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
                                        AND LOWER(COALESCE(ep.codigo, '')) IN (
                                            'aceptado', 'confirmado', 'pago_validado', 'en_camino',
                                            'enviado', 'preparando', 'entregado'
                                        )
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

                ventas_dia = round(pedidos_hoy + mostrador_hoy + anticipos_hoy + restantes_hoy, 2)

                hoy_mx = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City')::date"

                cursor.execute(
                    f"""
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE((c.fecha_hora AT TIME ZONE 'America/Mexico_City')) = {hoy_mx}
                      AND LOWER(COALESCE(ec.codigo, '')) <> 'cancelada'
                    """
                )
                citas_hoy = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    f"""
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE((c.fecha_hora AT TIME ZONE 'America/Mexico_City')) = {hoy_mx}
                      AND LOWER(COALESCE(ec.codigo, '')) = 'pendiente'
                    """
                )
                citas_por_confirmar = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    """
                    SELECT COALESCE(COUNT(*), 0)
                    FROM negocio.cita c
                    JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    LEFT JOIN LATERAL (
                        SELECT
                            ac.monto_anticipo,
                            ac.comprobante_url,
                            ac.estado_validacion
                        FROM negocio.anticipo_cita ac
                        JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = ac.metodo_pago_id
                        WHERE ac.cita_id = c.cita_id
                          AND LOWER(COALESCE(mp.codigo, '')) = 'transferencia'
                        ORDER BY ac.fecha_envio DESC, ac.anticipo_id DESC
                        LIMIT 1
                    ) ac ON TRUE
                    WHERE COALESCE(ac.monto_anticipo, 0) > 0
                      AND LOWER(COALESCE(ac.estado_validacion, 'pendiente')) = 'pendiente'
                      AND COALESCE(TRIM(ac.comprobante_url), '') <> ''
                      AND LOWER(COALESCE(ec.codigo, '')) <> 'cancelada'
                    """
                )
                transferencias_pendientes = int(self._row_value(cursor.fetchone(), 0, 0))

                cursor.execute(
                    f"""
                    SELECT
                        c.cita_id,
                        TRIM(
                            COALESCE(pp.nombres, '') || ' ' ||
                            COALESCE(pp.apellido_paterno, '') || ' ' ||
                            COALESCE(pp.apellido_materno, '')
                        ) AS cliente_nombre,
                        COALESCE(pp.telefono, '') AS cliente_telefono,
                        COALESCE(s.nombre, '') AS servicio_nombre,
                        TRIM(COALESCE(ppb.nombres, '') || ' ' || COALESCE(ppb.apellido_paterno, '')) AS barbero_nombre,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha_local,
                        TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora_local,
                        LOWER(COALESCE(ec.codigo, 'pendiente')) AS estado
                    FROM negocio.cita c
                    JOIN negocio.usuario u ON u.usuario_id = c.cliente_usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    JOIN negocio.empleado eb ON eb.empleado_id = c.empleado_id
                    JOIN negocio.usuario ub ON ub.usuario_id = eb.usuario_id
                    LEFT JOIN negocio.perfil_persona ppb ON ppb.usuario_id = ub.usuario_id
                    JOIN negocio.servicio s ON s.servicio_id = c.servicio_id
                    LEFT JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
                    WHERE DATE((c.fecha_hora AT TIME ZONE 'America/Mexico_City')) = {hoy_mx}
                      AND LOWER(COALESCE(ec.codigo, '')) <> 'cancelada'
                    ORDER BY c.fecha_hora ASC, c.cita_id ASC
                    LIMIT 40
                    """
                )
                citas_rows = cursor.fetchall()
                citas_hoy_list = [
                    {
                        "id": int(r[0]),
                        "cliente_nombre": str(r[1] or "").strip() or "Cliente",
                        "cliente_telefono": str(r[2] or ""),
                        "servicio_nombre": str(r[3] or ""),
                        "barbero_nombre": str(r[4] or "").strip() or "Barbero",
                        "fecha": str(r[5] or ""),
                        "hora": str(r[6] or ""),
                        "estado": str(r[7] or "pendiente"),
                    }
                    for r in citas_rows
                ]

                cursor.execute(
                    f"""
                    SELECT
                        TO_CHAR((vm.fecha AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI') AS hora,
                        COALESCE(
                            NULLIF(
                                TRIM(
                                    CONCAT(COALESCE(pp.nombres, ''), ' ', COALESCE(pp.apellido_paterno, ''))
                                ),
                                ''
                            ),
                            u.email,
                            'Mostrador'
                        ) AS cliente_nombre,
                        COALESCE(pr.nombre, 'Producto') AS concepto,
                        COALESCE(vmi.cantidad, 0) AS unidades,
                        COALESCE(vmi.subtotal, 0) AS total
                    FROM negocio.venta_mostrador_item vmi
                    JOIN negocio.venta_mostrador vm ON vm.venta_mostrador_id = vmi.venta_mostrador_id
                    JOIN negocio.producto pr ON pr.producto_id = vmi.producto_id
                    LEFT JOIN negocio.usuario u ON u.usuario_id = vm.cliente_usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    WHERE DATE((vm.fecha AT TIME ZONE 'America/Mexico_City')) = {hoy_mx}
                      AND COALESCE(vm.cancelada, FALSE) = FALSE
                    ORDER BY vm.fecha DESC, vmi.venta_mostrador_item_id DESC
                    LIMIT 20
                    """
                )
                mov_rows = cursor.fetchall()
                movimientos_dia = [
                    {
                        "hora": str(r[0] or ""),
                        "cliente_nombre": str(r[1] or "Cliente"),
                        "concepto": str(r[2] or ""),
                        "metodo": "Mostrador",
                        "unidades": int(r[3] or 0),
                        "total": float(self._to_money(r[4])),
                    }
                    for r in mov_rows
                ]

            return Response(
                {
                    "ok": True,
                    "stats": {
                        "citas_hoy": citas_hoy,
                        "citas_por_confirmar": citas_por_confirmar,
                        "ventas_dia": ventas_dia,
                        "transferencias_pendientes": transferencias_pendientes,
                    },
                    "citas_hoy": citas_hoy_list,
                    "movimientos_dia": movimientos_dia,
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo cargar el panel de secretaría."}, status=500)


class PedidosView(APIView):
    permission_classes = [IsAuthenticated]
    STOCK_DESCONTADO_MARKER = "PEDIDO_STOCK_DESCONTADO"
    STOCK_REPUESTO_MARKER = "PEDIDO_STOCK_REPUESTO"

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _append_nota(self, actual: str | None, marker: str, payload: dict) -> str:
        base = str(actual or "").rstrip()
        bloque = f"[{marker}]{json.dumps(payload, ensure_ascii=False)}"
        return f"{base}\n{bloque}".strip() if base else bloque

    def _get_tipo_movimiento_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            """
            SELECT tipo_movimiento_id
            FROM negocio.tipo_movimiento_inventario
            WHERE LOWER(COALESCE(codigo, '')) = LOWER(%s)
            LIMIT 1
            """,
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _get_negocio_usuario_id(self, request_user) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE LOWER(username) = LOWER(%s) OR LOWER(email) = LOWER(%s)
                ORDER BY usuario_id ASC
                LIMIT 1
                """,
                [request_user.username, request_user.email],
            )
            row = cursor.fetchone()
        return int(row[0]) if row else None

    def _calcular_descuento_2x1(self, items: list[dict]) -> Decimal:
        precios: list[Decimal] = []
        for item in items:
            cantidad = int(item.get("cantidad") or 0)
            precio = self._to_money(item.get("precio_unitario"))
            if cantidad <= 0 or precio <= 0:
                continue
            precios.extend([precio] * min(cantidad, 500))
        if len(precios) < 2:
            return Decimal("0.00")
        precios.sort(reverse=True)
        descuento = Decimal("0.00")
        for idx in range(1, len(precios), 2):
            descuento += precios[idx]
        return descuento.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    def _calcular_descuento_producto_gratis(self, items: list[dict]) -> Decimal:
        precios: list[Decimal] = []
        for item in items:
            cantidad = int(item.get("cantidad") or 0)
            precio = self._to_money(item.get("precio_unitario"))
            if cantidad <= 0 or precio <= 0:
                continue
            precios.extend([precio] * min(cantidad, 500))
        if not precios:
            return Decimal("0.00")
        return min(precios).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    def _resolver_descuento(self, codigo: str, subtotal: Decimal, items: list[dict]) -> tuple[Decimal, str]:
        codigo_norm = str(codigo or "").strip().upper()
        if not codigo_norm:
            return Decimal("0.00"), ""
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    promocion_id,
                    tipo_descuento,
                    aplica_en,
                    valor_descuento,
                    fecha_inicio,
                    fecha_fin,
                    requiere_compra_minima,
                    monto_compra_minima,
                    limite_usos,
                    usos_actuales,
                    activa
                FROM negocio.promocion
                WHERE UPPER(COALESCE(codigo, '')) = %s
                LIMIT 1
                """,
                [codigo_norm],
            )
            row = cursor.fetchone()
        if not row:
            return Decimal("0.00"), "Código inválido o no existe."

        (
            _promocion_id,
            tipo_descuento,
            aplica_en,
            valor_descuento,
            fecha_inicio,
            fecha_fin,
            requiere_compra_minima,
            monto_compra_minima,
            limite_usos,
            usos_actuales,
            activa,
        ) = row

        hoy = date.today()
        if not bool(activa):
            return Decimal("0.00"), "La promoción está pausada."
        if fecha_inicio and hoy < fecha_inicio:
            return Decimal("0.00"), "La promoción aún no inicia."
        if fecha_fin and hoy > fecha_fin:
            return Decimal("0.00"), "La promoción ya finalizó."
        if str(aplica_en or "").strip().lower() not in {"productos", "ambos"}:
            return Decimal("0.00"), "Esta promoción no aplica a productos."
        if limite_usos is not None and int(usos_actuales or 0) >= int(limite_usos):
            return Decimal("0.00"), "La promoción alcanzó su límite de usos."
        if bool(requiere_compra_minima):
            minimo = self._to_money(monto_compra_minima)
            if subtotal < minimo:
                return Decimal("0.00"), f"Compra mínima requerida: ${float(minimo):.2f} MXN."

        valor = self._to_money(valor_descuento)
        tipo = str(tipo_descuento or "").strip().lower()
        descuento = Decimal("0.00")
        if tipo == "porcentaje":
            if valor <= 0 or valor > 100:
                return Decimal("0.00"), "Configuración de porcentaje inválida."
            descuento = (subtotal * valor / Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        elif tipo == "monto_fijo":
            descuento = min(valor, subtotal).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        elif tipo == "2x1":
            descuento = self._calcular_descuento_2x1(items)
            if descuento <= 0:
                return Decimal("0.00"), "Esta promoción requiere al menos 2 productos."
        elif tipo == "producto_gratis":
            descuento = self._calcular_descuento_producto_gratis(items)
            if descuento <= 0:
                return Decimal("0.00"), "Esta promoción requiere productos en el carrito."
        else:
            return Decimal("0.00"), "Tipo de promoción no soportado."

        if descuento > subtotal:
            descuento = subtotal
        return descuento.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), ""

    def _resolver_rol(self, request) -> str:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
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

    def _asegurar_rol_secretaria(self, request):
        rol = self._resolver_rol(request)
        if rol not in {"secretaria", "administrador", "admin"}:
            return Response({"ok": False, "error": "No autorizado."}, status=403)
        return None

    def _es_ruta_secretaria(self, request) -> bool:
        return "/api/secretaria/pedidos/" in str(request.path or "")

    def _normalizar_estado_ui(self, codigo: str) -> str:
        raw = str(codigo or "").strip().lower()
        if raw in {"aceptado"}:
            return "confirmado"
        if raw in {"en_camino"}:
            return "preparando"
        return raw

    def _to_front_entrega(self, codigo_bd: str) -> str:
        raw = str(codigo_bd or "").strip().lower()
        return "recoger_local" if raw == "tienda" else raw

    def _estado_ui_desde_historial(self, cursor, pedido_id: int, estado_db_codigo: str) -> str:
        estado_base = self._normalizar_estado_ui(estado_db_codigo)
        cursor.execute(
            """
            SELECT COALESCE(motivo, '')
            FROM negocio.pedido_estado_historial
            WHERE pedido_id = %s
            ORDER BY fecha_cambio DESC, pedido_estado_historial_id DESC
            LIMIT 5
            """,
            [pedido_id],
        )
        rows = cursor.fetchall()
        for row in rows:
            motivo = str((row or [""])[0] or "").strip()
            if not motivo or motivo.startswith("[SEGUIMIENTO]"):
                continue
            marcador = "->"
            if marcador in motivo:
                destino = motivo.split(marcador)[-1].strip().strip('"').strip("'").lower()
                if destino:
                    return self._normalizar_estado_ui(destino)
        return estado_base

    def _get_estado_pedido_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            """
            SELECT estado_pedido_id
            FROM negocio.estado_pedido
            WHERE LOWER(COALESCE(codigo, '')) = LOWER(%s)
            LIMIT 1
            """,
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _reponer_stock_pedido_si_aplica(self, cursor, pedido_id: int, motivo: str) -> tuple[bool, str]:
        cursor.execute(
            """
            SELECT COALESCE(notas, '')
            FROM negocio.pedido
            WHERE pedido_id = %s
            LIMIT 1
            """,
            [pedido_id],
        )
        row = cursor.fetchone()
        if not row:
            return False, "Pedido no encontrado."
        notas_actuales = str(row[0] or "")

        # Si nunca se descontó stock o ya se repuso, no hay nada que hacer.
        if f"[{self.STOCK_DESCONTADO_MARKER}]" not in notas_actuales:
            return True, ""
        if f"[{self.STOCK_REPUESTO_MARKER}]" in notas_actuales:
            return True, ""

        cursor.execute(
            """
            SELECT producto_id, COALESCE(cantidad, 0)
            FROM negocio.pedido_item
            WHERE pedido_id = %s
            """,
            [pedido_id],
        )
        items = cursor.fetchall()
        if not items:
            return True, ""

        tipo_entrada_id = self._get_tipo_movimiento_id(cursor, "entrada")
        for producto_id, cantidad in items:
            cantidad_num = int(cantidad or 0)
            if cantidad_num <= 0:
                continue
            producto_num = int(producto_id)
            cursor.execute(
                """
                SELECT COALESCE(stock_actual, 0)
                FROM negocio.inventario_existencia
                WHERE producto_id = %s
                FOR UPDATE
                """,
                [producto_num],
            )
            stock_row = cursor.fetchone()
            stock_anterior = int(stock_row[0] or 0) if stock_row else 0
            stock_posterior = stock_anterior + cantidad_num

            cursor.execute(
                """
                UPDATE negocio.inventario_existencia
                SET stock_actual = %s
                WHERE producto_id = %s
                """,
                [stock_posterior, producto_num],
            )
            if tipo_entrada_id:
                cursor.execute(
                    """
                    INSERT INTO negocio.inventario_movimiento (
                        producto_id, tipo_movimiento_id, empleado_id, cantidad,
                        stock_anterior, stock_posterior, referencia_pedido_id, nota
                    )
                    VALUES (%s, %s, NULL, %s, %s, %s, %s, %s)
                    """,
                    [
                        producto_num,
                        tipo_entrada_id,
                        cantidad_num,
                        stock_anterior,
                        stock_posterior,
                        pedido_id,
                        f"Reposición por cancelación de pedido: {motivo}",
                    ],
                )

        notas_nuevas = self._append_nota(
            notas_actuales,
            self.STOCK_REPUESTO_MARKER,
            {"motivo": motivo, "fecha": timezone.now().isoformat()},
        )
        cursor.execute(
            "UPDATE negocio.pedido SET notas = %s WHERE pedido_id = %s",
            [notas_nuevas, pedido_id],
        )
        return True, ""

    def _resolver_estado_destino(self, cursor, solicitado: str) -> tuple[str, int] | None:
        s = self._normalizar_estado_ui(solicitado)
        candidatos = {
            "pendiente": ["pendiente"],
            "comprobando_pago": ["comprobando_pago", "pendiente"],
            "pago_validado": ["pago_validado", "confirmado", "aceptado"],
            "confirmado": ["confirmado", "aceptado"],
            "preparando": ["preparando", "en_camino"],
            "listo_recoger": ["listo_recoger", "en_camino"],
            "enviado": ["enviado", "en_camino"],
            "entregado": ["entregado"],
            "cancelado": ["cancelado"],
        }.get(s, [s])

        for c in candidatos:
            estado_id = self._get_estado_pedido_id(cursor, c)
            if estado_id:
                return c, estado_id
        return None

    def _parse_seguimiento(self, motivo: str) -> dict[str, str]:
        prefijo = "[SEGUIMIENTO]"
        txt = str(motivo or "").strip()
        if not txt.startswith(prefijo):
            return {"detalle": txt, "ubicacion": "", "paqueteria": "", "guia": ""}
        payload = txt[len(prefijo):].strip()
        try:
            data = json.loads(payload) if payload else {}
        except Exception:
            data = {}
        return {
            "detalle": str(data.get("detalle", "") or "").strip(),
            "ubicacion": str(data.get("ubicacion", "") or "").strip(),
            "paqueteria": str(data.get("paqueteria", "") or "").strip(),
            "guia": str(data.get("guia", "") or "").strip(),
        }

    def _serializar_items_pedido(self, cursor, pedido_id: int) -> list[dict]:
        cursor.execute(
            """
            SELECT
                pi.pedido_item_id,
                pi.producto_id,
                COALESCE(pr.nombre, '') AS producto_nombre,
                COALESCE(
                    (
                        SELECT pim.url
                        FROM negocio.producto_imagen pim
                        WHERE pim.producto_id = pi.producto_id
                        ORDER BY pim.es_principal DESC, pim.orden ASC, pim.producto_imagen_id ASC
                        LIMIT 1
                    ),
                    ''
                ) AS producto_imagen,
                COALESCE(pi.cantidad, 0) AS cantidad,
                COALESCE(pi.precio_unitario, 0) AS precio_unitario,
                COALESCE(pi.subtotal, 0) AS subtotal
            FROM negocio.pedido_item pi
            LEFT JOIN negocio.producto pr ON pr.producto_id = pi.producto_id
            WHERE pi.pedido_id = %s
            ORDER BY pi.pedido_item_id ASC
            """,
            [pedido_id],
        )
        rows = cursor.fetchall()
        return [
            {
                "id": int(r[0]),
                "producto_id": int(r[1]),
                "producto_nombre": str(r[2] or ""),
                "producto_imagen": str(r[3] or ""),
                "cantidad": int(r[4] or 0),
                "precio_unitario": float(self._to_money(r[5])),
                "subtotal": float(self._to_money(r[6])),
            }
            for r in rows
        ]

    def _serializar_seguimiento_pedido(self, cursor, pedido_id: int) -> list[dict]:
        cursor.execute(
            """
            SELECT
                h.pedido_estado_historial_id,
                LOWER(COALESCE(ep.codigo, '')) AS estado_codigo,
                COALESCE(ep.nombre, '') AS estado_nombre,
                COALESCE(h.motivo, '') AS motivo,
                COALESCE(u.email, '') AS usuario_email,
                h.fecha_cambio
            FROM negocio.pedido_estado_historial h
            LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = h.estado_pedido_id
            LEFT JOIN negocio.usuario u ON u.usuario_id = h.cambiado_por_usuario_id
            WHERE h.pedido_id = %s
            ORDER BY h.fecha_cambio ASC, h.pedido_estado_historial_id ASC
            """,
            [pedido_id],
        )
        rows = cursor.fetchall()
        eventos: list[dict] = []
        for r in rows:
            parsed = self._parse_seguimiento(str(r[3] or ""))
            estado_codigo = str(r[1] or "")
            estado_nombre = str(r[2] or "").strip() or estado_codigo.replace("_", " ").title()
            eventos.append(
                {
                    "id": int(r[0]),
                    "estado": estado_codigo,
                    "estado_display": estado_nombre,
                    "motivo": str(r[3] or ""),
                    "detalle": parsed["detalle"],
                    "ubicacion": parsed["ubicacion"],
                    "paqueteria": parsed["paqueteria"],
                    "guia": parsed["guia"],
                    "usuario": str(r[4] or ""),
                    "fecha_evento": r[5].isoformat() if r[5] else "",
                }
            )
        return eventos

    def _cliente_post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        negocio_usuario_id = self._get_negocio_usuario_id(request.user)
        if not negocio_usuario_id:
            return Response({"ok": False, "error": "Usuario de negocio no encontrado."}, status=404)

        items_raw = data.get("items")
        if not isinstance(items_raw, list) or not items_raw:
            return Response({"ok": False, "error": "Debes enviar al menos un producto."}, status=400)

        metodo_entrega_front = str(data.get("metodo_entrega", "recoger_local")).strip().lower()
        metodo_pago = str(data.get("metodo_pago", "efectivo")).strip().lower()
        direccion_entrega = str(data.get("direccion_entrega", "") or "").strip()
        codigo_descuento = str(data.get("codigo_descuento", "") or "").strip().upper()
        notas = str(data.get("notas", "") or "").strip()
        comprobante_url = str(data.get("comprobante_url", "") or "").strip()

        metodo_entrega_codigo = "tienda" if metodo_entrega_front == "recoger_local" else metodo_entrega_front
        if metodo_entrega_codigo not in {"tienda", "moto_mandado", "paqueteria"}:
            return Response({"ok": False, "error": "Método de entrega inválido."}, status=400)
        if metodo_pago not in {"efectivo", "tarjeta", "transferencia"}:
            return Response({"ok": False, "error": "Método de pago inválido."}, status=400)
        if metodo_entrega_codigo in {"moto_mandado", "paqueteria"} and len(direccion_entrega) < 6:
            return Response({"ok": False, "error": "Dirección de entrega inválida."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT estado_pedido_id FROM negocio.estado_pedido WHERE codigo = 'pendiente' LIMIT 1"
                    )
                    row_estado = cursor.fetchone()
                    if not row_estado:
                        return Response({"ok": False, "error": "No existe estado de pedido pendiente."}, status=500)
                    estado_pedido_id = int(row_estado[0])

                    cursor.execute(
                        "SELECT metodo_entrega_id, COALESCE(costo_fijo, 0) FROM negocio.metodo_entrega WHERE codigo = %s LIMIT 1",
                        [metodo_entrega_codigo],
                    )
                    row_entrega = cursor.fetchone()
                    if not row_entrega:
                        return Response({"ok": False, "error": "Método de entrega no configurado."}, status=400)
                    metodo_entrega_id = int(row_entrega[0])
                    costo_envio = self._to_money(row_entrega[1])

                    cursor.execute(
                        "SELECT metodo_pago_id FROM negocio.metodo_pago_catalogo WHERE codigo = %s AND activo = TRUE LIMIT 1",
                        [metodo_pago],
                    )
                    row_pago = cursor.fetchone()
                    if not row_pago:
                        return Response({"ok": False, "error": "Método de pago no disponible."}, status=400)
                    metodo_pago_id = int(row_pago[0])

                    items_db: list[dict] = []
                    subtotal = Decimal("0.00")
                    for item in items_raw:
                        if not isinstance(item, dict):
                            continue
                        producto_id = int(item.get("producto_id", 0) or 0)
                        cantidad = int(item.get("cantidad", 0) or 0)
                        if producto_id <= 0 or cantidad <= 0:
                            return Response({"ok": False, "error": "Items inválidos en el pedido."}, status=400)

                        cursor.execute(
                            """
                            SELECT
                                p.producto_id,
                                p.nombre,
                                p.precio_venta,
                                COALESCE(ie.stock_actual, 0) AS stock_actual,
                                p.estado,
                                p.disponible_venta
                            FROM negocio.producto p
                            LEFT JOIN negocio.inventario_existencia ie ON ie.producto_id = p.producto_id
                            WHERE p.producto_id = %s
                            LIMIT 1
                            """,
                            [producto_id],
                        )
                        row_prod = cursor.fetchone()
                        if not row_prod:
                            return Response({"ok": False, "error": f"Producto {producto_id} no encontrado."}, status=404)
                        if str(row_prod[4] or "").strip().lower() != "activo" or not bool(row_prod[5]):
                            return Response({"ok": False, "error": f"El producto {row_prod[1]} no está disponible."}, status=400)

                        precio_unitario = self._to_money(row_prod[2])
                        stock_actual = int(row_prod[3] or 0)
                        if cantidad > stock_actual:
                            return Response(
                                {
                                    "ok": False,
                                    "error": f"Stock insuficiente para {row_prod[1]}. Disponible: {stock_actual}.",
                                },
                                status=400,
                            )

                        subtotal_item = (precio_unitario * Decimal(cantidad)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                        subtotal += subtotal_item
                        items_db.append(
                            {
                                "producto_id": int(row_prod[0]),
                                "nombre": str(row_prod[1] or ""),
                                "cantidad": cantidad,
                                "precio_unitario": precio_unitario,
                                "subtotal": subtotal_item,
                                "stock_actual": stock_actual,
                            }
                        )

                    subtotal = subtotal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    if subtotal <= 0:
                        return Response({"ok": False, "error": "El subtotal debe ser mayor a cero."}, status=400)

                    descuento = Decimal("0.00")
                    if codigo_descuento:
                        descuento, error_desc = self._resolver_descuento(codigo_descuento, subtotal, items_db)
                        if error_desc:
                            return Response({"ok": False, "error": error_desc}, status=400)
                    descuento = descuento.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    total = (subtotal - descuento + costo_envio).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    if total < Decimal("0.00"):
                        total = Decimal("0.00")

                    cursor.execute(
                        """
                        INSERT INTO negocio.pedido (
                            cliente_usuario_id,
                            estado_pedido_id,
                            metodo_entrega_id,
                            metodo_pago_id,
                            direccion_entrega_id,
                            subtotal,
                            costo_envio,
                            descuento_monto,
                            total,
                            codigo_descuento,
                            notas,
                            comprobante_url
                        )
                        VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING pedido_id
                        """,
                        [
                            negocio_usuario_id,
                            estado_pedido_id,
                            metodo_entrega_id,
                            metodo_pago_id,
                            subtotal,
                            costo_envio,
                            descuento,
                            total,
                            (codigo_descuento or None),
                            (notas or None),
                            (comprobante_url or None),
                        ],
                    )
                    pedido_id = int(cursor.fetchone()[0])

                    for item in items_db:
                        cursor.execute(
                            """
                            INSERT INTO negocio.pedido_item (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
                            VALUES (%s, %s, %s, %s, %s)
                            """,
                            [pedido_id, item["producto_id"], item["cantidad"], item["precio_unitario"], item["subtotal"]],
                        )

                    cursor.execute(
                        """
                        INSERT INTO negocio.pedido_estado_historial (pedido_id, estado_pedido_id, cambiado_por_usuario_id, motivo)
                        VALUES (%s, %s, %s, %s)
                        """,
                        [pedido_id, estado_pedido_id, negocio_usuario_id, "Creación desde checkout cliente"],
                    )

                    if codigo_descuento:
                        cursor.execute(
                            """
                            UPDATE negocio.promocion
                            SET usos_actuales = COALESCE(usos_actuales, 0) + 1
                            WHERE UPPER(COALESCE(codigo, '')) = %s
                            """,
                            [codigo_descuento],
                        )

                return Response(
                    {
                        "ok": True,
                        "pedido_id": pedido_id,
                        "estado": "pendiente",
                        "subtotal": float(subtotal),
                        "descuento": float(descuento),
                        "costo_envio": float(costo_envio),
                        "total": float(total),
                    }
                )
        except DatabaseError as exc:
            return Response({"ok": False, "error": f"No se pudo crear el pedido: {exc}"}, status=500)

    def _cliente_get(self, request):
        negocio_usuario_id = self._get_negocio_usuario_id(request.user)
        if not negocio_usuario_id:
            return Response({"ok": False, "error": "Usuario de negocio no encontrado."}, status=404)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        p.pedido_id,
                        COALESCE(ep.codigo, 'pendiente') AS estado_codigo,
                        COALESCE(me.codigo, 'tienda') AS entrega_codigo,
                        COALESCE(mp.codigo, 'efectivo') AS pago_codigo,
                        COALESCE(p.subtotal, 0),
                        COALESCE(p.descuento_monto, 0),
                        COALESCE(p.costo_envio, 0),
                        COALESCE(p.total, 0),
                        COALESCE(p.codigo_descuento, ''),
                        COALESCE(p.comprobante_url, ''),
                        COALESCE(p.notas, ''),
                        p.fecha_creacion
                    FROM negocio.pedido p
                    LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE p.cliente_usuario_id = %s
                      AND NOT (
                        LOWER(COALESCE(mp.codigo, '')) = 'tarjeta'
                        AND LOWER(COALESCE(ep.codigo, '')) = 'cancelado'
                        AND POSITION('[CLIP_PAGO_FALLIDO_AUTOCANCEL]' IN COALESCE(p.notas, '')) > 0
                      )
                    ORDER BY p.pedido_id DESC
                    """,
                    [negocio_usuario_id],
                )
                pedidos_rows = cursor.fetchall()

                pedidos: list[dict] = []
                for row in pedidos_rows:
                    pedido_id = int(row[0])
                    cursor.execute(
                        """
                        SELECT
                            pi.producto_id,
                            COALESCE(pr.nombre, ''),
                            COALESCE(
                                (
                                    SELECT pim.url
                                    FROM negocio.producto_imagen pim
                                    WHERE pim.producto_id = pi.producto_id
                                    ORDER BY pim.orden ASC
                                    LIMIT 1
                                ),
                                ''
                            ) AS imagen_url,
                            COALESCE(pi.cantidad, 0),
                            COALESCE(pi.precio_unitario, 0),
                            COALESCE(pi.subtotal, 0)
                        FROM negocio.pedido_item pi
                        LEFT JOIN negocio.producto pr ON pr.producto_id = pi.producto_id
                        WHERE pi.pedido_id = %s
                        ORDER BY pi.pedido_item_id ASC
                        """,
                        [pedido_id],
                    )
                    items_rows = cursor.fetchall()
                    items = [
                        {
                            "producto_id": int(i[0]),
                            "producto_nombre": str(i[1] or ""),
                            "producto_imagen": str(i[2] or ""),
                            "cantidad": int(i[3] or 0),
                            "precio_unitario": float(i[4] or 0),
                            "subtotal": float(i[5] or 0),
                        }
                        for i in items_rows
                    ]
                    cursor.execute(
                        """
                        SELECT COALESCE(h.motivo, '')
                        FROM negocio.pedido_estado_historial h
                        WHERE h.pedido_id = %s
                        ORDER BY h.fecha_cambio DESC, h.pedido_estado_historial_id DESC
                        LIMIT 1
                        """,
                        [pedido_id],
                    )
                    row_hist = cursor.fetchone()
                    seguimiento = self._parse_seguimiento(str((row_hist or [""])[0] or ""))
                    pedidos.append(
                        {
                            "id": pedido_id,
                            "estado": str(row[1] or "pendiente"),
                            "metodo_entrega": ("recoger_local" if str(row[2] or "") == "tienda" else str(row[2] or "")),
                            "metodo_pago": str(row[3] or "efectivo"),
                            "direccion_entrega": "",
                            "subtotal": float(row[4] or 0),
                            "descuento": float(row[5] or 0),
                            "costo_envio": float(row[6] or 0),
                            "total": float(row[7] or 0),
                            "codigo_descuento": str(row[8] or ""),
                            "comprobante_url": str(row[9] or ""),
                            "notas": str(row[10] or ""),
                            "paqueteria_envio": seguimiento.get("paqueteria", ""),
                            "guia_envio": seguimiento.get("guia", ""),
                            "ubicacion_envio": seguimiento.get("ubicacion", ""),
                            "detalle_envio": seguimiento.get("detalle", ""),
                            "fecha_creacion": row[11].isoformat() if row[11] else "",
                            "items": items,
                        }
                    )
            return Response({"ok": True, "pedidos": pedidos})
        except DatabaseError as exc:
            return Response({"ok": False, "error": f"No se pudieron consultar pedidos: {exc}"}, status=500)

    def _secretaria_get(self, request, pedido_id: int | None = None):
        permiso = self._asegurar_rol_secretaria(request)
        if permiso:
            return permiso
        try:
            with connection.cursor() as cursor:
                is_seguimiento = str(request.path or "").endswith("/seguimiento/")
                if pedido_id is not None and is_seguimiento:
                    return Response({"ok": True, "seguimiento": self._serializar_seguimiento_pedido(cursor, pedido_id)})

                if pedido_id is not None:
                    cursor.execute(
                        """
                        SELECT
                            p.pedido_id,
                            TRIM(
                                COALESCE(pp.nombres, '') || ' ' ||
                                COALESCE(pp.apellido_paterno, '') || ' ' ||
                                COALESCE(pp.apellido_materno, '')
                            ) AS cliente_nombre,
                            COALESCE(u.email, '') AS cliente_email,
                            COALESCE(pp.telefono, '') AS cliente_telefono,
                            LOWER(COALESCE(ep.codigo, 'pendiente')) AS estado,
                            LOWER(COALESCE(me.codigo, 'tienda')) AS metodo_entrega,
                            LOWER(COALESCE(mp.codigo, 'efectivo')) AS metodo_pago,
                            COALESCE(p.subtotal, 0),
                            COALESCE(p.descuento_monto, 0),
                            COALESCE(p.costo_envio, 0),
                            COALESCE(p.total, 0),
                            COALESCE(p.codigo_descuento, ''),
                            COALESCE(p.notas, ''),
                            COALESCE(p.comprobante_url, ''),
                            p.fecha_creacion,
                            p.fecha_actualizacion
                        FROM negocio.pedido p
                        JOIN negocio.usuario u ON u.usuario_id = p.cliente_usuario_id
                        LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                        LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                        LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                        LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                        WHERE p.pedido_id = %s
                        LIMIT 1
                        """,
                        [pedido_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Pedido no encontrado."}, status=404)
                    estado_ui = self._estado_ui_desde_historial(cursor, int(row[0]), str(row[4] or "pendiente"))
                    pedido = {
                        "id": int(row[0]),
                        "cliente_nombre": str(row[1] or "") or str(row[2] or ""),
                        "cliente_email": str(row[2] or ""),
                        "cliente_telefono": str(row[3] or ""),
                        "cliente_avatar": "",
                        "estado": estado_ui,
                        "metodo_entrega": self._to_front_entrega(str(row[5] or "tienda")),
                        "metodo_pago": str(row[6] or "efectivo"),
                        "direccion_entrega": "",
                        "subtotal": float(self._to_money(row[7])),
                        "descuento": float(self._to_money(row[8])),
                        "costo_envio": float(self._to_money(row[9])),
                        "total": float(self._to_money(row[10])),
                        "codigo_descuento": str(row[11] or ""),
                        "notas": str(row[12] or ""),
                        "comprobante_url": str(row[13] or ""),
                        "fecha_creacion": row[14].isoformat() if row[14] else "",
                        "fecha_actualizacion": row[15].isoformat() if row[15] else "",
                        "items": self._serializar_items_pedido(cursor, int(row[0])),
                        "seguimiento": self._serializar_seguimiento_pedido(cursor, int(row[0])),
                    }
                    return Response({"ok": True, "pedido": pedido})

                estado = str(request.query_params.get("estado", "") or "").strip().lower()
                metodo_pago = str(request.query_params.get("metodo_pago", "") or "").strip().lower()
                metodo_entrega = str(request.query_params.get("metodo_entrega", "") or "").strip().lower()
                buscar = str(request.query_params.get("buscar", "") or "").strip()
                params: list[Any] = []
                filtros: list[str] = []

                if estado:
                    if estado == "confirmado":
                        filtros.append("LOWER(COALESCE(ep.codigo, '')) IN ('confirmado', 'aceptado')")
                    elif estado == "preparando":
                        filtros.append("LOWER(COALESCE(ep.codigo, '')) IN ('preparando', 'en_camino')")
                    else:
                        filtros.append("LOWER(COALESCE(ep.codigo, '')) = %s")
                        params.append(estado)
                metodo_pago_db = metodo_pago or None
                metodo_entrega_db = (
                    "tienda" if metodo_entrega == "recoger_local" else metodo_entrega
                ) or None
                like = f"%{buscar}%" if buscar else None

                cursor.execute(
                    """
                    SELECT
                        p.pedido_id,
                        TRIM(
                            COALESCE(pp.nombres, '') || ' ' ||
                            COALESCE(pp.apellido_paterno, '') || ' ' ||
                            COALESCE(pp.apellido_materno, '')
                        ) AS cliente_nombre,
                        COALESCE(u.email, '') AS cliente_email,
                        COALESCE(pp.telefono, '') AS cliente_telefono,
                        LOWER(COALESCE(ep.codigo, 'pendiente')) AS estado,
                        LOWER(COALESCE(me.codigo, 'tienda')) AS metodo_entrega,
                        LOWER(COALESCE(mp.codigo, 'efectivo')) AS metodo_pago,
                        COALESCE(p.subtotal, 0),
                        COALESCE(p.descuento_monto, 0),
                        COALESCE(p.costo_envio, 0),
                        COALESCE(p.total, 0),
                        COALESCE(p.codigo_descuento, ''),
                        COALESCE(p.notas, ''),
                        COALESCE(p.comprobante_url, ''),
                        p.fecha_creacion,
                        p.fecha_actualizacion
                    FROM negocio.pedido p
                    JOIN negocio.usuario u ON u.usuario_id = p.cliente_usuario_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                    LEFT JOIN negocio.metodo_pago_catalogo mp ON mp.metodo_pago_id = p.metodo_pago_id
                    WHERE (%s IS NULL OR LOWER(COALESCE(ep.codigo, '')) = %s)
                      AND (%s IS NULL OR LOWER(COALESCE(mp.codigo, '')) = %s)
                      AND (%s IS NULL OR LOWER(COALESCE(me.codigo, '')) = %s)
                      AND (
                            %s IS NULL OR
                            LOWER(COALESCE(pp.nombres, '')) LIKE LOWER(%s) OR
                            LOWER(COALESCE(pp.apellido_paterno, '')) LIKE LOWER(%s) OR
                            LOWER(COALESCE(pp.apellido_materno, '')) LIKE LOWER(%s) OR
                            LOWER(COALESCE(u.email, '')) LIKE LOWER(%s) OR
                            CAST(p.pedido_id AS TEXT) LIKE %s
                      )
                    ORDER BY p.fecha_creacion DESC, p.pedido_id DESC
                    LIMIT 100
                    """,
                    [
                        estado or None,
                        estado or None,
                        metodo_pago_db,
                        metodo_pago_db,
                        metodo_entrega_db,
                        metodo_entrega_db,
                        like,
                        like,
                        like,
                        like,
                        like,
                        like,
                    ],
                )
                rows = cursor.fetchall()
                pedidos = []
                for r in rows:
                    pedido_id_int = int(r[0])
                    estado_ui = self._estado_ui_desde_historial(cursor, pedido_id_int, str(r[4] or "pendiente"))
                    pedidos.append(
                        {
                            "id": pedido_id_int,
                            "cliente_nombre": str(r[1] or "") or str(r[2] or ""),
                            "cliente_email": str(r[2] or ""),
                            "cliente_telefono": str(r[3] or ""),
                            "cliente_avatar": "",
                            "estado": estado_ui,
                            "metodo_entrega": self._to_front_entrega(str(r[5] or "tienda")),
                            "metodo_pago": str(r[6] or "efectivo"),
                            "direccion_entrega": "",
                            "subtotal": float(self._to_money(r[7])),
                            "descuento": float(self._to_money(r[8])),
                            "costo_envio": float(self._to_money(r[9])),
                            "total": float(self._to_money(r[10])),
                            "codigo_descuento": str(r[11] or ""),
                            "notas": str(r[12] or ""),
                            "comprobante_url": str(r[13] or ""),
                            "fecha_creacion": r[14].isoformat() if r[14] else "",
                            "fecha_actualizacion": r[15].isoformat() if r[15] else "",
                            "items": self._serializar_items_pedido(cursor, pedido_id_int),
                        }
                    )

                cursor.execute("SELECT COUNT(*) FROM negocio.pedido")
                total = int((cursor.fetchone() or [0])[0] or 0)
                cursor.execute(
                    """
                    SELECT LOWER(COALESCE(ep.codigo, 'pendiente')) AS estado_codigo, COUNT(*)
                    FROM negocio.pedido p
                    LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                    GROUP BY LOWER(COALESCE(ep.codigo, 'pendiente'))
                    """
                )
                counts_map = {str(row[0] or ""): int(row[1] or 0) for row in cursor.fetchall()}
                contadores = {
                    "total": total,
                    "pendientes": counts_map.get("pendiente", 0),
                    "comprobando_pago": counts_map.get("comprobando_pago", 0),
                    "confirmados": counts_map.get("confirmado", 0) + counts_map.get("aceptado", 0),
                    "preparando": counts_map.get("preparando", 0) + counts_map.get("en_camino", 0),
                }
                return Response({"ok": True, "pedidos": pedidos, "contadores": contadores})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo consultar pedidos de secretaría."}, status=500)

    def _secretaria_post(self, request, pedido_id: int | None = None):
        permiso = self._asegurar_rol_secretaria(request)
        if permiso:
            return permiso
        if pedido_id is None or not str(request.path or "").endswith("/seguimiento/"):
            return Response({"ok": False, "error": "Ruta inválida para seguimiento."}, status=400)

        data = request.data if isinstance(request.data, dict) else {}
        detalle = str(data.get("detalle", "") or "").strip()
        ubicacion = str(data.get("ubicacion", "") or "").strip()
        paqueteria = str(data.get("paqueteria", "") or "").strip()
        guia = str(data.get("guia", "") or "").strip()
        if not detalle and not ubicacion:
            return Response({"ok": False, "error": "Agrega detalle u ubicación para registrar seguimiento."}, status=400)

        usuario_id = self._get_negocio_usuario_id(request.user)
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            p.estado_pedido_id,
                            LOWER(COALESCE(me.codigo, 'tienda')) AS metodo_entrega_codigo
                        FROM negocio.pedido p
                        LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                        WHERE p.pedido_id = %s
                        LIMIT 1
                        """,
                        [pedido_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Pedido no encontrado."}, status=404)
                    estado_pedido_id = int(row[0])
                    metodo_entrega = self._to_front_entrega(str(row[1] or "tienda"))
                    if metodo_entrega != "paqueteria":
                        return Response(
                            {
                                "ok": False,
                                "error": "El seguimiento con paquetería/guía aplica solo para pedidos por paquetería.",
                            },
                            status=400,
                        )

                    motivo = "[SEGUIMIENTO]" + json.dumps(
                        {
                            "detalle": detalle,
                            "ubicacion": ubicacion,
                            "paqueteria": paqueteria,
                            "guia": guia,
                        },
                        ensure_ascii=False,
                    )
                    cursor.execute(
                        """
                        INSERT INTO negocio.pedido_estado_historial (
                            pedido_id, estado_pedido_id, cambiado_por_usuario_id, motivo
                        )
                        VALUES (%s, %s, %s, %s)
                        """,
                        [pedido_id, estado_pedido_id, usuario_id, motivo],
                    )
            return Response({"ok": True, "mensaje": "Seguimiento registrado correctamente."})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo registrar seguimiento."}, status=500)

    def _secretaria_put(self, request, pedido_id: int):
        permiso = self._asegurar_rol_secretaria(request)
        if permiso:
            return permiso

        data = request.data if isinstance(request.data, dict) else {}
        estado_solicitado = str(data.get("estado", "") or "").strip().lower()
        if not estado_solicitado:
            return Response({"ok": False, "error": "El estado es requerido."}, status=400)

        paqueteria = str(data.get("paqueteria", "") or "").strip()
        guia = str(data.get("guia", "") or "").strip()
        ubicacion = str(data.get("ubicacion", "") or "").strip()
        detalle = str(data.get("detalle", "") or "").strip()
        usuario_id = self._get_negocio_usuario_id(request.user)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            p.pedido_id,
                            LOWER(COALESCE(ep.codigo, 'pendiente')) AS estado_codigo,
                            LOWER(COALESCE(me.codigo, 'tienda')) AS metodo_entrega_codigo
                        FROM negocio.pedido p
                        LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                        LEFT JOIN negocio.metodo_entrega me ON me.metodo_entrega_id = p.metodo_entrega_id
                        WHERE p.pedido_id = %s
                        LIMIT 1
                        """,
                        [pedido_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Pedido no encontrado."}, status=404)

                    estado_actual = self._normalizar_estado_ui(str(row[1] or "pendiente"))
                    estado_destino = self._normalizar_estado_ui(estado_solicitado)

                    transiciones = {
                        "pendiente": {"comprobando_pago", "pago_validado", "confirmado", "preparando", "cancelado"},
                        "comprobando_pago": {"pago_validado", "confirmado", "cancelado"},
                        "pago_validado": {"confirmado", "cancelado"},
                        "confirmado": {"preparando", "cancelado"},
                        "preparando": {"listo_recoger", "enviado", "entregado", "cancelado"},
                        "listo_recoger": {"entregado", "cancelado"},
                        "enviado": {"entregado", "cancelado"},
                        "entregado": set(),
                        "cancelado": set(),
                    }
                    permitidos = transiciones.get(estado_actual, set())
                    if estado_destino not in permitidos:
                        return Response(
                            {
                                "ok": False,
                                "error": f'No se puede cambiar de "{estado_actual}" a "{estado_destino}".',
                            },
                            status=400,
                        )
                    destino_resuelto = self._resolver_estado_destino(cursor, estado_destino)
                    if not destino_resuelto:
                        return Response({"ok": False, "error": f'El estado "{estado_destino}" no existe en catálogo.'}, status=400)
                    estado_real_codigo, estado_real_id = destino_resuelto

                    if estado_destino == "cancelado":
                        ok_repos, err_repos = self._reponer_stock_pedido_si_aplica(
                            cursor,
                            int(pedido_id),
                            "cancelacion_secretaria",
                        )
                        if not ok_repos:
                            return Response(
                                {
                                    "ok": False,
                                    "error": f"No se pudo reponer inventario al cancelar: {err_repos}",
                                },
                                status=409,
                            )

                    cursor.execute(
                        """
                        UPDATE negocio.pedido
                        SET estado_pedido_id = %s, fecha_actualizacion = NOW()
                        WHERE pedido_id = %s
                        """,
                        [estado_real_id, pedido_id],
                    )

                    motivo_historial = f"Cambio de estado: {estado_actual} -> {estado_destino}"
                    if paqueteria or guia or ubicacion or detalle:
                        motivo_historial = "[SEGUIMIENTO]" + json.dumps(
                            {
                                "detalle": detalle or f"Cambio de estado a {estado_destino}",
                                "ubicacion": ubicacion,
                                "paqueteria": paqueteria,
                                "guia": guia,
                            },
                            ensure_ascii=False,
                        )
                    cursor.execute(
                        """
                        INSERT INTO negocio.pedido_estado_historial (
                            pedido_id, estado_pedido_id, cambiado_por_usuario_id, motivo
                        )
                        VALUES (%s, %s, %s, %s)
                        """,
                        [pedido_id, estado_real_id, usuario_id, motivo_historial],
                    )

            return Response(
                {
                    "ok": True,
                    "pedido_id": int(pedido_id),
                    "estado_anterior": estado_actual,
                    "estado_nuevo": self._normalizar_estado_ui(estado_real_codigo),
                    "mensaje": f'Pedido #{pedido_id} actualizado a "{self._normalizar_estado_ui(estado_real_codigo)}".',
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo actualizar el pedido."}, status=500)

    def post(self, request, pedido_id: int | None = None):
        if self._es_ruta_secretaria(request):
            return self._secretaria_post(request, pedido_id)
        return self._cliente_post(request)

    def get(self, request, pedido_id: int | None = None):
        if self._es_ruta_secretaria(request):
            return self._secretaria_get(request, pedido_id)
        return self._cliente_get(request)

    def put(self, request, pedido_id: int):
        if not self._es_ruta_secretaria(request):
            return Response({"ok": False, "error": "Ruta inválida."}, status=404)
        return self._secretaria_put(request, pedido_id)


class BarberosParaAgendarView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        servicio_id_raw = str(request.query_params.get("servicio_id", "") or "").strip()
        servicio_id: int | None = None
        if servicio_id_raw:
            try:
                servicio_id = int(servicio_id_raw)
            except (TypeError, ValueError):
                return Response({"ok": False, "error": "servicio_id inválido."}, status=400)
            if servicio_id <= 0:
                return Response({"ok": False, "error": "servicio_id inválido."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        e.empleado_id,
                        COALESCE(u.email, ''),
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE(pp.telefono, ''),
                        '' AS bio,
                        COALESCE(pp.avatar_url, ''),
                        COALESCE((
                            SELECT string_agg(esp.nombre, ', ' ORDER BY esp.nombre)
                            FROM negocio.empleado_especialidad ee
                            JOIN negocio.especialidad esp ON esp.especialidad_id = ee.especialidad_id
                            WHERE ee.empleado_id = e.empleado_id
                        ), '') AS especialidades,
                        COALESCE((
                            SELECT array_agg(DISTINCT bsx.servicio_id ORDER BY bsx.servicio_id)
                            FROM negocio.barbero_servicio bsx
                            WHERE bsx.empleado_id = e.empleado_id
                        ), '{}') AS servicios_ids,
                        COALESCE((
                            SELECT array_agg(DISTINCT ehd.dia_semana ORDER BY ehd.dia_semana)
                            FROM negocio.empleado_horario_dia ehd
                            WHERE ehd.empleado_id = e.empleado_id
                              AND COALESCE(ehd.trabaja, FALSE) = TRUE
                        ), '{}') AS dias_trabajo
                    FROM negocio.empleado e
                    JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    WHERE COALESCE(e.activo, FALSE) = TRUE
                      AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                      AND (
                        %s IS NULL
                        OR EXISTS (
                            SELECT 1
                            FROM negocio.barbero_servicio bs
                            WHERE bs.empleado_id = e.empleado_id
                              AND bs.servicio_id = %s
                        )
                      )
                    ORDER BY COALESCE(pp.nombres, ''), COALESCE(pp.apellido_paterno, ''), e.empleado_id
                    """,
                    [servicio_id, servicio_id],
                )
                rows = cursor.fetchall()

            barberos = []
            for row in rows:
                servicios_ids_raw = row[8] if len(row) > 8 else []
                dias_trabajo_raw = row[9] if len(row) > 9 else []
                if isinstance(servicios_ids_raw, list):
                    servicios_ids = [int(x) for x in servicios_ids_raw if x is not None]
                elif isinstance(servicios_ids_raw, tuple):
                    servicios_ids = [int(x) for x in servicios_ids_raw if x is not None]
                else:
                    servicios_ids = []
                if isinstance(dias_trabajo_raw, list):
                    dias_trabajo = [int(x) for x in dias_trabajo_raw if x is not None]
                elif isinstance(dias_trabajo_raw, tuple):
                    dias_trabajo = [int(x) for x in dias_trabajo_raw if x is not None]
                else:
                    dias_trabajo = []
                barberos.append(
                    {
                        "id": int(row[0]),
                        "email": str(row[1] or ""),
                        "nombre": str(row[2] or ""),
                        "apellido": str(row[3] or ""),
                        "telefono": str(row[4] or ""),
                        "bio": str(row[5] or ""),
                        "avatar_url": str(row[6] or ""),
                        "especialidades": str(row[7] or ""),
                        "activo": True,
                        "servicios_ids": servicios_ids,
                        "dias_trabajo": dias_trabajo,
                    }
                )

            return Response({"ok": True, "barberos": barberos})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudieron cargar los barberos disponibles."}, status=500)


class DisponibilidadView(APIView):
    permission_classes = [IsAuthenticated]
    SLOT_MINUTES = 20

    def _to_minutes(self, t) -> int:
        if t is None:
            return -1
        if isinstance(t, str):
            try:
                tt = datetime.strptime(t.strip()[:5], "%H:%M").time()
            except Exception:
                return -1
        else:
            tt = t
        return int(tt.hour) * 60 + int(tt.minute)

    def _fmt_minutes(self, mins: int) -> str:
        h = max(0, mins // 60)
        m = max(0, mins % 60)
        return f"{h:02d}:{m:02d}"

    def _overlap(self, a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
        return a_start < b_end and b_start < a_end

    def _marcar_horarios_pasados_web(self, horarios: list, fecha_obj: date) -> list:
        hoy = timezone.localdate()
        if fecha_obj != hoy or not horarios:
            return horarios
        ahora = timezone.localtime()
        ahora_min = int(ahora.hour) * 60 + int(ahora.minute)
        limite = ((ahora_min + self.SLOT_MINUTES - 1) // self.SLOT_MINUTES) * self.SLOT_MINUTES
        result = []
        for item in horarios:
            copia = dict(item)
            parts = str(copia.get("hora", "")).split(":")
            if len(parts) >= 2:
                hm = int(parts[0]) * 60 + int(parts[1])
                if hm < limite:
                    copia["disponible"] = False
            result.append(copia)
        return result

    def get(self, request):
        barbero_id_raw = str(request.query_params.get("barbero_id", "") or "").strip()
        fecha_raw = str(request.query_params.get("fecha", "") or "").strip()
        duracion_raw = str(request.query_params.get("duracion", "") or "").strip()

        try:
            barbero_id = int(barbero_id_raw)
            duracion = int(duracion_raw)
            fecha_obj = date.fromisoformat(fecha_raw)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "Parámetros inválidos. Usa barbero_id, fecha(YYYY-MM-DD), duracion."}, status=400)

        if barbero_id <= 0 or duracion <= 0:
            return Response({"ok": False, "error": "barbero_id y duracion deben ser mayores a cero."}, status=400)

        # 0=Lunes .. 6=Domingo (alineado al esquema)
        dia_semana = int(fecha_obj.weekday())

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT e.empleado_id, e.empresa_id
                    FROM negocio.empleado e
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE e.empleado_id = %s
                      AND COALESCE(e.activo, FALSE) = TRUE
                      AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                    LIMIT 1
                    """,
                    [barbero_id],
                )
                row_barbero = cursor.fetchone()
                if not row_barbero:
                    return Response({"ok": True, "horarios": []})
                empresa_id = int(row_barbero[1])

                # Horario del negocio para el día
                cursor.execute(
                    """
                    SELECT COALESCE(abierto, FALSE), hora_apertura, hora_cierre
                    FROM negocio.horario_negocio
                    WHERE empresa_id = %s
                      AND dia_semana = %s
                    LIMIT 1
                    """,
                    [empresa_id, dia_semana],
                )
                row_negocio = cursor.fetchone()
                if not row_negocio:
                    return Response({"ok": True, "horarios": []})
                negocio_abierto = bool(row_negocio[0])
                if not negocio_abierto:
                    return Response({"ok": True, "horarios": []})
                negocio_ini = self._to_minutes(row_negocio[1])
                negocio_fin = self._to_minutes(row_negocio[2])
                if negocio_ini < 0 or negocio_fin <= negocio_ini:
                    return Response({"ok": True, "horarios": []})

                # Horario laboral del barbero ese día
                cursor.execute(
                    """
                    SELECT COALESCE(trabaja, FALSE), hora_inicio, hora_fin
                    FROM negocio.empleado_horario_dia
                    WHERE empleado_id = %s
                      AND dia_semana = %s
                    LIMIT 1
                    """,
                    [barbero_id, dia_semana],
                )
                row_horario = cursor.fetchone()
                if not row_horario or not bool(row_horario[0]):
                    return Response({"ok": True, "horarios": []})
                barb_ini = self._to_minutes(row_horario[1])
                barb_fin = self._to_minutes(row_horario[2])
                if barb_ini < 0 or barb_fin <= barb_ini:
                    return Response({"ok": True, "horarios": []})

                work_ini = max(negocio_ini, barb_ini)
                work_fin = min(negocio_fin, barb_fin)
                if work_fin - work_ini < duracion:
                    return Response({"ok": True, "horarios": []})

                # Día libre aprobado
                cursor.execute(
                    """
                    SELECT 1
                    FROM negocio.empleado_dia_libre
                    WHERE empleado_id = %s
                      AND fecha = %s
                      AND LOWER(COALESCE(estado, '')) = 'aprobado'
                    LIMIT 1
                    """,
                    [barbero_id, fecha_obj],
                )
                if cursor.fetchone():
                    return Response({"ok": True, "horarios": []})

                # Vacación aprobada
                cursor.execute(
                    """
                    SELECT 1
                    FROM negocio.empleado_vacacion
                    WHERE empleado_id = %s
                      AND %s BETWEEN fecha_inicio AND fecha_fin
                      AND LOWER(COALESCE(estado, '')) = 'aprobada'
                    LIMIT 1
                    """,
                    [barbero_id, fecha_obj],
                )
                if cursor.fetchone():
                    return Response({"ok": True, "horarios": []})

                # Descansos en el día
                cursor.execute(
                    """
                    SELECT hora_inicio, hora_fin
                    FROM negocio.empleado_descanso
                    WHERE empleado_id = %s
                      AND dia_semana = %s
                    """,
                    [barbero_id, dia_semana],
                )
                descansos = []
                for d_ini, d_fin in cursor.fetchall():
                    m_ini = self._to_minutes(d_ini)
                    m_fin = self._to_minutes(d_fin)
                    if m_ini >= 0 and m_fin > m_ini:
                        descansos.append((m_ini, m_fin))

                # Citas ya agendadas ese día (excepto canceladas)
                cursor.execute(
                    sql_citas_ocupadas_dia(),
                    [barbero_id, fecha_obj],
                )
                ocupados = []
                for hora_local, dur_min in cursor.fetchall():
                    if not hora_local:
                        continue
                    start_min = int(hora_local.hour) * 60 + int(hora_local.minute)
                    dur_min = int(dur_min or 0)
                    if dur_min <= 0:
                        continue
                    ocupados.append((start_min, start_min + dur_min))

            horarios = []
            slot = work_ini
            last_start = work_fin - duracion
            while slot <= last_start:
                slot_end = slot + duracion
                bloqueado_descanso = any(self._overlap(slot, slot_end, d0, d1) for d0, d1 in descansos)
                bloqueado_cita = any(self._overlap(slot, slot_end, c0, c1) for c0, c1 in ocupados)
                horarios.append(
                    {
                        "hora": self._fmt_minutes(slot),
                        "disponible": not (bloqueado_descanso or bloqueado_cita),
                    }
                )
                slot += self.SLOT_MINUTES

            horarios = self._marcar_horarios_pasados_web(horarios, fecha_obj)

            return Response({"ok": True, "horarios": horarios})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo consultar la disponibilidad."}, status=500)


class ClipPagoIntentarView(APIView):
    permission_classes = [IsAuthenticated]
    STOCK_DESCONTADO_MARKER = "PEDIDO_STOCK_DESCONTADO"
    STOCK_REPUESTO_MARKER = "PEDIDO_STOCK_REPUESTO"

    def _clip_cipher(self) -> Fernet:
        seed = hashlib.sha256(str(getattr(settings, "SECRET_KEY", "")).encode("utf-8")).digest()
        return Fernet(base64.urlsafe_b64encode(seed))

    def _clip_decrypt(self, value: str) -> str:
        token = str(value or "").strip()
        if not token:
            return ""
        try:
            return self._clip_cipher().decrypt(token.encode("utf-8")).decode("utf-8")
        except (InvalidToken, ValueError, TypeError):
            return ""

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _get_negocio_usuario_id(self, request_user) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE LOWER(username) = LOWER(%s) OR LOWER(email) = LOWER(%s)
                ORDER BY usuario_id ASC
                LIMIT 1
                """,
                [request_user.username, request_user.email],
            )
            row = cursor.fetchone()
        return int(row[0]) if row else None

    def _get_pago_tarjeta_id(self, cursor) -> int | None:
        cursor.execute(
            """
            SELECT metodo_pago_id
            FROM negocio.metodo_pago_catalogo
            WHERE codigo = 'tarjeta'
            LIMIT 1
            """
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _get_tipo_movimiento_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            """
            SELECT tipo_movimiento_id
            FROM negocio.tipo_movimiento_inventario
            WHERE LOWER(COALESCE(codigo, '')) = LOWER(%s)
            LIMIT 1
            """,
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _cargar_clip_config(self) -> dict:
        config_extra = {
            "clip_habilitado": False,
            "clip_url": "",
            "clip_api_key": "",
            "clip_api_secret": "",
            "clip_auth_token": "",
        }
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT url
                FROM negocio.red_social_negocio
                WHERE plataforma = 'otro' AND activa = TRUE
                ORDER BY red_social_id DESC
                LIMIT 1
                """
            )
            row = cursor.fetchone()
        if not row or not row[0]:
            return config_extra
        raw = str(row[0]).strip()
        if not raw.startswith("{"):
            return config_extra
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict) and payload.get("_sys") == "config_extra":
                clip = payload.get("clip", {})
                if isinstance(clip, dict):
                    config_extra["clip_habilitado"] = bool(clip.get("habilitado", False))
                    config_extra["clip_url"] = str(clip.get("url", "") or "").strip()
                    config_extra["clip_api_key"] = self._clip_decrypt(
                        str(clip.get("api_key_enc", clip.get("api_key_test_enc", "")) or "").strip()
                    )
                    config_extra["clip_api_secret"] = self._clip_decrypt(
                        str(clip.get("api_secret_enc", clip.get("api_secret_test_enc", "")) or "").strip()
                    )
                    config_extra["clip_auth_token"] = self._clip_decrypt(
                        str(clip.get("auth_token_enc", "") or "").strip()
                    )
        except Exception:
            pass
        return config_extra

    def _build_clip_auth_headers(self, clip_cfg: dict | None = None) -> dict:
        clip_cfg = clip_cfg or {}
        api_key = str(clip_cfg.get("clip_api_key", "") or "").strip()
        api_secret = str(clip_cfg.get("clip_api_secret", "") or "").strip()
        if not api_key:
            api_key = str(getattr(settings, "CLIP_API_KEY", "") or "").strip()
        if not api_secret:
            api_secret = str(getattr(settings, "CLIP_API_SECRET", "") or "").strip()
        auth_token = self._normalize_clip_auth_token(str(clip_cfg.get("clip_auth_token", "") or "").strip())
        if not auth_token:
            auth_token = self._normalize_clip_auth_token(str(getattr(settings, "CLIP_AUTH_TOKEN", "") or "").strip())
        headers = {"Content-Type": "application/json"}
        if auth_token:
            headers["Authorization"] = auth_token
            return headers
        if api_key and api_secret:
            token = base64.b64encode(f"{api_key}:{api_secret}".encode("utf-8")).decode("utf-8")
            headers["Authorization"] = f"Basic {token}"
            headers["x-api-key"] = api_key
        return headers

    def _normalize_clip_auth_token(self, raw_token: str) -> str:
        token = str(raw_token or "").strip()
        if not token:
            return ""
        # Permite configurar solo el token y aquí se estandariza a header Authorization válido.
        if " " not in token:
            return f"Bearer {token}"
        return token

    def _is_public_https_url(self, raw_url: str) -> bool:
        value = str(raw_url or "").strip()
        if not value:
            return False
        try:
            parsed = urllib_parse.urlparse(value)
        except Exception:
            return False
        host = str(parsed.hostname or "").strip().lower()
        if parsed.scheme.lower() != "https":
            return False
        if not host:
            return False
        if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
            return False
        if host.endswith(".local"):
            return False
        return True

    def _resolve_clip_webhook_url(self, request) -> str:
        configured = str(getattr(settings, "CLIP_WEBHOOK_URL", "") or "").strip()
        if self._is_public_https_url(configured):
            return configured
        # Fallback útil para ambientes desplegados detrás de dominio HTTPS.
        try:
            candidate = request.build_absolute_uri("/api/pagos/clip/webhook/")
        except Exception:
            candidate = ""
        if self._is_public_https_url(candidate):
            return candidate
        return ""

    def _append_nota(self, actual: str | None, marker: str, payload: dict) -> str:
        base = str(actual or "").rstrip()
        bloque = f"[{marker}]{json.dumps(payload, ensure_ascii=False)}"
        return f"{base}\n{bloque}".strip() if base else bloque

    def _clip_api_key_public(self, clip_cfg: dict | None = None) -> str:
        clip_cfg = clip_cfg or {}
        api_key = str(clip_cfg.get("clip_api_key", "") or "").strip()
        if not api_key:
            api_key = str(getattr(settings, "CLIP_API_KEY", "") or "").strip()
        return api_key

    def _clip_resolve_api_credentials(self, clip_cfg: dict | None = None) -> tuple[str, str]:
        clip_cfg = clip_cfg or {}
        api_key = str(clip_cfg.get("clip_api_key", "") or "").strip()
        api_secret = str(clip_cfg.get("clip_api_secret", "") or "").strip()
        if not api_key:
            api_key = str(getattr(settings, "CLIP_API_KEY", "") or "").strip()
        if not api_secret:
            api_secret = str(getattr(settings, "CLIP_API_SECRET", "") or "").strip()
        return api_key, api_secret

    def _clip_merge_outbound_headers(self, hdr: dict[str, str]) -> dict[str, str]:
        """Cloudflare en api.payclip.com a veces bloquea peticiones con User-Agent de Python-urllib (error 1010)."""
        out: dict[str, str] = {str(k): str(v) for k, v in hdr.items()}
        ua = str(getattr(settings, "CLIP_HTTP_USER_AGENT", "") or "").strip()
        if not ua:
            ua = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        out.setdefault("User-Agent", ua)
        out.setdefault("Accept", "application/json")
        out.setdefault("Accept-Language", "es-MX,es;q=0.9,en;q=0.8")
        return out

    def _clip_oauth_access_token(self, api_key: str, api_secret: str) -> str:
        """
        Bearer para API Clip (client_credentials). Sin esto, /payments suele rechazar solo Bearer(api_key).
        Ver: https://developer.clip.mx/reference/token-de-autenticacion
        """
        if not api_key or not api_secret:
            return ""
        bases: list[str] = []
        for b in (
            str(getattr(settings, "CLIP_API_BASE_URL", "https://api-gw.payclip.com") or "").strip().rstrip("/"),
            str(getattr(settings, "CLIP_API_BASE_URL_ALT", "https://api.payclip.com") or "").strip().rstrip("/"),
        ):
            if b and b not in bases:
                bases.append(b)
        token_paths = ["/oauth/token", "/v1/oauth/token", "/v2/oauth/token"]
        for base in bases:
            for tp in token_paths:
                token_url = f"{base}{tp}"
                body_v1 = urllib_parse.urlencode(
                    {
                        "grant_type": "client_credentials",
                        "client_id": api_key,
                        "client_secret": api_secret,
                    }
                ).encode("utf-8")
                req_v1 = urllib_request.Request(
                    url=token_url,
                    data=body_v1,
                    headers=self._clip_merge_outbound_headers(
                        {"Content-Type": "application/x-www-form-urlencoded"}
                    ),
                    method="POST",
                )
                try:
                    with urllib_request.urlopen(req_v1, timeout=12) as response:
                        raw = response.read().decode("utf-8", errors="ignore").strip()
                        payload = json.loads(raw) if raw else {}
                        access_token = str(
                            payload.get("access_token")
                            or (payload.get("data") or {}).get("access_token")
                            or ""
                        ).strip()
                        if access_token:
                            return access_token
                except Exception:
                    pass
                try:
                    basic = base64.b64encode(f"{api_key}:{api_secret}".encode("utf-8")).decode("utf-8")
                    body_v2 = urllib_parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
                    req_v2 = urllib_request.Request(
                        url=token_url,
                        data=body_v2,
                        headers=self._clip_merge_outbound_headers(
                            {
                                "Content-Type": "application/x-www-form-urlencoded",
                                "Authorization": f"Basic {basic}",
                            }
                        ),
                        method="POST",
                    )
                    with urllib_request.urlopen(req_v2, timeout=12) as response:
                        raw = response.read().decode("utf-8", errors="ignore").strip()
                        payload = json.loads(raw) if raw else {}
                        access_token = str(
                            payload.get("access_token")
                            or (payload.get("data") or {}).get("access_token")
                            or ""
                        ).strip()
                        if access_token:
                            return access_token
                except Exception:
                    pass
        return ""

    def _registrar_nota_clip(self, tipo: str, target_id: int, marker: str, payload: dict) -> None:
        with connection.cursor() as cursor:
            if tipo == "pedido":
                cursor.execute("SELECT COALESCE(notas, '') FROM negocio.pedido WHERE pedido_id = %s", [target_id])
                row = cursor.fetchone()
                notas = self._append_nota((row[0] if row else ""), marker, payload)
                cursor.execute("UPDATE negocio.pedido SET notas = %s WHERE pedido_id = %s", [notas, target_id])
            else:
                cursor.execute("SELECT COALESCE(notas, '') FROM negocio.cita WHERE cita_id = %s", [target_id])
                row = cursor.fetchone()
                notas = self._append_nota((row[0] if row else ""), marker, payload)
                cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas, target_id])

    def _get_estado_pedido_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            """
            SELECT estado_pedido_id
            FROM negocio.estado_pedido
            WHERE LOWER(COALESCE(codigo, '')) = LOWER(%s)
            LIMIT 1
            """,
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _descontar_stock_pedido_si_no_aplicado(
        self, cursor, pedido_id: int, usuario_id: int, motivo: str
    ) -> tuple[bool, str]:
        cursor.execute(
            """
            SELECT p.cliente_usuario_id, COALESCE(p.notas, '')
            FROM negocio.pedido p
            WHERE p.pedido_id = %s
            LIMIT 1
            """,
            [pedido_id],
        )
        row = cursor.fetchone()
        if not row:
            return False, "Pedido no encontrado."
        if int(row[0] or 0) != int(usuario_id or 0):
            return False, "No autorizado para descontar inventario de este pedido."
        notas_actuales = str(row[1] or "")
        if f"[{self.STOCK_DESCONTADO_MARKER}]" in notas_actuales:
            return True, ""

        cursor.execute(
            """
            SELECT producto_id, COALESCE(cantidad, 0)
            FROM negocio.pedido_item
            WHERE pedido_id = %s
            """,
            [pedido_id],
        )
        items = cursor.fetchall()
        if not items:
            return False, "El pedido no tiene productos para descontar inventario."

        tipo_mov_venta_id = self._get_tipo_movimiento_id(cursor, "venta")
        stock_por_producto: dict[int, int] = {}

        # Validación con lock para evitar sobreventa en cobros concurrentes.
        for producto_id, cantidad in items:
            cantidad_num = int(cantidad or 0)
            if cantidad_num <= 0:
                continue
            producto_num = int(producto_id)
            cursor.execute(
                """
                SELECT COALESCE(stock_actual, 0)
                FROM negocio.inventario_existencia
                WHERE producto_id = %s
                FOR UPDATE
                """,
                [producto_num],
            )
            stock_row = cursor.fetchone()
            stock_actual = int(stock_row[0] or 0) if stock_row else 0
            if stock_actual < cantidad_num:
                return False, f"Stock insuficiente para producto_id={producto_num}."
            stock_por_producto[producto_num] = stock_actual

        for producto_id, cantidad in items:
            cantidad_num = int(cantidad or 0)
            if cantidad_num <= 0:
                continue
            producto_num = int(producto_id)
            stock_anterior = int(stock_por_producto.get(producto_num, 0))
            stock_posterior = stock_anterior - cantidad_num
            cursor.execute(
                """
                UPDATE negocio.inventario_existencia
                SET stock_actual = %s
                WHERE producto_id = %s
                """,
                [stock_posterior, producto_num],
            )
            if tipo_mov_venta_id:
                cursor.execute(
                    """
                    INSERT INTO negocio.inventario_movimiento (
                        producto_id, tipo_movimiento_id, empleado_id, cantidad,
                        stock_anterior, stock_posterior, referencia_pedido_id, nota
                    )
                    VALUES (%s, %s, NULL, %s, %s, %s, %s, %s)
                    """,
                    [
                        producto_num,
                        tipo_mov_venta_id,
                        cantidad_num,
                        stock_anterior,
                        stock_posterior,
                        pedido_id,
                        f"Salida por venta (checkout): {motivo}",
                    ],
                )

        notas_nuevas = self._append_nota(
            notas_actuales,
            self.STOCK_DESCONTADO_MARKER,
            {"motivo": motivo, "fecha": timezone.now().isoformat()},
        )
        estado_pagado_id = (
            self._get_estado_pedido_id(cursor, "confirmado")
            or self._get_estado_pedido_id(cursor, "pago_validado")
            or self._get_estado_pedido_id(cursor, "aceptado")
        )
        if estado_pagado_id:
            cursor.execute(
                """
                UPDATE negocio.pedido
                SET estado_pedido_id = %s, notas = %s
                WHERE pedido_id = %s
                """,
                [estado_pagado_id, notas_nuevas, pedido_id],
            )
            cursor.execute(
                """
                INSERT INTO negocio.pedido_estado_historial (pedido_id, estado_pedido_id, cambiado_por_usuario_id, motivo)
                VALUES (%s, %s, %s, %s)
                """,
                [pedido_id, estado_pagado_id, usuario_id, "Inventario descontado por pago de tarjeta aprobado"],
            )
        else:
            cursor.execute(
                "UPDATE negocio.pedido SET notas = %s WHERE pedido_id = %s",
                [notas_nuevas, pedido_id],
            )
        return True, ""

    def _autocancelar_pedido_por_pago_fallido(self, pedido_id: int, usuario_id: int, clip_error: str) -> bool:
        """
        Si falla el cobro con tarjeta, revierte efectos del pedido creado en checkout:
        estado cancelado, historial, inventario y uso de promoción.
        """
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            p.pedido_id,
                            p.cliente_usuario_id,
                            COALESCE(p.codigo_descuento, ''),
                            COALESCE(ep.codigo, ''),
                            COALESCE(p.notas, '')
                        FROM negocio.pedido p
                        LEFT JOIN negocio.estado_pedido ep ON ep.estado_pedido_id = p.estado_pedido_id
                        WHERE p.pedido_id = %s
                        LIMIT 1
                        """,
                        [pedido_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return False
                    if int(row[1] or 0) != int(usuario_id or 0):
                        return False
                    estado_actual = str(row[3] or "").strip().lower()
                    notas_actuales = str(row[4] or "")
                    if estado_actual == "cancelado":
                        return True

                    estado_cancelado_id = self._get_estado_pedido_id(cursor, "cancelado")
                    if not estado_cancelado_id:
                        return False

                    if (
                        f"[{self.STOCK_DESCONTADO_MARKER}]" in notas_actuales
                        and f"[{self.STOCK_REPUESTO_MARKER}]" not in notas_actuales
                    ):
                        tipo_mov_entrada_id = self._get_tipo_movimiento_id(cursor, "entrada")
                        cursor.execute(
                            """
                            SELECT producto_id, COALESCE(cantidad, 0)
                            FROM negocio.pedido_item
                            WHERE pedido_id = %s
                            """,
                            [pedido_id],
                        )
                        for producto_id, cantidad in cursor.fetchall():
                            cantidad_num = int(cantidad or 0)
                            if cantidad_num <= 0:
                                continue
                            producto_num = int(producto_id)
                            cursor.execute(
                                """
                                SELECT COALESCE(stock_actual, 0)
                                FROM negocio.inventario_existencia
                                WHERE producto_id = %s
                                FOR UPDATE
                                """,
                                [producto_num],
                            )
                            row_stock = cursor.fetchone()
                            stock_anterior = int(row_stock[0] or 0) if row_stock else 0
                            stock_posterior = stock_anterior + cantidad_num
                            cursor.execute(
                                """
                                UPDATE negocio.inventario_existencia
                                SET stock_actual = %s
                                WHERE producto_id = %s
                                """,
                                [stock_posterior, producto_num],
                            )
                            if tipo_mov_entrada_id:
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.inventario_movimiento (
                                        producto_id, tipo_movimiento_id, empleado_id, cantidad,
                                        stock_anterior, stock_posterior, referencia_pedido_id, nota
                                    )
                                    VALUES (%s, %s, NULL, %s, %s, %s, %s, %s)
                                    """,
                                    [
                                        producto_num,
                                        tipo_mov_entrada_id,
                                        cantidad_num,
                                        stock_anterior,
                                        stock_posterior,
                                        pedido_id,
                                        "Reposición por autocancelación de pago fallido",
                                    ],
                                )

                    codigo_descuento = str(row[2] or "").strip().upper()
                    if codigo_descuento:
                        cursor.execute(
                            """
                            UPDATE negocio.promocion
                            SET usos_actuales = GREATEST(COALESCE(usos_actuales, 0) - 1, 0)
                            WHERE UPPER(COALESCE(codigo, '')) = %s
                            """,
                            [codigo_descuento],
                        )

                    cursor.execute("SELECT COALESCE(notas, '') FROM negocio.pedido WHERE pedido_id = %s", [pedido_id])
                    row_nota = cursor.fetchone()
                    nota_payload = {
                        "motivo": "pago_tarjeta_fallido",
                        "clip_error": str(clip_error or "")[:300],
                        "fecha": timezone.now().isoformat(),
                    }
                    notas = self._append_nota(
                        (row_nota[0] if row_nota else ""),
                        "CLIP_PAGO_FALLIDO_AUTOCANCEL",
                        nota_payload,
                    )
                    if (
                        f"[{self.STOCK_DESCONTADO_MARKER}]" in notas
                        and f"[{self.STOCK_REPUESTO_MARKER}]" not in notas
                    ):
                        notas = self._append_nota(
                            notas,
                            self.STOCK_REPUESTO_MARKER,
                            {"motivo": "autocancelacion_pago_fallido", "fecha": timezone.now().isoformat()},
                        )

                    cursor.execute(
                        """
                        UPDATE negocio.pedido
                        SET estado_pedido_id = %s, notas = %s
                        WHERE pedido_id = %s
                        """,
                        [estado_cancelado_id, notas, pedido_id],
                    )
                    cursor.execute(
                        """
                        INSERT INTO negocio.pedido_estado_historial (pedido_id, estado_pedido_id, cambiado_por_usuario_id, motivo)
                        VALUES (%s, %s, %s, %s)
                        """,
                        [pedido_id, estado_cancelado_id, usuario_id, "Autocancelado por pago de tarjeta fallido (Clip)"],
                    )
            return True
        except Exception:
            return False

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        accion = str(data.get("accion", "")).strip().lower()

        clip_cfg = self._cargar_clip_config()
        if accion == "config":
            return Response(
                {
                    "ok": True,
                    "clip_habilitado": bool(clip_cfg.get("clip_habilitado")),
                    "clip_api_key_public": self._clip_api_key_public(clip_cfg),
                    "sdk_url": "https://sdk.clip.mx/js/clip-sdk.js",
                }
            )

        tipo = str(data.get("tipo", "")).strip().lower()  # pedido | cita
        modo_cobro = str(data.get("modo_cobro", "total")).strip().lower()  # total | anticipo_monto | anticipo_porcentaje
        penalizada = bool(data.get("penalizada", False))
        card_token_id = str(data.get("card_token_id", "") or "").strip()

        if tipo not in {"pedido", "cita"}:
            return Response({"ok": False, "error": "tipo inválido. Usa 'pedido' o 'cita'."}, status=400)
        if modo_cobro not in {"total", "anticipo_monto", "anticipo_porcentaje"}:
            return Response({"ok": False, "error": "modo_cobro inválido."}, status=400)
        if tipo == "pedido" and modo_cobro != "total":
            return Response({"ok": False, "error": "En pedidos solo se permite cobro total."}, status=400)

        negocio_usuario_id = self._get_negocio_usuario_id(request.user)
        if not negocio_usuario_id:
            return Response({"ok": False, "error": "No se encontró usuario de negocio asociado."}, status=404)

        if not clip_cfg.get("clip_habilitado"):
            return Response({"ok": False, "error": "Clip no está habilitado por el administrador."}, status=400)

        monto_total = Decimal("0.00")
        monto_cobrar = Decimal("0.00")
        target_id = None
        porcentaje_penalizacion = Decimal("0.00")

        try:
            with connection.cursor() as cursor:
                if tipo == "pedido":
                    pedido_id = int(data.get("pedido_id", 0) or 0)
                    if pedido_id <= 0:
                        return Response({"ok": False, "error": "pedido_id inválido."}, status=400)
                    cursor.execute(
                        """
                        SELECT p.total
                        FROM negocio.pedido p
                        WHERE p.pedido_id = %s
                          AND p.cliente_usuario_id = %s
                        LIMIT 1
                        """,
                        [pedido_id, negocio_usuario_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Pedido no encontrado."}, status=404)
                    target_id = pedido_id
                    monto_total = self._to_money(row[0])
                    monto_cobrar = monto_total
                else:
                    cita_id = int(data.get("cita_id", 0) or 0)
                    if cita_id <= 0:
                        return Response({"ok": False, "error": "cita_id inválido."}, status=400)
                    cursor.execute(
                        """
                        SELECT c.precio_total
                        FROM negocio.cita c
                        WHERE c.cita_id = %s
                          AND c.cliente_usuario_id = %s
                        LIMIT 1
                        """,
                        [cita_id, negocio_usuario_id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response({"ok": False, "error": "Cita no encontrada."}, status=404)
                    target_id = cita_id
                    monto_total = self._to_money(row[0])

                    cursor.execute(
                        """
                        SELECT porcentaje_anticipo
                        FROM negocio.politica_anticipo
                        ORDER BY politica_anticipo_id DESC
                        LIMIT 1
                        """
                    )
                    row_pol = cursor.fetchone()
                    porcentaje_penalizacion = self._to_money(row_pol[0] if row_pol else 0)

                    if modo_cobro == "total":
                        monto_cobrar = monto_total
                    elif modo_cobro == "anticipo_monto":
                        monto_cobrar = self._to_money(data.get("anticipo_monto", 0))
                    else:
                        porcentaje = int(data.get("anticipo_porcentaje", 0) or 0)
                        if porcentaje <= 0 or porcentaje > 100 or (porcentaje % 10 != 0):
                            return Response(
                                {"ok": False, "error": "anticipo_porcentaje debe ser múltiplo de 10 entre 10 y 100."},
                                status=400,
                            )
                        monto_cobrar = self._to_money((monto_total * Decimal(porcentaje)) / Decimal("100"))

                    if monto_cobrar < Decimal("1.00") or monto_cobrar > monto_total:
                        return Response(
                            {"ok": False, "error": "El anticipo debe estar entre $1.00 y el total de la cita."},
                            status=400,
                        )

                    if penalizada and modo_cobro != "total":
                        minimo_penalizacion = self._to_money((monto_total * porcentaje_penalizacion) / Decimal("100"))
                        if monto_cobrar < minimo_penalizacion:
                            return Response(
                                {
                                    "ok": False,
                                    "error": (
                                        f"Por penalización el anticipo mínimo es ${minimo_penalizacion} MXN."
                                    ),
                                },
                                status=400,
                            )
        except (ValueError, TypeError):
            return Response({"ok": False, "error": "Datos inválidos para generar pago Clip."}, status=400)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo preparar el pago."}, status=500)

        referencia = f"SBC-{tipo[:3].upper()}-{target_id}-{int(time.time())}"
        success_url = str(getattr(settings, "CLIP_RETURN_SUCCESS_URL", "") or "").strip()
        cancel_url = str(getattr(settings, "CLIP_RETURN_CANCEL_URL", "") or "").strip()
        webhook_url = self._resolve_clip_webhook_url(request)
        create_url = str(getattr(settings, "CLIP_CHECKOUT_CREATE_URL", "") or "").strip()
        if not create_url:
            base_url = str(getattr(settings, "CLIP_API_BASE_URL", "https://api-gw.payclip.com") or "").strip().rstrip("/")
            path = str(getattr(settings, "CLIP_CHECKOUT_CREATE_PATH", "/paymentrequest") or "").strip()
            create_url = f"{base_url}{path if path.startswith('/') else '/' + path}"

        clip_payload = {
            "amount": float(monto_cobrar),
            "currency": "MXN",
            "reference": referencia,
            "description": f"Stylo Barber - {tipo} #{target_id}",
            "customer": {"email": request.user.email},
            "redirect_urls": {
                "success": success_url,
                "cancel": cancel_url,
            },
            "metadata": {
                "source": "stylo_barber_connect",
                "tipo": tipo,
                "target_id": target_id,
                "modo_cobro": modo_cobro,
                "penalizada": penalizada,
                "monto_total": str(monto_total),
                "monto_cobrar": str(monto_cobrar),
            },
        }
        if webhook_url:
            clip_payload["webhook_url"] = webhook_url

        # Flujo recomendado de Clip Checkout Transparente:
        # frontend tokeniza tarjeta con clip-sdk.js y backend cobra con /payments.
        if card_token_id:
            api_key_public = self._clip_api_key_public(clip_cfg)
            api_key_sec, api_secret_sec = self._clip_resolve_api_credentials(clip_cfg)
            auth_token = self._normalize_clip_auth_token(str(clip_cfg.get("clip_auth_token", "") or "").strip())
            if not auth_token:
                auth_token = self._normalize_clip_auth_token(str(getattr(settings, "CLIP_AUTH_TOKEN", "") or "").strip())
            if not auth_token and not api_key_public and not (api_key_sec and api_secret_sec):
                return Response(
                    {
                        "ok": False,
                        "error": "Falta API Key (o API Key + Secret) de Clip para cobrar con Checkout Transparente.",
                    },
                    status=400,
                )

            # Solo api-gw para /payments: api.payclip.com/payments está detrás de reglas CF que bloquean
            # tráfico no-browser (error 1010); oauth puede ir por api.payclip.com sin ese bloqueo en /oauth/token.
            payments_urls: list[str] = []
            for u in (
                str(getattr(settings, "CLIP_PAYMENTS_URL", "") or "").strip(),
                str(getattr(settings, "CLIP_PAYMENTS_URL_ALT", "") or "").strip(),
                "https://api-gw.payclip.com/payments",
            ):
                if u and u not in payments_urls:
                    payments_urls.append(u)
            reference_alt = f"SBC{tipo[:3].upper()}{target_id}{int(time.time())}"
            external_reference = referencia.replace(" ", "").strip()[:36]
            customer_email = str(data.get("cliente_email", "") or "").strip() or str(request.user.email or "").strip()
            customer_phone_raw = str(data.get("cliente_phone", "") or "").strip()
            customer_phone = re.sub(r"\D+", "", customer_phone_raw)
            if len(customer_phone) < 10:
                # Fallback seguro para no romper request; Clip puede rechazarlo si no cumple su política.
                customer_phone = "5555555555"

            payload_candidates = [
                {
                    "amount": float(monto_cobrar),
                    "currency": "MXN",
                    "capture_method": "automatic",
                    "description": f"Stylo Barber - {tipo} #{target_id}",
                    "external_reference": external_reference or reference_alt[:36],
                    "payment_method": {"token": card_token_id},
                    "customer": {
                        "email": customer_email,
                        "phone": customer_phone,
                    },
                    "metadata": clip_payload.get("metadata", {}),
                    **({"webhook_url": webhook_url} if webhook_url else {}),
                },
                {
                    "amount": float(monto_cobrar),
                    "currency": "MXN",
                    "description": f"Stylo Barber - {tipo} #{target_id}",
                    "external_reference": external_reference or reference_alt[:36],
                    "source": {"type": "card", "token_id": card_token_id},
                    "customer": {
                        "email": customer_email,
                        "phone": customer_phone,
                    },
                    "metadata": clip_payload.get("metadata", {}),
                    **({"webhook_url": webhook_url} if webhook_url else {}),
                },
                {
                    "amount": float(monto_cobrar),
                    "currency": "MXN",
                    "description": f"Stylo Barber - {tipo} #{target_id}",
                    "external_reference": reference_alt,
                    "source": {"type": "card", "token": card_token_id},
                    "customer": {
                        "email": customer_email,
                        "phone": customer_phone,
                    },
                    "metadata": clip_payload.get("metadata", {}),
                    **({"webhook_url": webhook_url} if webhook_url else {}),
                },
            ]

            headers_candidates: list[dict[str, str]] = []
            oauth_access = self._clip_oauth_access_token(api_key_sec, api_secret_sec)
            if oauth_access:
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {oauth_access}",
                        "x-api-key": api_key_sec,
                    }
                )
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "x-api-key": api_key_sec,
                    }
                )
            if api_key_sec and api_secret_sec:
                basic_pay = base64.b64encode(f"{api_key_sec}:{api_secret_sec}".encode("utf-8")).decode("utf-8")
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": f"Basic {basic_pay}",
                    }
                )
            if auth_token:
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": auth_token,
                    }
                )
            if api_key_public:
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key_public}",
                    }
                )
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key_public}",
                        "x-api-key": api_key_public,
                    }
                )
                headers_candidates.append(
                    {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "x-api-key": api_key_public,
                    }
                )

            transparent_errors: list[str] = []
            payments_response: dict = {}
            paid_ok = False
            for payments_url in payments_urls:
                if paid_ok:
                    break
                # En api-gw, algunos API Gateway rechazan Authorization no-SigV4 con
                # "requires Credential/Signature/SignedHeaders". Probamos primero sin Authorization.
                ordered_headers = list(headers_candidates)
                if "api-gw.payclip.com" in str(payments_url or ""):
                    ordered_headers.sort(key=lambda h: 1 if h.get("Authorization") else 0)
                for hdr in ordered_headers:
                    if paid_ok:
                        break
                    for pay in payload_candidates:
                        req = urllib_request.Request(
                            url=payments_url,
                            data=json.dumps(pay).encode("utf-8"),
                            headers=self._clip_merge_outbound_headers(hdr),
                            method="POST",
                        )
                        try:
                            with urllib_request.urlopen(req, timeout=20) as response:
                                raw = response.read().decode("utf-8", errors="ignore").strip()
                                payments_response = json.loads(raw) if raw else {}
                                status_raw = str(
                                    payments_response.get("status")
                                    or (payments_response.get("data") or {}).get("status")
                                    or ""
                                ).strip().lower()
                                paid_ok = bool(
                                    status_raw
                                    in {"approved", "paid", "successful", "succeeded", "completed", "captured"}
                                    or payments_response.get("ok") is True
                                    or (payments_response.get("data") or {}).get("id")
                                    or payments_response.get("id")
                                )
                                if paid_ok:
                                    break
                                transparent_errors.append(
                                    f"{payments_url}: respuesta sin éxito: {str(payments_response)[:180]}"
                                )
                        except urllib_error.HTTPError as exc:
                            try:
                                error_raw = exc.read().decode("utf-8", errors="ignore").strip()
                            except Exception:
                                error_raw = ""
                            transparent_errors.append(f"{payments_url} HTTP {exc.code}: {error_raw[:220]}")
                        except Exception as exc:
                            transparent_errors.append(f"{payments_url} Error: {str(exc)[:220]}")

            if not paid_ok:
                detalle = " | ".join(transparent_errors[:4]) if transparent_errors else "Sin respuesta válida de Clip /payments."
                if tipo == "pedido" and target_id:
                    self._autocancelar_pedido_por_pago_fallido(
                        pedido_id=int(target_id),
                        usuario_id=int(negocio_usuario_id),
                        clip_error=detalle,
                    )
                return Response(
                    {
                        "ok": False,
                        "error": "No se pudo completar el cobro con Checkout Transparente.",
                        "clip_error": detalle,
                    },
                    status=502,
                )

            payment_id = str(
                payments_response.get("id")
                or (payments_response.get("data") or {}).get("id")
                or ""
            ).strip()
            success_status = str(
                payments_response.get("status")
                or (payments_response.get("data") or {}).get("status")
                or "approved"
            ).strip().lower()

            try:
                with transaction.atomic():
                    marker_payload = {
                        "reference": referencia,
                        "tipo": tipo,
                        "target_id": target_id,
                        "monto_total": str(monto_total),
                        "monto_cobrar": str(monto_cobrar),
                        "clip_payment_id": payment_id,
                        "clip_status": success_status,
                    }
                    self._registrar_nota_clip(tipo, target_id, "CLIP_PAGO_DIRECTO_OK", marker_payload)

                    if tipo == "pedido":
                        with connection.cursor() as cursor:
                            stock_ok, stock_error = self._descontar_stock_pedido_si_no_aplicado(
                                cursor=cursor,
                                pedido_id=int(target_id),
                                usuario_id=int(negocio_usuario_id),
                                motivo="pago_clip_directo_aprobado",
                            )
                            if not stock_ok:
                                return Response(
                                    {
                                        "ok": False,
                                        "error": (
                                            "Pago aprobado, pero no se pudo aplicar inventario local del pedido. "
                                            "Contacta a administración para validación manual."
                                        ),
                                        "clip_error": stock_error,
                                    },
                                    status=409,
                                )
                    elif tipo == "cita":
                        with connection.cursor() as cursor:
                            metodo_pago_tarjeta_id = self._get_pago_tarjeta_id(cursor)
                            if metodo_pago_tarjeta_id:
                                cursor.execute(
                                    """
                                    INSERT INTO negocio.anticipo_cita (
                                        cita_id, monto_anticipo, metodo_pago_id, comprobante_url, estado_validacion, fecha_validacion
                                    )
                                    VALUES (%s, %s, %s, %s, 'validado', NOW())
                                    """,
                                    [target_id, monto_cobrar, metodo_pago_tarjeta_id, f"clip://{payment_id or referencia}"],
                                )
            except DatabaseError:
                return Response({"ok": False, "error": "Pago cobrado, pero no se pudo registrar en la BD local."}, status=500)

            return Response(
                {
                    "ok": True,
                    "provider": "clip",
                    "pago_directo": True,
                    "reference": referencia,
                    "clip_payment_id": payment_id,
                    "estado_pago": success_status or "approved",
                    "monto_total": float(monto_total),
                    "monto_cobrar": float(monto_cobrar),
                    "tipo": tipo,
                    "modo_cobro": modo_cobro,
                    "penalizada": penalizada,
                }
            )

        api_key_admin = str(clip_cfg.get("clip_api_key", "") or "").strip()
        api_secret_admin = str(clip_cfg.get("clip_api_secret", "") or "").strip()
        api_key_env = str(getattr(settings, "CLIP_API_KEY", "") or "").strip()
        api_secret_env = str(getattr(settings, "CLIP_API_SECRET", "") or "").strip()
        auth_token = self._normalize_clip_auth_token(str(clip_cfg.get("clip_auth_token", "") or "").strip())
        if not auth_token:
            auth_token = self._normalize_clip_auth_token(str(getattr(settings, "CLIP_AUTH_TOKEN", "") or "").strip())

        if not auth_token and not ((api_key_admin and api_secret_admin) or (api_key_env and api_secret_env)):
            return Response(
                {
                    "ok": False,
                    "error": (
                        "Faltan credenciales de Clip. Configura API Key y API Secret en el panel de administrador "
                        "o en variables CLIP_API_KEY/CLIP_API_SECRET del backend."
                    ),
                },
                status=400,
            )
        base_url = str(getattr(settings, "CLIP_API_BASE_URL", "https://api-gw.payclip.com") or "").strip().rstrip("/")
        alt_base_url = str(getattr(settings, "CLIP_API_BASE_URL_ALT", "https://api.payclip.com") or "").strip().rstrip("/")
        base_candidates: list[str] = []
        if base_url:
            base_candidates.append(base_url)
        if alt_base_url and alt_base_url not in base_candidates:
            base_candidates.append(alt_base_url)
        path_cfg = str(getattr(settings, "CLIP_CHECKOUT_CREATE_PATH", "/paymentrequest") or "").strip()
        create_url_cfg = str(getattr(settings, "CLIP_CHECKOUT_CREATE_URL", "") or "").strip()
        candidate_urls = []
        if create_url_cfg:
            candidate_urls.append(create_url_cfg)
        if create_url:
            candidate_urls.append(create_url)
        for b in base_candidates:
            for p in [path_cfg, "/paymentrequest", "/v2/paymentrequest", "/checkout", "/v2/checkout"]:
                if not p:
                    continue
                pp = p if str(p).startswith("/") else f"/{p}"
                u = f"{b}{pp}"
                if u not in candidate_urls:
                    candidate_urls.append(u)

        header_variants: list[dict] = []
        if auth_token:
            header_variants.append({"Content-Type": "application/json", "Authorization": auth_token})
        cred_candidates: list[tuple[str, str, str]] = []
        if api_key_admin and api_secret_admin:
            cred_candidates.append(("admin", api_key_admin, api_secret_admin))
        if api_key_env and api_secret_env and (api_key_env != api_key_admin or api_secret_env != api_secret_admin):
            cred_candidates.append(("env", api_key_env, api_secret_env))

        cred_sources_used: list[str] = []
        oauth_tried_errors: list[str] = []

        def _get_clip_oauth_token(base: str, key: str, secret: str) -> str:
            token_paths = ["/oauth/token", "/v1/oauth/token", "/v2/oauth/token"]
            for tp in token_paths:
                token_url = f"{base}{tp}"
                # Variante 1: client_id + client_secret en body.
                body_v1 = urllib_parse.urlencode(
                    {
                        "grant_type": "client_credentials",
                        "client_id": key,
                        "client_secret": secret,
                    }
                ).encode("utf-8")
                req_v1 = urllib_request.Request(
                    url=token_url,
                    data=body_v1,
                    headers=self._clip_merge_outbound_headers(
                        {"Content-Type": "application/x-www-form-urlencoded"}
                    ),
                    method="POST",
                )
                try:
                    with urllib_request.urlopen(req_v1, timeout=12) as response:
                        raw = response.read().decode("utf-8", errors="ignore").strip()
                        payload = json.loads(raw) if raw else {}
                        access_token = str(
                            payload.get("access_token")
                            or (payload.get("data") or {}).get("access_token")
                            or ""
                        ).strip()
                        if access_token:
                            return access_token
                except urllib_error.HTTPError as exc:
                    try:
                        detail = exc.read().decode("utf-8", errors="ignore").strip()
                    except Exception:
                        detail = ""
                    oauth_tried_errors.append(f"{token_url} body-cred -> HTTP {exc.code}: {detail[:180]}")
                except Exception as exc:
                    oauth_tried_errors.append(f"{token_url} body-cred -> Error: {str(exc)[:180]}")

                # Variante 2: Basic auth + grant_type.
                try:
                    basic = base64.b64encode(f"{key}:{secret}".encode("utf-8")).decode("utf-8")
                    body_v2 = urllib_parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
                    req_v2 = urllib_request.Request(
                        url=token_url,
                        data=body_v2,
                        headers=self._clip_merge_outbound_headers(
                            {
                                "Content-Type": "application/x-www-form-urlencoded",
                                "Authorization": f"Basic {basic}",
                            }
                        ),
                        method="POST",
                    )
                    with urllib_request.urlopen(req_v2, timeout=12) as response:
                        raw = response.read().decode("utf-8", errors="ignore").strip()
                        payload = json.loads(raw) if raw else {}
                        access_token = str(
                            payload.get("access_token")
                            or (payload.get("data") or {}).get("access_token")
                            or ""
                        ).strip()
                        if access_token:
                            return access_token
                except urllib_error.HTTPError as exc:
                    try:
                        detail = exc.read().decode("utf-8", errors="ignore").strip()
                    except Exception:
                        detail = ""
                    oauth_tried_errors.append(f"{token_url} basic-cred -> HTTP {exc.code}: {detail[:180]}")
                except Exception as exc:
                    oauth_tried_errors.append(f"{token_url} basic-cred -> Error: {str(exc)[:180]}")
            return ""

        for source_name, api_key, api_secret in cred_candidates:
            key_mask = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) >= 8 else "***"
            cred_sources_used.append(f"{source_name}:{key_mask}")

            # Si Clip requiere OAuth por client_credentials, intentamos obtener bearer token primero.
            for oauth_base in base_candidates:
                oauth_token = _get_clip_oauth_token(oauth_base, api_key, api_secret)
                if oauth_token:
                    header_variants.append(
                        {
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {oauth_token}",
                        }
                    )
                    break

            basic_token = base64.b64encode(f"{api_key}:{api_secret}".encode("utf-8")).decode("utf-8")
            header_variants.append(
                {
                    "Content-Type": "application/json",
                    "Authorization": f"Basic {basic_token}",
                    "x-api-key": api_key,
                }
            )
            header_variants.append(
                {
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "x-api-secret": api_secret,
                }
            )
            header_variants.append(
                {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                }
            )

        clip_response = {}
        clip_error_detail = ""
        payment_url = ""
        tried_errors: list[str] = []

        payload_bytes = json.dumps(clip_payload).encode("utf-8")
        for candidate_url in candidate_urls:
            if payment_url:
                break
            for headers in header_variants:
                req = urllib_request.Request(
                    url=candidate_url,
                    data=payload_bytes,
                    headers=self._clip_merge_outbound_headers(headers),
                    method="POST",
                )
                try:
                    with urllib_request.urlopen(req, timeout=20) as response:
                        raw = response.read().decode("utf-8", errors="ignore").strip()
                        clip_response = json.loads(raw) if raw else {}
                        if isinstance(clip_response, dict):
                            payment_url = (
                                clip_response.get("payment_url")
                                or clip_response.get("checkout_url")
                                or clip_response.get("redirect_url")
                                or clip_response.get("url")
                                or (clip_response.get("data") or {}).get("url")
                                or ""
                            )
                        payment_url = str(payment_url or "").strip()
                        if payment_url:
                            break
                        tried_errors.append(f"{candidate_url} -> respuesta sin URL de pago")
                except urllib_error.HTTPError as exc:
                    try:
                        error_raw = exc.read().decode("utf-8", errors="ignore").strip()
                    except Exception:
                        error_raw = ""
                    tried_errors.append(f"{candidate_url} -> HTTP {exc.code}: {error_raw[:220]}")
                    clip_response = {}
                except urllib_error.URLError as exc:
                    tried_errors.append(f"{candidate_url} -> URL error: {str(getattr(exc, 'reason', '') or str(exc))[:220]}")
                    clip_response = {}
                except Exception as exc:
                    tried_errors.append(f"{candidate_url} -> Error: {str(exc)[:220]}")
                    clip_response = {}

        if tried_errors:
            clip_error_detail = " | ".join(tried_errors[:4])
            if cred_sources_used:
                clip_error_detail = f"credenciales={','.join(cred_sources_used)} | {clip_error_detail}"
            if oauth_tried_errors:
                clip_error_detail = (
                    f"{clip_error_detail} | oauth={'; '.join(oauth_tried_errors[:2])}"
                )

        if not payment_url:
            logger.warning(
                "Clip intento fallido: tipo=%s target_id=%s referencia=%s detalle=%s",
                tipo,
                target_id,
                referencia,
                clip_error_detail,
            )
            return Response(
                {
                    "ok": False,
                    "error": (
                        "No se pudo generar URL de pago en Clip con monto dinámico. "
                        "Revisa credenciales/endpoint de Clip y la configuración del backend."
                    ),
                    "clip_error": clip_error_detail,
                },
                status=502,
            )

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    marker_payload = {
                        "reference": referencia,
                        "tipo": tipo,
                        "target_id": target_id,
                        "modo_cobro": modo_cobro,
                        "monto_total": str(monto_total),
                        "monto_cobrar": str(monto_cobrar),
                        "penalizada": penalizada,
                    }
                    if tipo == "pedido":
                        cursor.execute("SELECT COALESCE(notas, '') FROM negocio.pedido WHERE pedido_id = %s", [target_id])
                        row = cursor.fetchone()
                        notas = self._append_nota((row[0] if row else ""), "CLIP_INTENTO", marker_payload)
                        cursor.execute("UPDATE negocio.pedido SET notas = %s WHERE pedido_id = %s", [notas, target_id])
                    else:
                        cursor.execute("SELECT COALESCE(notas, '') FROM negocio.cita WHERE cita_id = %s", [target_id])
                        row = cursor.fetchone()
                        notas = self._append_nota((row[0] if row else ""), "CLIP_INTENTO", marker_payload)
                        cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas, target_id])

                        metodo_pago_tarjeta_id = self._get_pago_tarjeta_id(cursor)
                        if metodo_pago_tarjeta_id:
                            cursor.execute(
                                """
                                INSERT INTO negocio.anticipo_cita (
                                    cita_id, monto_anticipo, metodo_pago_id, comprobante_url, estado_validacion
                                )
                                VALUES (%s, %s, %s, %s, 'pendiente')
                                """,
                                [target_id, monto_cobrar, metodo_pago_tarjeta_id, f"clip://{referencia}"],
                            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo registrar el intento de pago."}, status=500)

        return Response(
            {
                "ok": True,
                "provider": "clip",
                "reference": referencia,
                "payment_url": payment_url,
                "monto_total": float(monto_total),
                "monto_cobrar": float(monto_cobrar),
                "tipo": tipo,
                "modo_cobro": modo_cobro,
                "penalizada": penalizada,
            }
        )


class ClipWebhookView(APIView):
    permission_classes = [AllowAny]

    SUCCESS_CODES = {"approved", "paid", "successful", "succeeded", "completed"}

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _extract_clip_event(self, payload: dict) -> tuple[str, str, str, Decimal]:
        status = str(
            payload.get("status")
            or payload.get("event")
            or payload.get("type")
            or (payload.get("data") or {}).get("status")
            or ""
        ).strip().lower()

        reference = str(
            payload.get("reference")
            or payload.get("customTransactionId")
            or payload.get("custom_transaction_id")
            or (payload.get("metadata") or {}).get("reference")
            or (payload.get("data") or {}).get("reference")
            or ""
        ).strip()

        transaction_id = str(
            payload.get("transaction_id")
            or payload.get("id")
            or (payload.get("data") or {}).get("id")
            or ""
        ).strip()

        amount_raw = (
            payload.get("amount")
            or (payload.get("data") or {}).get("amount")
            or 0
        )
        amount = self._to_money(amount_raw)
        return status, reference, transaction_id, amount

    def _validate_signature(self, request) -> bool:
        secret = str(getattr(settings, "CLIP_WEBHOOK_SECRET", "") or "").strip()
        if not secret:
            return True

        header_name = str(getattr(settings, "CLIP_WEBHOOK_SIGNATURE_HEADER", "X-Clip-Signature") or "X-Clip-Signature")
        header_key = f"HTTP_{header_name.upper().replace('-', '_')}"
        incoming = str(request.META.get(header_key, "") or "").strip()
        if not incoming:
            return False

        expected = hmac.new(secret.encode("utf-8"), request.body, hashlib.sha256).hexdigest()
        incoming_clean = incoming.replace("sha256=", "").strip().lower()
        return constant_time_compare(incoming_clean, expected.lower())

    def _append_nota(self, actual: str | None, marker: str, payload: dict) -> str:
        base = str(actual or "").rstrip()
        bloque = f"[{marker}]{json.dumps(payload, ensure_ascii=False)}"
        return f"{base}\n{bloque}".strip() if base else bloque

    def post(self, request):
        if not self._validate_signature(request):
            return Response({"ok": False, "error": "Firma de webhook inválida."}, status=401)

        try:
            payload = json.loads(request.body.decode("utf-8"))
        except Exception:
            payload = request.data if isinstance(request.data, dict) else {}

        status, reference, transaction_id, amount = self._extract_clip_event(payload)
        if not reference:
            return Response({"ok": False, "error": "Webhook sin referencia."}, status=400)

        if status not in self.SUCCESS_CODES:
            return Response({"ok": True, "mensaje": "Evento recibido, sin acción por estado."})

        parts = reference.split("-")
        if len(parts) < 4 or parts[0] != "SBC":
            return Response({"ok": True, "mensaje": "Referencia externa, sin acción en Stylo."})

        tipo_tag = parts[1].upper()
        try:
            target_id = int(parts[2])
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "Referencia inválida."}, status=400)

        webhook_note = {
            "reference": reference,
            "status": status,
            "transaction_id": transaction_id,
            "amount": str(amount),
            "at": timezone.now().isoformat(),
        }

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    if tipo_tag == "PED":
                        cursor.execute("SELECT COALESCE(notas, '') FROM negocio.pedido WHERE pedido_id = %s", [target_id])
                        row = cursor.fetchone()
                        if not row:
                            return Response({"ok": False, "error": "Pedido no encontrado para referencia."}, status=404)
                        notas = self._append_nota(row[0], "CLIP_WEBHOOK_OK", webhook_note)
                        cursor.execute("UPDATE negocio.pedido SET notas = %s WHERE pedido_id = %s", [notas, target_id])
                    elif tipo_tag == "CIT":
                        cursor.execute("SELECT COALESCE(notas, '') FROM negocio.cita WHERE cita_id = %s", [target_id])
                        row = cursor.fetchone()
                        if not row:
                            return Response({"ok": False, "error": "Cita no encontrada para referencia."}, status=404)
                        notas = self._append_nota(row[0], "CLIP_WEBHOOK_OK", webhook_note)
                        cursor.execute("UPDATE negocio.cita SET notas = %s WHERE cita_id = %s", [notas, target_id])

                        # Si había anticipo pendiente creado desde el intento Clip, márcalo como validado.
                        cursor.execute(
                            """
                            UPDATE negocio.anticipo_cita ac
                            SET estado_validacion = 'validado',
                                fecha_validacion = NOW()
                            WHERE ac.cita_id = %s
                              AND ac.estado_validacion = 'pendiente'
                              AND ac.comprobante_url = %s
                            """,
                            [target_id, f"clip://{reference}"],
                        )
                    else:
                        return Response({"ok": True, "mensaje": "Tipo de referencia no administrado."})
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo aplicar webhook de Clip."}, status=500)

        return Response({"ok": True, "mensaje": "Webhook aplicado correctamente."})


class PromocionValidarView(APIView):
    permission_classes = [IsAuthenticated]

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _calcular_descuento_2x1(self, items: list[dict]) -> Decimal:
        precios: list[Decimal] = []
        for item in items:
            cantidad = int(item.get("cantidad") or 0)
            precio = self._to_money(item.get("precio_unitario"))
            if cantidad <= 0 or precio <= 0:
                continue
            # Lista expandida por cantidad para aplicar 2x1 por unidades.
            precios.extend([precio] * min(cantidad, 500))
        if len(precios) < 2:
            return Decimal("0.00")
        precios.sort(reverse=True)
        descuento = Decimal("0.00")
        for idx in range(1, len(precios), 2):
            descuento += precios[idx]
        return descuento.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    def _calcular_descuento_producto_gratis(self, items: list[dict]) -> Decimal:
        precios: list[Decimal] = []
        for item in items:
            cantidad = int(item.get("cantidad") or 0)
            precio = self._to_money(item.get("precio_unitario"))
            if cantidad <= 0 or precio <= 0:
                continue
            precios.extend([precio] * min(cantidad, 500))
        if not precios:
            return Decimal("0.00")
        return min(precios).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        codigo = str(data.get("codigo", "")).strip().upper()
        objetivo = str(data.get("aplica_en_objetivo", "productos") or "productos").strip().lower()
        if objetivo not in {"productos", "servicios"}:
            objetivo = "productos"
        if not codigo:
            return Response({"ok": False, "error": "El código es obligatorio."}, status=400)

        items = data.get("items") if isinstance(data.get("items"), list) else []
        subtotal = self._to_money(data.get("subtotal"))
        if items:
            subtotal = Decimal("0.00")
            for item in items:
                if not isinstance(item, dict):
                    continue
                cantidad = int(item.get("cantidad") or 0)
                precio = self._to_money(item.get("precio_unitario"))
                if cantidad > 0 and precio > 0:
                    subtotal += (precio * Decimal(cantidad))
            subtotal = subtotal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        if subtotal <= 0:
            return Response({"ok": False, "error": "El subtotal debe ser mayor a 0."}, status=400)

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        promocion_id,
                        nombre,
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
                    WHERE UPPER(COALESCE(codigo, '')) = %s
                    LIMIT 1
                    """,
                    [codigo],
                )
                row = cursor.fetchone()
            if not row:
                return Response({"ok": False, "error": "Código inválido o no existe."}, status=404)

            (
                promocion_id,
                nombre,
                tipo_descuento,
                aplica_en,
                valor_descuento,
                codigo_db,
                fecha_inicio,
                fecha_fin,
                solo_clientes_nuevos,
                requiere_compra_minima,
                monto_compra_minima,
                limite_usos,
                usos_actuales,
                activa,
            ) = row

            hoy = date.today()
            if not bool(activa):
                return Response({"ok": False, "error": "La promoción está pausada."}, status=400)
            if fecha_inicio and hoy < fecha_inicio:
                return Response({"ok": False, "error": "La promoción aún no inicia."}, status=400)
            if fecha_fin and hoy > fecha_fin:
                return Response({"ok": False, "error": "La promoción ya finalizó."}, status=400)
            aplica_en_norm = str(aplica_en or "").strip().lower()
            if objetivo == "productos" and aplica_en_norm not in {"productos", "ambos"}:
                return Response({"ok": False, "error": "Esta promoción no aplica a productos."}, status=400)
            if objetivo == "servicios" and aplica_en_norm not in {"servicios", "ambos"}:
                return Response({"ok": False, "error": "Esta promoción no aplica a servicios."}, status=400)
            if limite_usos is not None and int(usos_actuales or 0) >= int(limite_usos):
                return Response({"ok": False, "error": "La promoción alcanzó su límite de usos."}, status=400)
            if bool(requiere_compra_minima):
                minimo = self._to_money(monto_compra_minima)
                if subtotal < minimo:
                    return Response(
                        {"ok": False, "error": f"Compra mínima requerida: ${float(minimo):.2f} MXN."},
                        status=400,
                    )

            valor = self._to_money(valor_descuento)
            tipo = str(tipo_descuento or "").strip().lower()
            descuento = Decimal("0.00")

            if tipo == "porcentaje":
                if valor <= 0 or valor > 100:
                    return Response({"ok": False, "error": "Configuración de porcentaje inválida."}, status=400)
                descuento = (subtotal * valor / Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            elif tipo == "monto_fijo":
                descuento = min(valor, subtotal).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            elif tipo == "2x1":
                if objetivo == "servicios":
                    return Response({"ok": False, "error": "La promoción 2x1 no aplica a este flujo de servicios."}, status=400)
                descuento = self._calcular_descuento_2x1(items)
                if descuento <= 0:
                    return Response({"ok": False, "error": "Esta promoción requiere al menos 2 productos."}, status=400)
            elif tipo == "producto_gratis":
                if objetivo == "servicios":
                    return Response({"ok": False, "error": "La promoción de producto gratis no aplica a servicios."}, status=400)
                descuento = self._calcular_descuento_producto_gratis(items)
                if descuento <= 0:
                    return Response({"ok": False, "error": "Esta promoción requiere productos en el carrito."}, status=400)
            else:
                return Response({"ok": False, "error": "Tipo de promoción no soportado."}, status=400)

            if descuento > subtotal:
                descuento = subtotal

            total = (subtotal - descuento).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            return Response(
                {
                    "ok": True,
                    "promocion": {
                        "id": int(promocion_id),
                        "nombre": nombre or "",
                        "codigo": (codigo_db or codigo).upper(),
                        "tipo_descuento": tipo,
                        "valor_descuento": float(valor),
                        "aplica_en": aplica_en,
                        "solo_clientes_nuevos": bool(solo_clientes_nuevos),
                    },
                    "subtotal": float(subtotal),
                    "descuento": float(descuento),
                    "total": float(total),
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo validar la promoción."}, status=500)
