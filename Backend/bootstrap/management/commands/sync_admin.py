from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from decouple import config


class Command(BaseCommand):
    help = "Crea o actualiza el usuario administrador desde variables ADMIN_* del .env y sincroniza nombre/apellido en negocio.perfil_persona"

    def handle(self, *args, **options):
        username = config("ADMIN_USERNAME", default="").strip()
        email = config("ADMIN_EMAIL", default="").strip()
        password = config("ADMIN_PASSWORD", default="").strip()
        first_name = config("ADMIN_NOMBRE", default="").strip()
        last_name = config("ADMIN_APELLIDO", default="").strip()

        if not username or not email or not password:
            raise CommandError(
                "Faltan ADMIN_USERNAME, ADMIN_EMAIL o ADMIN_PASSWORD en el .env"
            )

        user_model = get_user_model()
        user, created = user_model.objects.get_or_create(
            username=username,
            defaults={
                "email": email,
                "is_staff": True,
                "is_superuser": True,
            },
        )

        if not created:
            user.email = email

        if hasattr(user, "first_name"):
            user.first_name = first_name
        if hasattr(user, "last_name"):
            user.last_name = last_name

        user.is_staff = True
        user.is_superuser = True
        user.set_password(password)
        user.save()

        # Sincronizar nombre y apellido en negocio.usuario / negocio.perfil_persona para que aparezcan en perfil y API
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT usuario_id
                        FROM negocio.usuario
                        WHERE LOWER(username) = LOWER(%s) OR LOWER(email) = LOWER(%s)
                        ORDER BY usuario_id DESC
                        LIMIT 1
                        """,
                        [username, email],
                    )
                    row = cursor.fetchone()
                    if row:
                        usuario_id = int(row[0])
                        cursor.execute(
                            """
                            INSERT INTO negocio.perfil_persona (usuario_id, nombres, apellido_paterno)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (usuario_id) DO UPDATE SET
                                nombres = EXCLUDED.nombres,
                                apellido_paterno = EXCLUDED.apellido_paterno
                            """,
                            [usuario_id, first_name or None, last_name or None],
                        )
                        self.stdout.write(
                            self.style.SUCCESS(
                                f"Perfil negocio actualizado: nombre y apellido para usuario_id={usuario_id}"
                            )
                        )
                    else:
                        # Crear negocio.usuario y perfil_persona para que /api/perfil/ y el front muestren nombre/apellido
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
                        cursor.execute(
                            "SELECT rol_id FROM negocio.rol WHERE LOWER(COALESCE(codigo, '')) IN ('administrador', 'admin') ORDER BY rol_id LIMIT 1",
                            [],
                        )
                        rol_row = cursor.fetchone()
                        if rol_row:
                            cursor.execute(
                                """
                                INSERT INTO negocio.usuario_rol (usuario_id, rol_id)
                                VALUES (%s, %s)
                                ON CONFLICT (usuario_id, rol_id) DO NOTHING
                                """,
                                [usuario_id, int(rol_row[0])],
                            )
                        cursor.execute(
                            """
                            INSERT INTO negocio.perfil_persona (usuario_id, nombres, apellido_paterno)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (usuario_id) DO UPDATE SET
                                nombres = EXCLUDED.nombres,
                                apellido_paterno = EXCLUDED.apellido_paterno
                            """,
                            [usuario_id, first_name or None, last_name or None],
                        )
                        self.stdout.write(
                            self.style.SUCCESS(
                                f"Usuario negocio creado: usuario_id={usuario_id} con nombre y apellido"
                            )
                        )
        except Exception as e:
            self.stdout.write(
                self.style.WARNING(
                    f"No se pudo sincronizar con negocio.usuario/perfil_persona: {e}. "
                    "El login Django seguirá funcionando; nombre/apellido pueden no verse en el perfil hasta que exista el usuario en negocio."
                )
            )

        status = "creado" if created else "actualizado"
        self.stdout.write(
            self.style.SUCCESS(
                f"Administrador {status}: {username} ({email})"
            )
        )
