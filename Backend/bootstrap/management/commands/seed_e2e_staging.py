"""
Seed mínimo idempotente para E2E en Neon staging.
Prefijos: e2e_*_stylo, E2E_TEST.
No borra datos existentes. Solo INSERT/UPDATE controlados.

Uso:
  USE_LOCAL_DB=False python manage.py seed_e2e_staging
  USE_LOCAL_DB=False python manage.py seed_e2e_staging --dry-run
"""
from decouple import config
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand
from django.db import connection, transaction

E2E_PASSWORD = config(
    "E2E_STAGING_PASSWORD",
    default="E2E_TEST_Stylo2026!",
)
USERS = {
    "e2e_admin_stylo": {
        "email": "e2e_admin_stylo@test.stylo.local",
        "rol": "administrador",
        "is_staff": True,
        "is_superuser": True,
        "verificacion_2fa": False,
        "empleado": False,
    },
    "e2e_cliente_stylo": {
        "email": "e2e_cliente_stylo@test.stylo.local",
        "rol": "cliente",
        "is_staff": False,
        "is_superuser": False,
        "verificacion_2fa": False,
        "empleado": False,
    },
    "e2e_barbero_stylo": {
        "email": "e2e_barbero_stylo@test.stylo.local",
        "rol": "barbero",
        "is_staff": False,
        "is_superuser": False,
        "verificacion_2fa": False,
        "empleado": True,
    },
}
SERVICIO_NOMBRE = "E2E_TEST Corte Básico"
PRODUCTO_NOMBRE = "E2E_TEST Pomada"
MARCA_NOMBRE = "E2E_TEST Marca"


class Command(BaseCommand):
    help = "Crea o actualiza datos E2E mínimos en Neon staging (idempotente)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Solo reporta qué haría, sin escribir en BD.",
        )

    def handle(self, *args, **options):
        dry_run = bool(options.get("dry_run"))
        if dry_run:
            self.stdout.write(self.style.WARNING("Modo dry-run: sin escrituras."))

        results: dict[str, str] = {}
        with transaction.atomic():
            for username, meta in USERS.items():
                results[f"user_{username}"] = self._ensure_user(username, meta, dry_run)

            servicio_id = self._ensure_servicio(dry_run)
            results["servicio_id"] = str(servicio_id or "skip")

            producto_id = self._ensure_producto(dry_run)
            results["producto_id"] = str(producto_id or "skip")

            barbero_empleado_id = self._get_empleado_id_by_username("e2e_barbero_stylo")
            if servicio_id and barbero_empleado_id:
                results["barbero_servicio"] = self._link_barbero_servicio(
                    barbero_empleado_id, servicio_id, dry_run
                )
                results["barbero_horario"] = self._ensure_barbero_horario(
                    barbero_empleado_id, dry_run
                )

        for key, value in results.items():
            self.stdout.write(f"{key}={value}")
        self.stdout.write(self.style.SUCCESS("Seed E2E staging completado."))

    def _get_rol_id(self, cursor, codigo: str) -> int | None:
        cursor.execute(
            "SELECT rol_id FROM negocio.rol WHERE LOWER(codigo) = LOWER(%s) LIMIT 1",
            [codigo],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _get_negocio_user_id(self, cursor, username: str) -> int | None:
        cursor.execute(
            "SELECT usuario_id FROM negocio.usuario WHERE LOWER(username) = LOWER(%s) LIMIT 1",
            [username],
        )
        row = cursor.fetchone()
        return int(row[0]) if row else None

    def _get_empleado_id_by_username(self, username: str) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT e.empleado_id
                FROM negocio.empleado e
                JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                WHERE LOWER(u.username) = LOWER(%s)
                LIMIT 1
                """,
                [username],
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _ensure_user(self, username: str, meta: dict, dry_run: bool) -> str:
        user_model = get_user_model()
        email = meta["email"]

        if dry_run:
            exists = user_model.objects.filter(username=username).exists()
            return "would_create" if not exists else "exists"

        user, created = user_model.objects.get_or_create(
            username=username,
            defaults={"email": email},
        )
        user.email = email
        user.is_staff = meta["is_staff"]
        user.is_superuser = meta["is_superuser"]
        user.is_active = True
        user.set_password(E2E_PASSWORD)
        user.save()

        with connection.cursor() as cursor:
            negocio_id = self._get_negocio_user_id(cursor, username)
            if not negocio_id:
                cursor.execute(
                    """
                    INSERT INTO negocio.usuario (
                        email, username, password_hash, activo, verificado,
                        verificacion_2fa, proveedor_auth
                    )
                    VALUES (%s, %s, %s, TRUE, TRUE, %s, 'local')
                    RETURNING usuario_id
                    """,
                    [email, username, make_password(E2E_PASSWORD), meta["verificacion_2fa"]],
                )
                negocio_id = int(cursor.fetchone()[0])
                action = "created"
            else:
                cursor.execute(
                    """
                    UPDATE negocio.usuario
                    SET email = %s,
                        password_hash = %s,
                        activo = TRUE,
                        verificado = TRUE,
                        verificacion_2fa = %s,
                        proveedor_auth = 'local'
                    WHERE usuario_id = %s
                    """,
                    [email, make_password(E2E_PASSWORD), meta["verificacion_2fa"], negocio_id],
                )
                action = "updated"

            rol_id = self._get_rol_id(cursor, meta["rol"])
            if rol_id:
                cursor.execute(
                    """
                    INSERT INTO negocio.usuario_rol (usuario_id, rol_id)
                    VALUES (%s, %s)
                    ON CONFLICT (usuario_id, rol_id) DO NOTHING
                    """,
                    [negocio_id, rol_id],
                )

            cursor.execute(
                """
                INSERT INTO negocio.perfil_persona (usuario_id, nombres, apellido_paterno)
                VALUES (%s, %s, %s)
                ON CONFLICT (usuario_id) DO UPDATE SET
                    nombres = EXCLUDED.nombres,
                    apellido_paterno = EXCLUDED.apellido_paterno
                """,
                [negocio_id, username.replace("_", " ").title(), "E2E"],
            )

            if meta["empleado"]:
                cursor.execute(
                    """
                    SELECT empleado_id FROM negocio.empleado WHERE usuario_id = %s LIMIT 1
                    """,
                    [negocio_id],
                )
                emp_row = cursor.fetchone()
                if not emp_row:
                    cursor.execute("SELECT silla_id FROM negocio.silla WHERE activa = TRUE ORDER BY silla_id LIMIT 1")
                    silla_row = cursor.fetchone()
                    silla_id = int(silla_row[0]) if silla_row else None
                    cursor.execute(
                        """
                        INSERT INTO negocio.empleado (usuario_id, empresa_id, silla_id, activo, fecha_ingreso)
                        VALUES (%s, 1, %s, TRUE, CURRENT_DATE)
                        RETURNING empleado_id
                        """,
                        [negocio_id, silla_id],
                    )
                    action += "+empleado"

        django_action = "created" if created else "updated"
        return f"{django_action}/{action}"

    def _ensure_servicio(self, dry_run: bool) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT servicio_id FROM negocio.servicio WHERE nombre = %s LIMIT 1",
                [SERVICIO_NOMBRE],
            )
            row = cursor.fetchone()
            if row:
                return int(row[0])

            if dry_run:
                return None

            cursor.execute(
                "SELECT categoria_servicio_id FROM negocio.categoria_servicio ORDER BY categoria_servicio_id LIMIT 1"
            )
            cat_row = cursor.fetchone()
            if not cat_row:
                self.stdout.write(self.style.ERROR("Sin categoría de servicio en BD."))
                return None
            cat_id = int(cat_row[0])

            cursor.execute(
                """
                INSERT INTO negocio.servicio (
                    categoria_servicio_id, nombre, descripcion, precio_base,
                    duracion_base_min, activo, popular
                )
                VALUES (%s, %s, %s, %s, %s, TRUE, FALSE)
                RETURNING servicio_id
                """,
                [cat_id, SERVICIO_NOMBRE, "Servicio de prueba E2E staging.", 150.0, 30],
            )
            return int(cursor.fetchone()[0])

    def _ensure_producto(self, dry_run: bool) -> int | None:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT producto_id FROM negocio.producto WHERE nombre = %s LIMIT 1",
                [PRODUCTO_NOMBRE],
            )
            row = cursor.fetchone()
            if row:
                producto_id = int(row[0])
                if not dry_run:
                    cursor.execute(
                        """
                        INSERT INTO negocio.inventario_existencia (producto_id, stock_actual, ultima_entrada)
                        VALUES (%s, %s, NOW())
                        ON CONFLICT (producto_id)
                        DO UPDATE SET stock_actual = GREATEST(negocio.inventario_existencia.stock_actual, 10)
                        """,
                        [producto_id, 10],
                    )
                return producto_id

            if dry_run:
                return None

            cursor.execute(
                """
                INSERT INTO negocio.marca (nombre, activa)
                VALUES (%s, TRUE)
                ON CONFLICT DO NOTHING
                RETURNING marca_id
                """,
                [MARCA_NOMBRE],
            )
            marca_row = cursor.fetchone()
            if marca_row:
                marca_id = int(marca_row[0])
            else:
                cursor.execute(
                    "SELECT marca_id FROM negocio.marca WHERE nombre = %s LIMIT 1",
                    [MARCA_NOMBRE],
                )
                marca_id = int(cursor.fetchone()[0])

            cursor.execute(
                "SELECT categoria_producto_id FROM negocio.categoria_producto ORDER BY categoria_producto_id LIMIT 1"
            )
            cat_id = int(cursor.fetchone()[0])

            cursor.execute(
                """
                INSERT INTO negocio.producto (
                    marca_id, categoria_producto_id, nombre, descripcion, precio_venta,
                    peso_volumen, stock_minimo_alerta, destacado, estado, disponible_venta
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE, 'activo', TRUE)
                RETURNING producto_id
                """,
                [marca_id, cat_id, PRODUCTO_NOMBRE, "Producto de prueba E2E staging.", 99.0, "100g", 2],
            )
            producto_id = int(cursor.fetchone()[0])
            cursor.execute(
                """
                INSERT INTO negocio.inventario_existencia (producto_id, stock_actual, ultima_entrada)
                VALUES (%s, %s, NOW())
                ON CONFLICT (producto_id) DO UPDATE SET stock_actual = EXCLUDED.stock_actual
                """,
                [producto_id, 10],
            )
            return producto_id

    def _link_barbero_servicio(self, empleado_id: int, servicio_id: int, dry_run: bool) -> str:
        if dry_run:
            return "would_link"
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO negocio.barbero_servicio (empleado_id, servicio_id)
                VALUES (%s, %s)
                ON CONFLICT (empleado_id, servicio_id) DO NOTHING
                """,
                [empleado_id, servicio_id],
            )
        return "linked"

    def _ensure_barbero_horario(self, empleado_id: int, dry_run: bool) -> str:
        if dry_run:
            return "would_set_horario"
        with connection.cursor() as cursor:
            for dia in range(7):
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
                    [empleado_id, dia, dia < 6, "09:00", "20:00"],
                )
        return "horario_ok"
