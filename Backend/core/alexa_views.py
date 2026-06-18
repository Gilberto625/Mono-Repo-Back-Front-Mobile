"""
Endpoints de fachada para la Alexa Skill de Stylo Barber Connect.

No modifican el contrato de los endpoints usados por Angular (/api/citas/, etc.).
La Skill consume estas rutas bajo /api/alexa/*.
"""
from __future__ import annotations

import json
import logging
import random
import re
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import DatabaseError, connection, transaction
from django.utils import timezone
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from core.timezone_mx import combine_fecha_hora_mx, fecha_humana_es, sql_citas_ocupadas_dia

logger = logging.getLogger(__name__)

User = get_user_model()

SLOT_MINUTES = 20
CATEGORIAS_PRINCIPAL = {"corte", "barba", "paquete"}
CATEGORIAS_EXTRA = {"tratamiento"}
ROLE_MAP_DB_TO_FRONT = {
    "administrador": "admin",
    "admin": "admin",
    "barbero": "barbero",
    "secretaria": "secretaria",
    "cliente": "cliente",
}
ROLES_BLOQUEADOS_ALEXA = {"admin", "administrador", "secretaria", "barbero"}


class AlexaBaseMixin:
    """Utilidades compartidas para endpoints Alexa."""

    def _to_money(self, value) -> Decimal:
        try:
            return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError, TypeError):
            return Decimal("0.00")

    def _to_minutes(self, t) -> int:
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

    def _fmt_minutes(self, mins: int) -> str:
        h = max(0, mins // 60)
        m = max(0, mins % 60)
        return f"{h:02d}:{m:02d}"

    def _fecha_hora_mexico(self, fecha_obj: date, hora_obj) -> datetime:
        return combine_fecha_hora_mx(fecha_obj, hora_obj)

    def _fecha_humana_es(self, fecha_obj: date) -> str:
        return fecha_humana_es(fecha_obj)

    def _overlap(self, a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
        return a_start < b_end and b_start < a_end

    def _alexa_codigo_exp_minutes(self) -> int:
        return int(getattr(settings, "ALEXA_CODIGO_EXP_MINUTES", 5) or 5)

    def _alexa_max_dias(self) -> int:
        return int(getattr(settings, "ALEXA_MAX_DIAS_ANTELACION", 30) or 30)

    def _resolver_usuario_negocio_id(self, request) -> int | None:
        username = str(getattr(request.user, "username", "") or "").strip()
        email = str(getattr(request.user, "email", "") or "").strip()
        user_pk = int(getattr(request.user, "id", 0) or 0)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT usuario_id
                FROM negocio.usuario
                WHERE (LOWER(username) = LOWER(%s) AND %s <> '')
                   OR (LOWER(email) = LOWER(%s) AND %s <> '')
                   OR (usuario_id = %s AND %s > 0)
                ORDER BY
                    CASE
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '')
                         AND (LOWER(email) = LOWER(%s) AND %s <> '') THEN 1
                        WHEN (usuario_id = %s AND %s > 0) THEN 2
                        WHEN (LOWER(email) = LOWER(%s) AND %s <> '') THEN 3
                        WHEN (LOWER(username) = LOWER(%s) AND %s <> '') THEN 4
                        ELSE 99
                    END,
                    usuario_id DESC
                LIMIT 1
                """,
                [
                    username, username, email, email, user_pk, user_pk,
                    username, username, email, email, user_pk, user_pk,
                    email, email, username, username,
                ],
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None

    def _get_front_role(self, request_user) -> str:
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT r.codigo
                    FROM negocio.usuario u
                    LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    WHERE LOWER(u.username) = LOWER(%s) OR LOWER(u.email) = LOWER(%s)
                    ORDER BY
                        CASE
                            WHEN LOWER(COALESCE(r.codigo, '')) IN ('administrador', 'admin') THEN 1
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'secretaria' THEN 2
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'barbero' THEN 3
                            WHEN LOWER(COALESCE(r.codigo, '')) = 'cliente' THEN 4
                            ELSE 99
                        END
                    LIMIT 1
                    """,
                    [request_user.username, request_user.email],
                )
                row = cursor.fetchone()
            if row and row[0]:
                return ROLE_MAP_DB_TO_FRONT.get(str(row[0]).strip().lower(), "cliente")
        except Exception:
            pass
        if request_user.is_superuser or request_user.is_staff:
            return "admin"
        return "cliente"

    def _ensure_cliente(self, request):
        rol = self._get_front_role(request.user)
        if rol in ROLES_BLOQUEADOS_ALEXA:
            return None, Response(
                {
                    "ok": False,
                    "error": "La Skill solo está disponible para clientes.",
                },
                status=403,
            )
        cliente_id = self._resolver_usuario_negocio_id(request)
        if not cliente_id:
            return None, Response(
                {"ok": False, "error": "Usuario de negocio no encontrado."},
                status=404,
            )
        return cliente_id, None

    def _issue_tokens(self, user):
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token), str(refresh)

    def _django_user_for_negocio(self, usuario_id: int):
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COALESCE(username, ''), COALESCE(email, '')
                FROM negocio.usuario
                WHERE usuario_id = %s
                LIMIT 1
                """,
                [usuario_id],
            )
            row = cursor.fetchone()
        if not row:
            return None
        username, email = str(row[0] or "").strip(), str(row[1] or "").strip()
        if username:
            user = User.objects.filter(username=username).first()
            if user:
                return user
        if email:
            user = User.objects.filter(email__iexact=email).first()
            if user:
                return user
        return None

    def _usuario_payload(self, usuario_id: int) -> dict:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    u.usuario_id,
                    COALESCE(u.email, ''),
                    COALESCE(pp.nombres, ''),
                    COALESCE(pp.apellido_paterno, ''),
                    COALESCE(r.codigo, 'cliente')
                FROM negocio.usuario u
                LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                LEFT JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                LEFT JOIN negocio.rol r ON r.rol_id = ur.rol_id
                WHERE u.usuario_id = %s
                ORDER BY ur.usuario_rol_id ASC NULLS LAST
                LIMIT 1
                """,
                [usuario_id],
            )
            row = cursor.fetchone()
        if not row:
            return {}
        rol = ROLE_MAP_DB_TO_FRONT.get(str(row[4] or "cliente").strip().lower(), "cliente")
        nombre = str(row[2] or "").strip()
        apellido = str(row[3] or "").strip()
        return {
            "id": int(row[0]),
            "nombre": nombre,
            "apellido": apellido,
            "nombre_completo": f"{nombre} {apellido}".strip(),
            "email": str(row[1] or ""),
            "rol": rol,
        }

    def _parse_extras_ids(self, raw) -> list[int]:
        if raw is None:
            return []
        if isinstance(raw, list):
            items = raw
        elif isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                items = parsed if isinstance(parsed, list) else []
            except (TypeError, ValueError, json.JSONDecodeError):
                items = [x.strip() for x in raw.split(",") if x.strip()]
        else:
            items = []
        out = []
        for item in items:
            try:
                val = int(item)
                if val > 0:
                    out.append(val)
            except (TypeError, ValueError):
                continue
        return list(dict.fromkeys(out))

    def _sinonimos_servicio(self, nombre: str, categoria: str) -> list[str]:
        n = nombre.strip().lower()
        cat = categoria.strip().lower()
        synonyms = {n}
        if cat == "corte":
            synonyms.update({"corte", "corte de cabello", "cabello", "fade", "degradado"})
        elif cat == "barba":
            synonyms.update({"barba", "arreglo de barba", "recorte de barba"})
        elif cat in {"paquete", "combo"}:
            synonyms.update({"paquete", "combo", "corte y barba", "corte con barba"})
        elif cat == "tratamiento":
            if "ceja" in n:
                synonyms.update({"ceja", "cejas", "arreglo de ceja"})
            if "facial" in n:
                synonyms.update({"limpieza facial", "facial"})
            if "tinte" in n or "barba" in n:
                synonyms.update({"tinte para barba", "tinte de barba"})
            if "tattoo" in n or "greca" in n:
                synonyms.update({"hair tattoo", "grecas", "greca"})
        return sorted(s for s in synonyms if s)

    def _sinonimos_barbero(self, nombre: str, apellido: str) -> list[str]:
        out = set()
        n, a = nombre.strip(), apellido.strip()
        if n:
            out.add(n)
        if a:
            out.add(a)
        if n and a:
            out.add(f"{n} {a}")
            out.add(f"con {n}")
        return sorted(out)

    def _categoria_front(self, codigo_db: str) -> str:
        codigo = str(codigo_db or "").strip().lower()
        if codigo == "paquete":
            return "combo"
        return codigo or "otros"

    def _load_servicio(self, cursor, servicio_id: int) -> dict | None:
        cursor.execute(
            """
            SELECT
                s.servicio_id,
                s.nombre,
                s.precio_base,
                s.duracion_base_min,
                COALESCE(cs.codigo, 'otros'),
                COALESCE(s.activo, FALSE)
            FROM negocio.servicio s
            LEFT JOIN negocio.categoria_servicio cs
                ON cs.categoria_servicio_id = s.categoria_servicio_id
            WHERE s.servicio_id = %s
            LIMIT 1
            """,
            [servicio_id],
        )
        row = cursor.fetchone()
        if not row or not bool(row[5]):
            return None
        cat = self._categoria_front(str(row[4] or ""))
        return {
            "id": int(row[0]),
            "nombre": str(row[1] or ""),
            "precio": float(self._to_money(row[2])),
            "duracion_minutos": int(row[3] or 0),
            "categoria": cat,
            "categoria_db": str(row[4] or "").lower(),
        }

    def _load_bundle(self, cursor, servicio_id: int, extras_ids: list[int]) -> tuple[dict | None, list[dict], str | None]:
        principal = self._load_servicio(cursor, servicio_id)
        if not principal:
            return None, [], "Servicio principal no encontrado o inactivo."

        cat_principal = principal["categoria_db"]
        if cat_principal not in CATEGORIAS_PRINCIPAL and cat_principal != "paquete":
            # Permitir paquete/combo como principal aunque venga como paquete en BD
            if principal["categoria"] not in {"combo", "corte", "barba"}:
                return None, [], "El servicio principal debe ser corte, barba o paquete."

        extras = []
        for eid in extras_ids:
            if eid == servicio_id:
                continue
            svc = self._load_servicio(cursor, eid)
            if not svc:
                return None, [], f"Extra con id {eid} no encontrado o inactivo."
            if svc["categoria_db"] not in CATEGORIAS_EXTRA and svc["categoria"] != "tratamiento":
                return None, [], f"'{svc['nombre']}' no es un extra válido."
            extras.append(svc)

        return principal, extras, None

    def _compute_totals(self, principal: dict, extras: list[dict]) -> tuple[int, Decimal]:
        duracion = int(principal["duracion_minutos"] or 0)
        precio = self._to_money(principal["precio"])
        for ex in extras:
            duracion += int(ex["duracion_minutos"] or 0)
            precio += self._to_money(ex["precio"])
        return max(duracion, 1), precio

    def _build_notas_extras(self, extras: list[dict]) -> str:
        if not extras:
            return ""
        parts = [f"{e['nombre']} (${e['precio']:.2f} MXN)" for e in extras]
        return f"Complementos: {'; '.join(parts)}"

    def _validar_fecha(self, fecha_str: str) -> tuple[date | None, str | None]:
        raw = str(fecha_str or "").strip()
        if "T" in raw:
            raw = raw.split("T", 1)[0]
        elif " " in raw:
            raw = raw.split(" ", 1)[0]
        raw = raw[:10]
        try:
            fecha_obj = date.fromisoformat(raw)
        except ValueError:
            return None, "Fecha inválida. Usa YYYY-MM-DD."
        hoy = timezone.localdate()
        if fecha_obj < hoy:
            return None, "No se permiten fechas pasadas."
        if fecha_obj > hoy + timedelta(days=self._alexa_max_dias()):
            return None, f"Solo puedes agendar hasta {self._alexa_max_dias()} días adelante."
        return fecha_obj, None

    def _validar_hora(self, hora_str: str) -> tuple[str | None, str | None]:
        hora = str(hora_str or "").strip()[:5]
        try:
            hora_obj = datetime.strptime(hora, "%H:%M").time()
        except ValueError:
            return None, "Hora inválida. Usa HH:MM."
        inicio_min = int(hora_obj.hour) * 60 + int(hora_obj.minute)
        if inicio_min % SLOT_MINUTES != 0:
            return None, "Ese horario no está disponible. Elige otro de los horarios libres."
        return hora, None

    def _texto_servicio_reserva(self, principal: dict, extras: list[dict]) -> str:
        nombre = str(principal.get("nombre") or "tu servicio").strip()
        if not extras:
            return nombre
        extras_txt = ", ".join(str(e.get("nombre") or "").strip() for e in extras if e.get("nombre"))
        if not extras_txt:
            return nombre
        return f"{nombre} con {extras_txt}"

    def _barbero_cubre_servicios(self, cursor, barbero_id: int, servicio_ids: list[int]) -> bool:
        if not servicio_ids:
            return False
        cursor.execute(
            """
            SELECT servicio_id
            FROM negocio.barbero_servicio
            WHERE empleado_id = %s
            """,
            [barbero_id],
        )
        asignados = {int(r[0]) for r in cursor.fetchall()}
        if not asignados:
            return len(servicio_ids) == 1
        return all(sid in asignados for sid in servicio_ids)

    def _politica_cliente(self, cursor, cliente_id: int) -> dict:
        cursor.execute(
            """
            SELECT COALESCE(pa.porcentaje_anticipo, 50), COALESCE(pa.citas_penalizacion, 3)
            FROM negocio.politica_anticipo pa
            ORDER BY pa.politica_anticipo_id DESC
            LIMIT 1
            """
        )
        row_pol = cursor.fetchone()
        porcentaje = int(self._to_money(row_pol[0] if row_pol else 50))
        cursor.execute(
            """
            SELECT COALESCE(COUNT(*), 0)
            FROM negocio.cita c
            JOIN negocio.estado_cita ec ON ec.estado_cita_id = c.estado_cita_id
            WHERE c.cliente_usuario_id = %s
              AND LOWER(COALESCE(ec.codigo, '')) = 'no_asistio'
            """,
            [cliente_id],
        )
        inasistencias = int((cursor.fetchone() or [0])[0] or 0)
        penalizado = inasistencias > 0
        return {
            "penalizado": penalizado,
            "porcentaje_anticipo": porcentaje,
            "total_inasistencias": inasistencias,
            "requiere_anticipo": penalizado,
        }

    def _marcar_horarios_pasados(self, horarios: list[dict], fecha_obj: date) -> list[dict]:
        """Marca como no disponibles los slots que ya pasaron si la cita es hoy."""
        hoy = timezone.localdate()
        if fecha_obj != hoy or not horarios:
            return horarios
        ahora = timezone.localtime()
        ahora_min = int(ahora.hour) * 60 + int(ahora.minute)
        limite = ((ahora_min + SLOT_MINUTES - 1) // SLOT_MINUTES) * SLOT_MINUTES
        result = []
        for item in horarios:
            copia = dict(item)
            hm = self._to_minutes(copia.get("hora"))
            if hm >= 0 and hm < limite:
                copia["disponible"] = False
                copia["motivo"] = "pasado"
            result.append(copia)
        return result

    def _merge_intervals_fmt(self, intervals: list[tuple[int, int]]) -> list[dict]:
        if not intervals:
            return []
        ordenados = sorted(intervals, key=lambda x: x[0])
        fusionados: list[list[int]] = [[ordenados[0][0], ordenados[0][1]]]
        for inicio, fin in ordenados[1:]:
            if inicio <= fusionados[-1][1]:
                fusionados[-1][1] = max(fusionados[-1][1], fin)
            else:
                fusionados.append([inicio, fin])
        return [
            {"inicio": self._fmt_minutes(s), "fin": self._fmt_minutes(e)}
            for s, e in fusionados
        ]

    def _intervalos_disponibles(self, horarios: list[dict], duracion: int) -> list[dict]:
        rangos: list[dict] = []
        inicio: int | None = None
        ultimo_inicio: int | None = None
        for item in horarios:
            if not item.get("disponible"):
                if inicio is not None and ultimo_inicio is not None:
                    rangos.append(
                        {
                            "inicio": self._fmt_minutes(inicio),
                            "fin": self._fmt_minutes(ultimo_inicio + duracion),
                        }
                    )
                inicio = None
                ultimo_inicio = None
                continue
            hm = self._to_minutes(item.get("hora"))
            if hm < 0:
                continue
            if inicio is None:
                inicio = hm
            ultimo_inicio = hm
        if inicio is not None and ultimo_inicio is not None:
            rangos.append(
                {
                    "inicio": self._fmt_minutes(inicio),
                    "fin": self._fmt_minutes(ultimo_inicio + duracion),
                }
            )
        return rangos

    def _fmt_hora_humana(self, hhmm: str) -> str:
        mins = self._to_minutes(hhmm)
        if mins < 0:
            return hhmm
        h24 = mins // 60
        mi = mins % 60
        nombres = {
            1: "una",
            2: "dos",
            3: "tres",
            4: "cuatro",
            5: "cinco",
            6: "seis",
            7: "siete",
            8: "ocho",
            9: "nueve",
            10: "diez",
            11: "once",
            12: "doce",
        }
        if h24 == 0:
            h12, periodo = 12, "de la noche"
        elif h24 < 12:
            h12, periodo = h24, "de la mañana"
        elif h24 == 12:
            h12, periodo = 12, "del mediodía"
        elif h24 < 19:
            h12, periodo = h24 - 12, "de la tarde"
        else:
            h12, periodo = h24 - 12, "de la noche"
        base = nombres.get(h12, str(h12))
        if mi:
            return f"{base} {mi} {periodo}"
        return f"{base} {periodo}"

    def _lista_horas_voz(self, horas: list[str], limite: int = 5) -> str:
        if not horas:
            return ""
        muestra = horas[:limite]
        partes = [self._fmt_hora_humana(h) for h in muestra]
        if len(partes) == 1:
            return partes[0]
        return ", ".join(partes[:-1]) + " y " + partes[-1]

    def _lista_bloques_voz(self, bloques: list[dict]) -> str:
        if not bloques:
            return ""
        partes = []
        for b in bloques:
            ini = self._fmt_hora_humana(str(b.get("inicio", "")))
            fin = self._fmt_hora_humana(str(b.get("fin", "")))
            partes.append(f"de {ini} a {fin}")
        if len(partes) == 1:
            return partes[0]
        return ", ".join(partes[:-1]) + " y " + partes[-1]

    def _mensaje_disponibilidad_dia(
        self,
        barbero_nombre: str,
        fecha_str: str,
        jornada_inicio: str,
        jornada_fin: str,
        bloques_disponibles: list[dict],
        horarios_sugeridos: list[str],
        servicio_txt: str,
    ) -> str:
        try:
            fecha_obj = date.fromisoformat(fecha_str)
            dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
            fecha_txt = f"el {dias[fecha_obj.weekday()]} {fecha_obj.day} de {fecha_obj.strftime('%B')}"
        except ValueError:
            fecha_txt = f"el {fecha_str}"

        partes = [
            f"Perfecto. Para {fecha_txt} con {barbero_nombre}, "
            f"revisé disponibilidad para {servicio_txt}. "
            f"Atiende de {self._fmt_hora_humana(jornada_inicio)} "
            f"a {self._fmt_hora_humana(jornada_fin)}."
        ]
        if bloques_disponibles:
            if len(bloques_disponibles) == 1:
                partes.append(f"Hay espacio {self._lista_bloques_voz(bloques_disponibles)}.")
            else:
                partes.append(
                    "Hay varios horarios libres, por ejemplo "
                    + self._lista_bloques_voz(bloques_disponibles[:2])
                    + "."
                )
        if horarios_sugeridos:
            partes.append(
                "Puedes decir por ejemplo "
                + self._lista_horas_voz(horarios_sugeridos[:3])
                + "."
            )
        return " ".join(partes)

    def _horarios_sugeridos(
        self, horarios: list[dict], hora_ref: str | None = None, limite: int = 3
    ) -> list[str]:
        libres = [h["hora"] for h in horarios if h.get("disponible")]
        if not libres:
            return []
        if not hora_ref:
            return libres[:limite]
        ref_min = self._to_minutes(hora_ref)
        if ref_min < 0:
            return libres[:limite]
        ordenados = sorted(libres, key=lambda hh: abs(self._to_minutes(hh) - ref_min))
        return ordenados[:limite]

    def _build_horarios_dia(
        self, cursor, barbero_id: int, fecha_obj: date, duracion: int
    ) -> dict:
        horarios = self._horarios_disponibles(cursor, barbero_id, fecha_obj, duracion)
        if not horarios:
            return {
                "horarios": [],
                "jornada_inicio": None,
                "jornada_fin": None,
                "bloques_ocupados": [],
                "bloques_disponibles": [],
            }

        jornada_inicio = horarios[0]["hora"]
        ultimo = horarios[-1]["hora"]
        ultimo_min = self._to_minutes(ultimo)
        jornada_fin = self._fmt_minutes(ultimo_min + duracion) if ultimo_min >= 0 else ultimo

        bloques_ocupados = self._merge_intervals_fmt(
            [
                (self._to_minutes(h["hora"]), self._to_minutes(h["hora"]) + duracion)
                for h in horarios
                if not h.get("disponible") and h.get("motivo") != "pasado"
            ]
        )
        bloques_disponibles = self._intervalos_disponibles(horarios, duracion)

        return {
            "horarios": horarios,
            "jornada_inicio": jornada_inicio,
            "jornada_fin": jornada_fin,
            "bloques_ocupados": bloques_ocupados,
            "bloques_disponibles": bloques_disponibles,
        }

    def _horarios_disponibles(
        self, cursor, barbero_id: int, fecha_obj: date, duracion: int
    ) -> list[dict]:
        dia_semana = int(fecha_obj.weekday())
        cursor.execute(
            """
            SELECT e.empleado_id, e.empresa_id
            FROM negocio.empleado e
            JOIN negocio.usuario_rol ur ON ur.usuario_id = e.usuario_id
            JOIN negocio.rol r ON r.rol_id = ur.rol_id
            WHERE e.empleado_id = %s
              AND COALESCE(e.activo, FALSE) = TRUE
              AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
            LIMIT 1
            """,
            [barbero_id],
        )
        row_barbero = cursor.fetchone()
        if not row_barbero:
            return []
        empresa_id = int(row_barbero[1])

        cursor.execute(
            """
            SELECT COALESCE(abierto, FALSE), hora_apertura, hora_cierre
            FROM negocio.horario_negocio
            WHERE empresa_id = %s AND dia_semana = %s
            LIMIT 1
            """,
            [empresa_id, dia_semana],
        )
        row_neg = cursor.fetchone()
        if not row_neg or not bool(row_neg[0]):
            return []
        neg_ini, neg_fin = self._to_minutes(row_neg[1]), self._to_minutes(row_neg[2])
        if neg_ini < 0 or neg_fin <= neg_ini:
            return []

        cursor.execute(
            """
            SELECT COALESCE(trabaja, FALSE), hora_inicio, hora_fin
            FROM negocio.empleado_horario_dia
            WHERE empleado_id = %s AND dia_semana = %s
            LIMIT 1
            """,
            [barbero_id, dia_semana],
        )
        row_hor = cursor.fetchone()
        if not row_hor or not bool(row_hor[0]):
            return []
        barb_ini, barb_fin = self._to_minutes(row_hor[1]), self._to_minutes(row_hor[2])
        work_ini = max(neg_ini, barb_ini)
        work_fin = min(neg_fin, barb_fin)
        if work_fin - work_ini < duracion:
            return []

        cursor.execute(
            """
            SELECT 1 FROM negocio.empleado_dia_libre
            WHERE empleado_id = %s AND fecha = %s
              AND LOWER(COALESCE(estado, '')) = 'aprobado'
            LIMIT 1
            """,
            [barbero_id, fecha_obj],
        )
        if cursor.fetchone():
            return []

        cursor.execute(
            """
            SELECT 1 FROM negocio.empleado_vacacion
            WHERE empleado_id = %s
              AND %s BETWEEN fecha_inicio AND fecha_fin
              AND LOWER(COALESCE(estado, '')) = 'aprobada'
            LIMIT 1
            """,
            [barbero_id, fecha_obj],
        )
        if cursor.fetchone():
            return []

        cursor.execute(
            """
            SELECT hora_inicio, hora_fin
            FROM negocio.empleado_descanso
            WHERE empleado_id = %s AND dia_semana = %s
            """,
            [barbero_id, dia_semana],
        )
        descansos = []
        for d0, d1 in cursor.fetchall():
            m0, m1 = self._to_minutes(d0), self._to_minutes(d1)
            if m0 >= 0 and m1 > m0:
                descansos.append((m0, m1))

        cursor.execute(
            sql_citas_ocupadas_dia(),
            [barbero_id, fecha_obj],
        )
        ocupados = []
        for hora_local, dur_min in cursor.fetchall():
            if not hora_local:
                continue
            start = int(hora_local.hour) * 60 + int(hora_local.minute)
            dur_min = int(dur_min or 0)
            if dur_min <= 0:
                continue
            ocupados.append((start, start + dur_min))

        horarios = []
        slot = work_ini
        last_start = work_fin - duracion
        while slot <= last_start:
            slot_end = slot + duracion
            bloqueado = any(self._overlap(slot, slot_end, d0, d1) for d0, d1 in descansos)
            bloqueado = bloqueado or any(self._overlap(slot, slot_end, c0, c1) for c0, c1 in ocupados)
            horarios.append({"hora": self._fmt_minutes(slot), "disponible": not bloqueado})
            slot += SLOT_MINUTES
        return self._marcar_horarios_pasados(horarios, fecha_obj)

    def _hora_disponible(self, horarios: list[dict], hora: str) -> bool:
        for h in horarios:
            if h.get("hora") == hora and h.get("disponible"):
                return True
        return False

    def _resumen_cita(
        self,
        principal: dict,
        extras: list[dict],
        barbero_nombre: str,
        fecha_str: str,
        hora_str: str,
    ) -> str:
        nombres = [principal["nombre"]] + [e["nombre"] for e in extras]
        servicios_txt = nombres[0] if len(nombres) == 1 else f"{nombres[0]} con {', '.join(nombres[1:])}"
        try:
            fecha_obj = date.fromisoformat(fecha_str)
            fecha_hum = self._fecha_humana_es(fecha_obj)
        except ValueError:
            fecha_hum = fecha_str
        return (
            f"{servicios_txt}, con {barbero_nombre}, "
            f"el {fecha_hum} a las {hora_str}."
        )

    def _nombre_barbero(self, cursor, barbero_id: int) -> str:
        cursor.execute(
            """
            SELECT COALESCE(pp.nombres, ''), COALESCE(pp.apellido_paterno, '')
            FROM negocio.empleado e
            JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
            LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
            WHERE e.empleado_id = %s
            LIMIT 1
            """,
            [barbero_id],
        )
        row = cursor.fetchone()
        if not row:
            return f"barbero {barbero_id}"
        return f"{str(row[0] or '').strip()} {str(row[1] or '').strip()}".strip()


class AlexaEstadoVinculacionView(AlexaBaseMixin, APIView):
    """Indica si el cliente ya vinculó su cuenta con la Skill Alexa."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        cliente_id, err = self._ensure_cliente(request)
        if err:
            return err

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT vinculado_en, actualizado_en
                    FROM negocio.alexa_cuenta_vinculada
                    WHERE usuario_id = %s
                    ORDER BY actualizado_en DESC
                    LIMIT 1
                    """,
                    [cliente_id],
                )
                row = cursor.fetchone()
            if row:
                ts = row[1] or row[0]
                vinculado_en = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
                return Response({"ok": True, "vinculado": True, "vinculado_en": vinculado_en})
            return Response({"ok": True, "vinculado": False})
        except DatabaseError as exc:
            logger.exception("Alexa estado vinculacion: %s", exc)
            return Response(
                {
                    "ok": False,
                    "vinculado": False,
                    "error": "No se pudo consultar el estado de vinculación.",
                },
                status=503,
            )


class AlexaCodigoVinculacionView(AlexaBaseMixin, APIView):
    """Genera código de 4 dígitos para vincular cuenta Alexa (cliente autenticado en web)."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        cliente_id, err = self._ensure_cliente(request)
        if err:
            return err

        codigo = f"{random.randint(0, 9999):04d}"
        expira = timezone.now() + timedelta(minutes=self._alexa_codigo_exp_minutes())
        exp_secs = self._alexa_codigo_exp_minutes() * 60

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE negocio.alexa_vinculacion
                        SET usado = TRUE
                        WHERE usuario_id = %s AND usado = FALSE
                        """,
                        [cliente_id],
                    )
                    cursor.execute(
                        """
                        INSERT INTO negocio.alexa_vinculacion (usuario_id, codigo, expira_en, usado)
                        VALUES (%s, %s, %s, FALSE)
                        """,
                        [cliente_id, codigo, expira],
                    )
            return Response(
                {
                    "ok": True,
                    "codigo": codigo,
                    "expira_en_segundos": exp_secs,
                }
            )
        except DatabaseError as exc:
            logger.exception("Alexa codigo vinculacion: %s", exc)
            return Response(
                {
                    "ok": False,
                    "error": (
                        "No se pudo generar el código. "
                        "Ejecuta sql/alexa_vinculacion.sql en la base de datos."
                    ),
                },
                status=503,
            )


class AlexaVincularView(AlexaBaseMixin, APIView):
    """Consume código de vinculación y devuelve JWT para la Lambda de Alexa."""

    permission_classes = [AllowAny]

    def post(self, request):
        internal_key = str(getattr(settings, "ALEXA_INTERNAL_KEY", "") or "").strip()
        if internal_key:
            header_key = str(request.headers.get("X-Alexa-Internal-Key", "") or "").strip()
            if header_key != internal_key:
                return Response({"ok": False, "error": "No autorizado."}, status=403)

        data = request.data if isinstance(request.data, dict) else {}
        codigo = re.sub(r"\D+", "", str(data.get("codigo", "") or ""))[:4]
        alexa_user_id = str(data.get("alexa_user_id", "") or "").strip()

        if len(codigo) != 4:
            return Response({"ok": False, "error": "Código de 4 dígitos inválido."}, status=400)
        if not alexa_user_id:
            return Response({"ok": False, "error": "alexa_user_id es obligatorio."}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT v.vinculacion_id, v.usuario_id
                        FROM negocio.alexa_vinculacion v
                        WHERE v.codigo = %s
                          AND v.usado = FALSE
                          AND v.expira_en > NOW()
                        ORDER BY v.vinculacion_id DESC
                        LIMIT 1
                        FOR UPDATE
                        """,
                        [codigo],
                    )
                    row = cursor.fetchone()
                    if not row:
                        return Response(
                            {"ok": False, "error": "Código inválido o expirado."},
                            status=400,
                        )
                    vinculacion_id, usuario_id = int(row[0]), int(row[1])

                    usuario = self._usuario_payload(usuario_id)
                    if usuario.get("rol") in ROLES_BLOQUEADOS_ALEXA:
                        cursor.execute(
                            "UPDATE negocio.alexa_vinculacion SET usado = TRUE WHERE vinculacion_id = %s",
                            [vinculacion_id],
                        )
                        return Response(
                            {
                                "ok": False,
                                "error": "La Skill solo está disponible para clientes.",
                            },
                            status=403,
                        )

                    cursor.execute(
                        """
                        UPDATE negocio.alexa_vinculacion
                        SET usado = TRUE, alexa_user_id = %s
                        WHERE vinculacion_id = %s
                        """,
                        [alexa_user_id, vinculacion_id],
                    )
                    cursor.execute(
                        """
                        INSERT INTO negocio.alexa_cuenta_vinculada (usuario_id, alexa_user_id, actualizado_en)
                        VALUES (%s, %s, NOW())
                        ON CONFLICT (alexa_user_id) DO UPDATE
                        SET usuario_id = EXCLUDED.usuario_id, actualizado_en = NOW()
                        """,
                        [usuario_id, alexa_user_id],
                    )

            django_user = self._django_user_for_negocio(usuario_id)
            if not django_user:
                return Response(
                    {"ok": False, "error": "No se encontró cuenta de acceso para este usuario."},
                    status=404,
                )

            access, refresh = self._issue_tokens(django_user)
            return Response(
                {
                    "ok": True,
                    "access": access,
                    "refresh": refresh,
                    "usuario": usuario,
                }
            )
        except DatabaseError as exc:
            logger.exception("Alexa vincular: %s", exc)
            return Response(
                {
                    "ok": False,
                    "error": "Error de base de datos. Ejecuta sql/alexa_vinculacion.sql.",
                },
                status=503,
            )


class AlexaCatalogoAgendaView(AlexaBaseMixin, APIView):
    """Catálogo normalizado para Dynamic Entities y flujo de voz."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        _, err = self._ensure_cliente(request)
        if err:
            return err

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        s.servicio_id,
                        s.nombre,
                        s.precio_base,
                        s.duracion_base_min,
                        COALESCE(cs.codigo, 'otros')
                    FROM negocio.servicio s
                    LEFT JOIN negocio.categoria_servicio cs
                        ON cs.categoria_servicio_id = s.categoria_servicio_id
                    WHERE COALESCE(s.activo, FALSE) = TRUE
                    ORDER BY s.servicio_id ASC
                    """
                )
                rows = cursor.fetchall()

                servicios = []
                extras = []
                for row in rows:
                    cat_db = str(row[4] or "").lower()
                    cat = self._categoria_front(cat_db)
                    item = {
                        "id": int(row[0]),
                        "nombre": str(row[1] or ""),
                        "categoria": cat,
                        "precio": float(self._to_money(row[2])),
                        "duracion_minutos": int(row[3] or 0),
                        "sinonimos": self._sinonimos_servicio(str(row[1] or ""), cat_db),
                    }
                    if cat_db in CATEGORIAS_PRINCIPAL:
                        servicios.append(item)
                    elif cat_db in CATEGORIAS_EXTRA:
                        extras.append(item)

                cursor.execute(
                    """
                    SELECT
                        e.empleado_id,
                        COALESCE(pp.nombres, ''),
                        COALESCE(pp.apellido_paterno, ''),
                        COALESCE((
                            SELECT array_agg(DISTINCT bs.servicio_id ORDER BY bs.servicio_id)
                            FROM negocio.barbero_servicio bs
                            WHERE bs.empleado_id = e.empleado_id
                        ), '{}') AS servicios_ids
                    FROM negocio.empleado e
                    JOIN negocio.usuario u ON u.usuario_id = e.usuario_id
                    JOIN negocio.usuario_rol ur ON ur.usuario_id = u.usuario_id
                    JOIN negocio.rol r ON r.rol_id = ur.rol_id
                    LEFT JOIN negocio.perfil_persona pp ON pp.usuario_id = u.usuario_id
                    WHERE COALESCE(e.activo, FALSE) = TRUE
                      AND LOWER(COALESCE(r.codigo, '')) = 'barbero'
                    ORDER BY pp.nombres, pp.apellido_paterno, e.empleado_id
                    """
                )
                barberos = []
                for row in cursor.fetchall():
                    nombre = str(row[1] or "").strip()
                    apellido = str(row[2] or "").strip()
                    servicios_ids_raw = row[3]
                    if isinstance(servicios_ids_raw, (list, tuple)):
                        servicios_ids = [int(x) for x in servicios_ids_raw if x is not None]
                    else:
                        servicios_ids = []
                    barberos.append(
                        {
                            "id": int(row[0]),
                            "nombre_completo": f"{nombre} {apellido}".strip(),
                            "activo": True,
                            "servicios_ids": servicios_ids,
                            "sinonimos": self._sinonimos_barbero(nombre, apellido),
                        }
                    )

            return Response(
                {
                    "ok": True,
                    "servicios": servicios,
                    "extras": extras,
                    "barberos": barberos,
                }
            )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo cargar el catálogo."}, status=500)


class AlexaDisponibilidadDiaView(AlexaBaseMixin, APIView):
    """Consulta jornada, bloques ocupados/libres y slots de 20 min para un día."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        cliente_id, err = self._ensure_cliente(request)
        if err:
            return err

        data = request.data if isinstance(request.data, dict) else {}
        try:
            servicio_id = int(data.get("servicio_id", 0) or 0)
            barbero_id = int(data.get("barbero_id", 0) or 0)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "IDs inválidos."}, status=400)

        extras_ids = self._parse_extras_ids(data.get("extras_ids"))
        fecha_str = str(data.get("fecha", "") or "").strip()

        if servicio_id <= 0 or barbero_id <= 0:
            return Response({"ok": False, "error": "servicio_id y barbero_id son obligatorios."}, status=400)

        fecha_obj, fecha_err = self._validar_fecha(fecha_str)
        if fecha_err:
            return Response({"ok": False, "error": fecha_err}, status=400)

        try:
            with connection.cursor() as cursor:
                principal, extras, bundle_err = self._load_bundle(cursor, servicio_id, extras_ids)
                if bundle_err:
                    return Response({"ok": False, "error": bundle_err}, status=400)

                duracion, precio_total = self._compute_totals(principal, extras)
                servicio_ids = [servicio_id] + extras_ids
                if not self._barbero_cubre_servicios(cursor, barbero_id, servicio_ids):
                    return Response(
                        {"ok": False, "error": "El barbero no realiza todos los servicios seleccionados."},
                        status=400,
                    )

                barbero_nombre = self._nombre_barbero(cursor, barbero_id)
                servicio_txt = self._texto_servicio_reserva(principal, extras)
                dia_info = self._build_horarios_dia(cursor, barbero_id, fecha_obj, duracion)
                horarios = dia_info["horarios"]
                horarios_libres = [h["hora"] for h in horarios if h.get("disponible")]
                sugeridos = self._horarios_sugeridos(horarios, limite=5)

                jornada_inicio = dia_info.get("jornada_inicio")
                jornada_fin = dia_info.get("jornada_fin")
                if horarios and jornada_inicio and jornada_fin:
                    ultimo_slot = self._to_minutes(horarios[-1]["hora"])
                    if ultimo_slot >= 0:
                        jornada_fin = self._fmt_minutes(ultimo_slot + duracion)

                try:
                    dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
                    fecha_txt = (
                        f"el {dias[fecha_obj.weekday()]} "
                        f"{fecha_obj.day} de {fecha_obj.strftime('%B')}"
                    )
                except Exception:
                    fecha_txt = f"el {fecha_str}"

                mensaje_voz = ""
                if not horarios or not horarios_libres:
                    mensaje_voz = (
                        f"No hay horarios disponibles para {fecha_txt} con {barbero_nombre}. "
                        "Prueba otra fecha u otro barbero."
                    )
                elif jornada_inicio and jornada_fin:
                    mensaje_voz = self._mensaje_disponibilidad_dia(
                        barbero_nombre,
                        fecha_str,
                        jornada_inicio,
                        jornada_fin,
                        dia_info.get("bloques_disponibles") or [],
                        sugeridos,
                        servicio_txt,
                    )

                return Response(
                    {
                        "ok": True,
                        "fecha": fecha_str,
                        "barbero": barbero_nombre,
                        "duracion_total_minutos": duracion,
                        "precio_total": float(precio_total),
                        "intervalo_minutos": SLOT_MINUTES,
                        "jornada_inicio": jornada_inicio,
                        "jornada_fin": jornada_fin,
                        "bloques_ocupados": dia_info.get("bloques_ocupados") or [],
                        "bloques_disponibles": dia_info.get("bloques_disponibles") or [],
                        "horarios_libres": horarios_libres,
                        "horarios_sugeridos": sugeridos,
                        "mensaje_voz": mensaje_voz,
                        "tiene_disponibilidad": bool(horarios_libres),
                    }
                )
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo consultar la disponibilidad."}, status=500)


class AlexaCitaPrevalidarView(AlexaBaseMixin, APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        cliente_id, err = self._ensure_cliente(request)
        if err:
            return err

        data = request.data if isinstance(request.data, dict) else {}
        try:
            servicio_id = int(data.get("servicio_id", 0) or 0)
            barbero_id = int(data.get("barbero_id", 0) or 0)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "IDs inválidos."}, status=400)

        extras_ids = self._parse_extras_ids(data.get("extras_ids"))
        fecha_str = str(data.get("fecha", "") or "").strip()
        hora_str = str(data.get("hora", "") or "").strip()

        if servicio_id <= 0 or barbero_id <= 0:
            return Response({"ok": False, "error": "servicio_id y barbero_id son obligatorios."}, status=400)

        fecha_obj, fecha_err = self._validar_fecha(fecha_str)
        if fecha_err:
            return Response({"ok": False, "error": fecha_err}, status=400)

        hora_norm, hora_err = self._validar_hora(hora_str) if hora_str else (None, None)

        try:
            with connection.cursor() as cursor:
                principal, extras, bundle_err = self._load_bundle(cursor, servicio_id, extras_ids)
                if bundle_err:
                    return Response({"ok": False, "error": bundle_err}, status=400)

                duracion, precio_total = self._compute_totals(principal, extras)
                servicio_ids = [servicio_id] + extras_ids
                if not self._barbero_cubre_servicios(cursor, barbero_id, servicio_ids):
                    return Response(
                        {"ok": False, "error": "El barbero no realiza todos los servicios seleccionados."},
                        status=400,
                    )

                barbero_nombre = self._nombre_barbero(cursor, barbero_id)
                dia_info = self._build_horarios_dia(cursor, barbero_id, fecha_obj, duracion)
                horarios = dia_info["horarios"]
                politica = self._politica_cliente(cursor, cliente_id)

                if not hora_norm:
                    sugeridos = self._horarios_sugeridos(horarios)
                    return Response(
                        {
                            "ok": True,
                            "disponible": None,
                            "duracion_total_minutos": duracion,
                            "precio_total": float(precio_total),
                            "requiere_anticipo": politica["requiere_anticipo"],
                            "monto_anticipo": float(
                                self._to_money(
                                    (precio_total * Decimal(politica["porcentaje_anticipo"])) / Decimal("100")
                                )
                            )
                            if politica["penalizado"]
                            else 0.0,
                            "horarios_disponibles": sugeridos,
                            "resumen": self._resumen_cita(
                                principal, extras, barbero_nombre, fecha_str, "hora por confirmar"
                            ),
                        }
                    )

                disponible = self._hora_disponible(horarios, hora_norm)
                monto_anticipo = Decimal("0.00")
                if politica["penalizado"]:
                    monto_anticipo = self._to_money(
                        (precio_total * Decimal(politica["porcentaje_anticipo"])) / Decimal("100")
                    )

                payload = {
                    "ok": True,
                    "disponible": disponible,
                    "duracion_total_minutos": duracion,
                    "precio_total": float(precio_total),
                    "requiere_anticipo": politica["requiere_anticipo"],
                    "monto_anticipo": float(monto_anticipo),
                    "penalizado": politica["penalizado"],
                    "porcentaje_anticipo": politica["porcentaje_anticipo"],
                    "resumen": self._resumen_cita(
                        principal, extras, barbero_nombre, fecha_str, hora_norm
                    ),
                }
                if not disponible:
                    payload["horarios_sugeridos"] = self._horarios_sugeridos(
                        horarios, hora_ref=hora_norm, limite=3
                    )
                return Response(payload)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo prevalidar la cita."}, status=500)


class AlexaCitaCrearView(AlexaBaseMixin, APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        cliente_id, err = self._ensure_cliente(request)
        if err:
            return err

        data = request.data if isinstance(request.data, dict) else {}
        try:
            servicio_id = int(data.get("servicio_id", 0) or 0)
            barbero_id = int(data.get("barbero_id", 0) or 0)
        except (TypeError, ValueError):
            return Response({"ok": False, "error": "IDs inválidos."}, status=400)

        extras_ids = self._parse_extras_ids(data.get("extras_ids"))
        fecha_str = str(data.get("fecha", "") or "").strip()
        hora_str = str(data.get("hora", "") or "").strip()
        tipo_pago = str(data.get("tipo_pago", "sin_anticipo") or "sin_anticipo").strip().lower()

        if servicio_id <= 0 or barbero_id <= 0:
            return Response({"ok": False, "error": "servicio_id y barbero_id son obligatorios."}, status=400)

        fecha_obj, fecha_err = self._validar_fecha(fecha_str)
        if fecha_err:
            return Response({"ok": False, "error": fecha_err}, status=400)
        hora_norm, hora_err = self._validar_hora(hora_str)
        if hora_err:
            return Response({"ok": False, "error": hora_err}, status=400)

        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    principal, extras, bundle_err = self._load_bundle(cursor, servicio_id, extras_ids)
                    if bundle_err:
                        return Response({"ok": False, "error": bundle_err}, status=400)

                    duracion, precio_total = self._compute_totals(principal, extras)
                    servicio_ids = [servicio_id] + extras_ids
                    if not self._barbero_cubre_servicios(cursor, barbero_id, servicio_ids):
                        return Response(
                            {"ok": False, "error": "El barbero no realiza todos los servicios seleccionados."},
                            status=400,
                        )

                    horarios = self._horarios_disponibles(cursor, barbero_id, fecha_obj, duracion)
                    if not self._hora_disponible(horarios, hora_norm):
                        sugeridos = self._horarios_sugeridos(horarios)
                        return Response(
                            {
                                "ok": False,
                                "error": "Ese horario no está disponible.",
                                "horarios_sugeridos": sugeridos,
                            },
                            status=409,
                        )

                    politica = self._politica_cliente(cursor, cliente_id)
                    anticipo_pagado = Decimal("0.00")
                    if politica["penalizado"]:
                        minimo = self._to_money(
                            (precio_total * Decimal(politica["porcentaje_anticipo"])) / Decimal("100")
                        )
                        if tipo_pago == "total":
                            anticipo_pagado = precio_total
                        elif tipo_pago == "anticipo":
                            anticipo_pagado = minimo
                        else:
                            return Response(
                                {
                                    "ok": False,
                                    "error": "Por penalización debes elegir pago de anticipo o total.",
                                    "requiere_pago": True,
                                    "monto_anticipo_minimo": float(minimo),
                                    "precio_total": float(precio_total),
                                },
                                status=402,
                            )
                    elif tipo_pago == "anticipo":
                        pct = Decimal(politica["porcentaje_anticipo"])
                        anticipo_pagado = self._to_money((precio_total * pct) / Decimal("100"))
                    elif tipo_pago == "total":
                        anticipo_pagado = precio_total

                    notas_parts = [self._build_notas_extras(extras)]
                    notas_parts.append("[ORIGEN_ALEXA]")
                    notas_final = "\n".join(p for p in notas_parts if p).strip() or None

                    hora_obj = datetime.strptime(hora_norm, "%H:%M").time()
                    fecha_hora_dt = self._fecha_hora_mexico(fecha_obj, hora_obj)

                    cursor.execute(
                        """
                        SELECT e.empresa_id
                        FROM negocio.empleado e
                        WHERE e.empleado_id = %s AND COALESCE(e.activo, FALSE) = TRUE
                        LIMIT 1
                        """,
                        [barbero_id],
                    )
                    row_emp = cursor.fetchone()
                    if not row_emp:
                        return Response({"ok": False, "error": "Barbero no válido."}, status=400)

                    cursor.execute(
                        """
                        SELECT estado_cita_id
                        FROM negocio.estado_cita
                        WHERE LOWER(COALESCE(codigo, '')) IN ('pendiente', 'confirmada')
                        ORDER BY CASE WHEN LOWER(codigo) = 'pendiente' THEN 1 ELSE 2 END
                        LIMIT 1
                        """
                    )
                    row_estado = cursor.fetchone()
                    if not row_estado:
                        return Response({"ok": False, "error": "No hay estado de cita configurado."}, status=500)
                    estado_cita_id = int(row_estado[0])

                    cursor.execute(
                        """
                        INSERT INTO negocio.cita (
                            cliente_usuario_id, empleado_id, servicio_id, estado_cita_id,
                            silla_id, fecha_hora, duracion_min, precio_total, notas, creado_por_rol
                        )
                        VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, 'cliente')
                        RETURNING cita_id
                        """,
                        [
                            cliente_id,
                            barbero_id,
                            servicio_id,
                            estado_cita_id,
                            fecha_hora_dt,
                            duracion,
                            precio_total,
                            notas_final,
                        ],
                    )
                    cita_id = int(cursor.fetchone()[0])

                    cursor.execute(
                        """
                        SELECT
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD'),
                            TO_CHAR((c.fecha_hora AT TIME ZONE 'America/Mexico_City')::time, 'HH24:MI')
                        FROM negocio.cita c
                        WHERE c.cita_id = %s
                        LIMIT 1
                        """,
                        [cita_id],
                    )
                    row_guardada = cursor.fetchone()
                    if row_guardada and (
                        str(row_guardada[0]) != fecha_str or str(row_guardada[1])[:5] != hora_norm
                    ):
                        logger.warning(
                            "Desfase horario Alexa cita_id=%s solicitado=%s %s guardado=%s %s",
                            cita_id,
                            fecha_str,
                            hora_norm,
                            row_guardada[0],
                            row_guardada[1],
                        )

                    cursor.execute(
                        """
                        INSERT INTO negocio.cita_estado_historial (
                            cita_id, estado_cita_id, cambiado_por_usuario_id, motivo
                        )
                        VALUES (%s, %s, %s, %s)
                        """,
                        [cita_id, estado_cita_id, cliente_id, "Creación desde Alexa Skill"],
                    )

                    requiere_pago_clip = anticipo_pagado > Decimal("0.00") and tipo_pago in {"anticipo", "total"}

            resp = {
                "ok": True,
                "cita_id": cita_id,
                "estado": "pendiente",
                "precio_total": float(precio_total),
                "duracion_total_minutos": duracion,
                "anticipo_pagado": float(anticipo_pagado),
                "mensaje": "Tu cita quedó agendada.",
                "origen": "alexa",
            }
            if requiere_pago_clip:
                resp["requiere_pago"] = True
                resp["monto_anticipo"] = float(anticipo_pagado)
                resp["mensaje"] = (
                    "Tu cita quedó registrada. Para confirmar el pago, "
                    "usa el endpoint /api/pagos/clip/intentar/ con tipo cita."
                )
                resp["clip_sugerido"] = {
                    "tipo": "cita",
                    "cita_id": cita_id,
                    "modo_cobro": "total" if tipo_pago == "total" else "anticipo_monto",
                    "anticipo_monto": float(anticipo_pagado),
                    "penalizada": politica["penalizado"],
                }
            return Response(resp, status=201)
        except DatabaseError:
            return Response({"ok": False, "error": "No se pudo crear la cita."}, status=500)
