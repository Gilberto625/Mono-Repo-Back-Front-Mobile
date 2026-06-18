import json
import re
from datetime import date

from django.db import connection
from django.http import JsonResponse


class PostgresSearchPathMiddleware:
    """
    Asegura search_path=private,public al inicio de cada petición HTTP.

    Las tablas de Django (auth_*, django_*) pueden vivir en el esquema private
    (ver sql/mover_tablas_django_a_private.sql). Con poolers en modo transacción
    (p. ej. Neon o PgBouncer), el SET hecho solo en connection_created no persiste
    entre transacciones en el servidor, y aparece ProgrammingError: relation
    "auth_user" does not exist aunque la tabla exista en private.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if connection.vendor == "postgresql":
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET search_path TO private, public")
            except Exception:
                pass
        return self.get_response(request)


class EmpleadoRolValidationMiddleware:
    """
    Valida payloads de /api/admin/empleados para mantener consistencia de negocio.
    No modifica estructura de BD; solo bloquea requests inválidos.
    """

    ALLOWED_ROLES = {"admin", "secretaria", "barbero"}
    # Patrón de email con límites de longitud y clases de caracteres simples (sin backtracking costoso).
    EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}$")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if (
            request.path.startswith("/api/admin/empleados/")
            and request.method in {"POST", "PUT", "PATCH"}
        ):
            payload = self._extract_payload(request)
            if payload is not None:
                error = self._validate_payload(payload, request.method)
                if error is not None:
                    return JsonResponse({"ok": False, "error": error}, status=400)

        return self.get_response(request)

    def _extract_payload(self, request):
        # FormData / x-www-form-urlencoded
        if request.POST:
            return {k: request.POST.get(k) for k in request.POST.keys()}

        # JSON body (común en Angular HttpClient)
        content_type = request.META.get("CONTENT_TYPE", "")
        if "application/json" in content_type:
            try:
                raw = request.body.decode("utf-8") if request.body else ""
                if not raw:
                    return {}
                data = json.loads(raw)
                return data if isinstance(data, dict) else {}
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                return {}

        return {}

    def _validate_payload(self, payload: dict, method: str):
        required_post = {"nombre", "apellido", "email", "password", "telefono", "rol"}
        if method == "POST":
            faltantes = [k for k in required_post if not str(payload.get(k, "")).strip()]
            if faltantes:
                return (
                    "Faltan campos obligatorios para crear empleado: "
                    + ", ".join(sorted(faltantes))
                    + "."
                )

        rol = str(payload.get("rol", "")).strip()
        if rol and rol not in self.ALLOWED_ROLES:
            return "Rol invalido para Empleados. Solo se permiten: admin, secretaria, barbero."

        nombre = str(payload.get("nombre", "")).strip() if "nombre" in payload else ""
        if "nombre" in payload and len(nombre) < 2:
            return "El nombre debe tener al menos 2 caracteres."

        apellido = str(payload.get("apellido", "")).strip() if "apellido" in payload else ""
        if "apellido" in payload and len(apellido) < 2:
            return "El apellido debe tener al menos 2 caracteres."

        email = str(payload.get("email", "")).strip().lower() if "email" in payload else ""
        if "email" in payload and not self.EMAIL_REGEX.match(email):
            return "Correo electrónico inválido."

        password = str(payload.get("password", "")) if "password" in payload else ""
        if "password" in payload and password and len(password) < 8:
            return "La contraseña debe tener al menos 8 caracteres."

        telefono = str(payload.get("telefono", "")) if "telefono" in payload else ""
        if "telefono" in payload:
            digitos = re.sub(r"\D+", "", telefono)
            if len(digitos) < 10 or len(digitos) > 15:
                return "El teléfono debe contener entre 10 y 15 dígitos."

        fecha_nacimiento = str(payload.get("fecha_nacimiento", "")).strip()
        if fecha_nacimiento:
            try:
                nacimiento = date.fromisoformat(fecha_nacimiento)
            except ValueError:
                return "La fecha de nacimiento es inválida. Usa formato YYYY-MM-DD."

            hoy = date.today()
            if nacimiento > hoy:
                return "La fecha de nacimiento no puede ser futura."

            edad = hoy.year - nacimiento.year - (
                (hoy.month, hoy.day) < (nacimiento.month, nacimiento.day)
            )
            if edad < 16:
                return "El empleado debe tener al menos 16 años."

        if "bio" in payload and len(str(payload.get("bio", "")).strip()) > 500:
            return "La biografía no debe exceder 500 caracteres."

        if rol == "barbero" and method in {"POST", "PUT"}:
            especialidades = payload.get("especialidades", "")
            if self._especialidades_vacias(especialidades):
                return "Para barbero, debes enviar al menos una especialidad."

        return None

    def _especialidades_vacias(self, value) -> bool:
        if value is None:
            return True
        if isinstance(value, list):
            return len(value) == 0
        if isinstance(value, str):
            s = value.strip()
            if s in {"", "[]"}:
                return True
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return len(parsed) == 0
            except (TypeError, ValueError, json.JSONDecodeError):
                # Si no es JSON, al menos verificar que no esté vacío.
                return s == ""
        return False
