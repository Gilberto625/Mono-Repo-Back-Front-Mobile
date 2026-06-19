"""
Diagnóstico read-only de esquema negocio en Neon staging.
No imprime DATABASE_URL ni secretos. Solo stdout seguro.
Ejecutar: USE_LOCAL_DB=False python manage.py shell < scripts/diagnose_neon_staging.py
O: cd Backend && python scripts/diagnose_neon_staging.py (con DJANGO_SETTINGS_MODULE)
"""
import os
import sys

import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.conf import settings
from django.db import connection, DatabaseError

TABLES = [
    "negocio.usuario",
    "negocio.rol",
    "negocio.usuario_rol",
    "negocio.servicio",
    "negocio.empleado",
    "negocio.cita",
    "negocio.producto",
    "negocio.inventario_existencia",
    "negocio.codigo_verificacion",
    "negocio.categoria_servicio",
    "negocio.categoria_producto",
    "negocio.marca",
    "negocio.servicio_imagen",
    "negocio.producto_imagen",
    "negocio.silla",
]

QUERIES = {
    "servicios_activos": "SELECT COUNT(*) FROM negocio.servicio WHERE activo = TRUE",
    "empleados_activos": "SELECT COUNT(*) FROM negocio.empleado WHERE activo = TRUE",
    "productos_activos": (
        "SELECT COUNT(*) FROM negocio.producto "
        "WHERE estado = 'activo' AND disponible_venta = TRUE"
    ),
    "e2e_usuarios": (
        "SELECT COUNT(*) FROM negocio.usuario "
        "WHERE username ILIKE 'e2e_%' OR username ILIKE '%e2e_test%' "
        "OR username ILIKE '%staging_test%'"
    ),
    "e2e_servicios": (
        "SELECT COUNT(*) FROM negocio.servicio WHERE nombre ILIKE 'E2E_TEST%'"
    ),
    "e2e_productos": (
        "SELECT COUNT(*) FROM negocio.producto WHERE nombre ILIKE 'E2E_TEST%'"
    ),
}


def table_exists(cursor, schema: str, table: str) -> bool:
    cursor.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
        )
        """,
        [schema, table],
    )
    return bool(cursor.fetchone()[0])


def main():
    use_local = getattr(settings, "USE_LOCAL_DB", None)
    engine = settings.DATABASES["default"]["ENGINE"]
    print(f"USE_LOCAL_DB={use_local}")
    print(f"ENGINE={engine.split('.')[-1]}")

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'negocio')"
            )
            schema_ok = bool(cursor.fetchone()[0])
            print(f"SCHEMA_negocio={'OK' if schema_ok else 'MISSING'}")

            for full_name in TABLES:
                schema, table = full_name.split(".", 1)
                exists = table_exists(cursor, schema, table)
                status = "OK" if exists else "MISSING"
                print(f"TABLE_{table}={status}")

            for label, sql in QUERIES.items():
                try:
                    cursor.execute(sql)
                    count = cursor.fetchone()[0]
                    print(f"COUNT_{label}={count}")
                except DatabaseError as exc:
                    print(f"COUNT_{label}=ERROR:{type(exc).__name__}")

            for uname in ("e2e_cliente_stylo", "e2e_admin_stylo", "e2e_barbero_stylo"):
                try:
                    cursor.execute(
                        """
                        SELECT u.usuario_id, COALESCE(r.codigo, 'sin_rol')
                        FROM negocio.usuario u
                        LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                        LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                        WHERE LOWER(u.username) = LOWER(%s)
                        LIMIT 1
                        """,
                        [uname],
                    )
                    row = cursor.fetchone()
                    if row:
                        print(f"USER_{uname}=EXISTS rol={row[1]}")
                    else:
                        print(f"USER_{uname}=MISSING")
                except DatabaseError as exc:
                    print(f"USER_{uname}=ERROR:{type(exc).__name__}")

    except DatabaseError as exc:
        print(f"CONNECTION_ERROR={type(exc).__name__}")


if __name__ == "__main__":
    main()
