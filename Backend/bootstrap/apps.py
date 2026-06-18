from django.apps import AppConfig
from django.db.backends.signals import connection_created


class BootstrapConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'bootstrap'

    def ready(self) -> None:
        # Fuerza el schema por defecto de PostgreSQL a "private" para que Django
        # cree/use sus tablas (auth_*, django_*) en ese esquema.
        #
        # Con pooler en modo transacción, el servidor puede rotar la sesión de backend
        # entre transacciones; el SET aquí no basta. core.middleware.PostgresSearchPathMiddleware
        # repite el SET al inicio de cada petición HTTP (ver sql/mover_tablas_django_a_private.sql).
        #
        # Este hook sigue siendo útil en la primera conexión y en comandos de gestión.
        def _set_search_path(sender, connection, **kwargs):  # type: ignore[no-untyped-def]
            try:
                if getattr(connection, "vendor", "") != "postgresql":
                    return
                with connection.cursor() as cursor:
                    cursor.execute("SET search_path TO private, public;")
            except Exception:
                # Si falla, no rompemos el arranque; el comportamiento vuelve a public.
                return

        connection_created.connect(_set_search_path, dispatch_uid="bootstrap.set_search_path_private")
