"""Permisos RBAC mínimos para el backend monolítico de Stylo Barber Connect.

La resolución usa el rol oficial en ``negocio.usuario_rol`` y conserva los
flags de Django únicamente como respaldo para administradores.
"""

from django.db import DatabaseError, connection
from rest_framework.permissions import BasePermission


ROLE_PRIORITY = ("administrador", "admin", "secretaria", "barbero", "cliente")


def get_business_role(user) -> str:
    if not user or not getattr(user, "is_authenticated", False):
        return ""

    username = str(getattr(user, "username", "") or "").strip()
    email = str(getattr(user, "email", "") or "").strip()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT LOWER(COALESCE(r.codigo, ''))
                FROM negocio.usuario u
                JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE (LOWER(u.username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(u.email) = LOWER(%s) AND %s <> '')
                ORDER BY CASE LOWER(COALESCE(r.codigo, ''))
                    WHEN 'administrador' THEN 1
                    WHEN 'admin' THEN 1
                    WHEN 'secretaria' THEN 2
                    WHEN 'barbero' THEN 3
                    WHEN 'cliente' THEN 4
                    ELSE 99
                END
                LIMIT 1
                """,
                [username, username, email, email],
            )
            row = cursor.fetchone()
        if row and row[0]:
            return str(row[0]).strip().lower()
    except DatabaseError:
        # Los flags Django solo elevan a administrador; nunca inventan otros roles.
        pass

    if getattr(user, "is_superuser", False) or getattr(user, "is_staff", False):
        return "admin"
    return ""


class HasBusinessRole(BasePermission):
    allowed_roles: frozenset[str] = frozenset()

    def has_permission(self, request, view) -> bool:
        role = get_business_role(getattr(request, "user", None))
        return role in self.allowed_roles


class IsAdminRole(HasBusinessRole):
    allowed_roles = frozenset({"administrador", "admin"})


class IsAdminOrSecretary(HasBusinessRole):
    allowed_roles = frozenset({"administrador", "admin", "secretaria"})


class IsAdminOrBarber(HasBusinessRole):
    allowed_roles = frozenset({"administrador", "admin", "barbero"})


class IsClientRole(HasBusinessRole):
    allowed_roles = frozenset({"cliente"})

