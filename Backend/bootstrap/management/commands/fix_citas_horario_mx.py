"""
Corrige citas guardadas con hora local MX interpretada erróneamente como UTC.

Antes del fix, un INSERT con datetime naive (ej. 12:00) quedaba como 12:00+00 UTC
en lugar de 18:00+00 UTC (12:00 en Ciudad de México). Eso hacía que la
disponibilidad no bloqueara el horario correcto.

Uso:
  python manage.py fix_citas_horario_mx --dry-run
  python manage.py fix_citas_horario_mx --apply
  python manage.py fix_citas_horario_mx --apply --all
"""
from django.core.management.base import BaseCommand
from django.db import connection

from core.timezone_mx import MX_TZ_MARKER


class Command(BaseCommand):
    help = "Reinterpreta fecha_hora de citas legacy como horario local de México."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Solo muestra cuántas filas se corregirían (predeterminado).",
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Aplica la corrección en la base de datos.",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="Corrige todas las citas sin marcador (incluye casos ambiguos). Usar con respaldo.",
        )

    def handle(self, *args, **options):
        apply = bool(options.get("apply"))
        fix_all = bool(options.get("all"))
        dry_run = not apply or bool(options.get("dry_run"))

        if apply and options.get("dry_run"):
            dry_run = True

        where_legacy = """
            NOT COALESCE(c.notas, '') LIKE %s
            AND (
                (
                    EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'America/Mexico_City')) < 9
                    AND EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'UTC')) >= 9
                )
                OR (
                    EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'America/Mexico_City')) >= 20
                    AND EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'UTC')) BETWEEN 9 AND 19
                )
                OR (
                    EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'UTC')) BETWEEN 9 AND 19
                    AND MOD(
                        (
                            EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'UTC'))::int * 60
                            + EXTRACT(MINUTE FROM (c.fecha_hora AT TIME ZONE 'UTC'))::int
                        ),
                        20
                    ) = 0
                    AND EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'America/Mexico_City')) * 60
                        + EXTRACT(MINUTE FROM (c.fecha_hora AT TIME ZONE 'America/Mexico_City'))::int
                        <> EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'UTC'))::int * 60
                        + EXTRACT(MINUTE FROM (c.fecha_hora AT TIME ZONE 'UTC'))::int
                    AND EXTRACT(HOUR FROM (c.fecha_hora AT TIME ZONE 'America/Mexico_City')) < 12
                )
            )
        """
        where_all = f"NOT COALESCE(c.notas, '') LIKE %s"
        where_clause = where_all if fix_all else where_legacy
        marker_like = f"%{MX_TZ_MARKER}%"

        select_sql = f"""
            SELECT
                c.cita_id,
                TO_CHAR(c.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS utc_antes,
                TO_CHAR(c.fecha_hora AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS mx_antes,
                TO_CHAR(
                    (
                        (c.fecha_hora AT TIME ZONE 'UTC')::timestamp
                        AT TIME ZONE 'America/Mexico_City'
                    ) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD HH24:MI'
                ) AS utc_despues,
                TO_CHAR(
                    (c.fecha_hora AT TIME ZONE 'UTC')::timestamp
                    AT TIME ZONE 'America/Mexico_City',
                    'YYYY-MM-DD HH24:MI'
                ) AS mx_despues
            FROM negocio.cita c
            WHERE {where_clause}
            ORDER BY c.cita_id
        """

        update_sql = f"""
            UPDATE negocio.cita c
            SET fecha_hora = (
                    (c.fecha_hora AT TIME ZONE 'UTC')::timestamp
                    AT TIME ZONE 'America/Mexico_City'
                ),
                notas = CASE
                    WHEN COALESCE(c.notas, '') LIKE %s THEN c.notas
                    WHEN COALESCE(c.notas, '') = '' THEN %s
                    ELSE c.notas || E'\\n' || %s
                END
            WHERE {where_clause}
        """

        with connection.cursor() as cursor:
            cursor.execute(select_sql, [marker_like])
            rows = cursor.fetchall()

        if not rows:
            self.stdout.write(self.style.SUCCESS("No hay citas pendientes de corregir."))
            return

        self.stdout.write(f"Citas a corregir: {len(rows)}")
        for row in rows[:15]:
            self.stdout.write(
                f"  cita_id={row[0]} UTC {row[1]} / MX {row[2]}  →  UTC {row[3]} / MX {row[4]}"
            )
        if len(rows) > 15:
            self.stdout.write(f"  ... y {len(rows) - 15} más")

        if dry_run:
            self.stdout.write(
                self.style.WARNING(
                    "Modo simulación. Ejecuta con --apply para guardar cambios."
                )
            )
            return

        with connection.cursor() as cursor:
            cursor.execute(
                update_sql,
                [marker_like, marker_like, MX_TZ_MARKER, MX_TZ_MARKER, marker_like],
            )
            updated = cursor.rowcount

        self.stdout.write(self.style.SUCCESS(f"Corregidas {updated} citas."))
