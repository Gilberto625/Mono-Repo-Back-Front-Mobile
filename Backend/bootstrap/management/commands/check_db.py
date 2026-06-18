"""
Verifica que el backend esté usando la BD del .env y que exista el usuario admin.
Útil cuando el login dice "Credenciales incorrectas" y quieres confirmar conexión y usuario.
"""
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = "Verifica conexión a la BD y si existe el usuario admin (para login)"

    def handle(self, *args, **options):
        db = settings.DATABASES.get("default", {})
        engine = db.get("ENGINE", "")
        name = db.get("NAME", "")
        host = db.get("HOST", "")

        self.stdout.write(f"Motor: {engine}")
        self.stdout.write(f"Base de datos: {name}")
        if host:
            self.stdout.write(f"Host: {host}")
        self.stdout.write("")

        try:
            with connection.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            self.stdout.write(self.style.SUCCESS("Conexión a la BD: OK"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Conexión a la BD: FALLO - {e}"))
            return

        User = get_user_model()
        total = User.objects.count()
        self.stdout.write(f"Usuarios en auth_user: {total}")

        from decouple import config
        admin_username = config("ADMIN_USERNAME", default="").strip()
        if admin_username:
            admin_user = User.objects.filter(username=admin_username).first()
            if admin_user:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Usuario admin '{admin_username}' existe (id={admin_user.pk}). "
                        "Si el login falla, ejecuta: python manage.py sync_admin"
                    )
                )
            else:
                self.stdout.write(
                    self.style.WARNING(
                        f"Usuario admin '{admin_username}' NO existe. "
                        "Ejecuta: python manage.py sync_admin"
                    )
                )
        self.stdout.write("")
