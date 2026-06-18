"""
Horario de negocio: America/Mexico_City (Centro de México, sin horario de verano desde 2022).

Todas las citas se guardan como timestamptz (UTC en BD) a partir de fecha+hora local MX.
Las consultas SQL deben convertir con AT TIME ZONE 'America/Mexico_City'.
"""
from __future__ import annotations

from datetime import date, datetime, time

from django.utils import timezone

MX_TZ_NAME = "America/Mexico_City"
MX_TZ_MARKER = "[TZ_MX_CORREGIDO]"

# Fragmentos SQL reutilizables (tabla alias c = negocio.cita)
SQL_CITA_FECHA_LOCAL = "(c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date"
SQL_CITA_HORA_LOCAL = "(c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time"
SQL_CITA_FECHA_LOCAL_CHAR = (
    "TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD')"
)
SQL_CITA_HORA_LOCAL_CHAR = (
    "TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI')"
)
SQL_CITA_DIA_MX = "DATE(c.fecha_hora AT TIME ZONE 'America/Mexico_City')"

MESES_ES = (
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
)


def combine_fecha_hora_mx(fecha_obj: date, hora_obj: time) -> datetime:
    """Combina fecha y hora interpretándolas como horario local de México."""
    dt = datetime.combine(fecha_obj, hora_obj)
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def combine_fecha_hora_str_mx(fecha_str: str, hora_str: str) -> datetime:
    fecha_obj = date.fromisoformat(str(fecha_str).strip()[:10])
    hora_obj = datetime.strptime(str(hora_str).strip()[:5], "%H:%M").time()
    return combine_fecha_hora_mx(fecha_obj, hora_obj)


def fecha_humana_es(fecha_obj: date) -> str:
    return f"{fecha_obj.day} de {MESES_ES[fecha_obj.month - 1]} de {fecha_obj.year}"


def minutos_desde_hora(t) -> int:
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


def sql_citas_ocupadas_dia() -> str:
    """Citas activas de un barbero en un día (hora local MX + duración)."""
    return f"""
        SELECT
            {SQL_CITA_HORA_LOCAL} AS hora_local,
            COALESCE(c.duracion_min, 0)
        FROM negocio.cita c
        LEFT JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
        WHERE c.empleado_id = %s
          AND {SQL_CITA_DIA_MX} = %s
          AND LOWER(COALESCE(ec.codigo, '')) <> 'cancelada'
    """
