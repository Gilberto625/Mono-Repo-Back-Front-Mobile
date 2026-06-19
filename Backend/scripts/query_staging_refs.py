import os
import sys
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from django.db import connection

QUERIES = [
    ("ROLES", "SELECT rol_id, codigo FROM negocio.rol ORDER BY rol_id"),
    ("EMPRESAS", "SELECT empresa_id, nombre FROM negocio.empresa LIMIT 3"),
    ("SILLAS", "SELECT silla_id, numero, activa FROM negocio.silla WHERE activa=TRUE LIMIT 5"),
    (
        "BARBEROS",
        """
        SELECT e.empleado_id, u.username, e.activo
        FROM negocio.empleado e
        JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
        JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
        JOIN negocio.rol r ON r.rol_id = ur.rol_id
        WHERE LOWER(r.codigo) IN ('barbero') AND e.activo=TRUE
        LIMIT 5
        """,
    ),
    ("CAT_SRV", "SELECT categoria_servicio_id, codigo FROM negocio.categoria_servicio LIMIT 3"),
    ("CAT_PROD", "SELECT categoria_producto_id, codigo FROM negocio.categoria_producto LIMIT 3"),
    ("MARCAS", "SELECT marca_id, nombre FROM negocio.marca LIMIT 3"),
]

with connection.cursor() as c:
    for label, sql in QUERIES:
        c.execute(sql)
        print(f"{label}:", c.fetchall())
