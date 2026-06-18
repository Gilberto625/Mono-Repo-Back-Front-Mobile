import json
import re

from django.db import DatabaseError, connection
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

def db_structure_error_response(error: Exception):
    return Response(
        {
            "detail": (
                "La estructura de base de datos requerida no esta disponible en la BD activa. "
                "Ejecuta el modelo SQL definido en MODELO_BD_STYLO_BARBER_CONNECT (1).md / "
                "STYLO_BARBER_CONNECT_EJECUTAR.md en PostgreSQL y vuelve a intentar."
            ),
            "error": str(error),
        },
        status=503,
    )


class PublicServiciosView(APIView):
    permission_classes = [AllowAny]

    # Mismo contrato que AdminServiciosView.DB_TO_FRONT_CATEGORIA: la BD usa codigo "paquete", el front filtra "combo".
    _CATEGORIA_DB_A_FRONT = {
        "corte": "corte",
        "barba": "barba",
        "tratamiento": "tratamiento",
        "paquete": "combo",
    }

    def _build_relaciones(self, servicio_id: int) -> dict:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT url
                FROM negocio.servicio_imagen
                WHERE servicio_id = %s
                ORDER BY orden ASC
                """,
                [servicio_id],
            )
            galeria = [str(row[0] or "").strip() for row in cursor.fetchall() if str(row[0] or "").strip()]

            cursor.execute(
                """
                SELECT tr.codigo
                FROM negocio.servicio_tipo_rostro str
                JOIN negocio.tipo_rostro tr ON tr.tipo_rostro_id = str.tipo_rostro_id
                WHERE str.servicio_id = %s
                ORDER BY tr.tipo_rostro_id ASC
                """,
                [servicio_id],
            )
            rostros = [f"rostro-{str(row[0]).strip().lower()}" for row in cursor.fetchall() if row[0]]

            cursor.execute(
                """
                SELECT er.codigo
                FROM negocio.servicio_estilo se
                JOIN negocio.estilo_recomendado er ON er.estilo_id = se.estilo_id
                WHERE se.servicio_id = %s
                ORDER BY er.estilo_id ASC
                """,
                [servicio_id],
            )
            estilos = [f"estilo-{str(row[0]).strip().lower()}" for row in cursor.fetchall() if row[0]]

        return {
            "imagenes_galeria": galeria,
            "etiquetas": rostros + estilos,
        }

    def _serialize_row(self, row) -> dict:
        servicio_id = int(row[0])
        relaciones = self._build_relaciones(servicio_id)
        codigo_db = str(row[5] or "").strip().lower() or "otros"
        categoria_front = self._CATEGORIA_DB_A_FRONT.get(codigo_db, codigo_db)
        return {
            "id": servicio_id,
            "nombre": row[1],
            "descripcion": row[2],
            "precio": float(row[3]),
            "duracion_minutos": int(row[4]),
            "categoria": categoria_front,
            "popular": bool(row[6]),
            "activo": bool(row[7]),
            "imagen_url": row[8] or "",
            "imagenes_galeria": relaciones["imagenes_galeria"],
            "etiquetas": relaciones["etiquetas"],
        }

    def get(self, request, servicio_id: int | None = None):
        try:
            with connection.cursor() as cursor:
                if servicio_id is None:
                    cursor.execute(
                        """
                        SELECT
                            s.servicio_id,
                            s.nombre,
                            COALESCE(s.descripcion, ''),
                            s.precio_base,
                            s.duracion_base_min,
                            COALESCE(cs.codigo, 'otros') AS categoria_codigo,
                            COALESCE(s.popular, FALSE) AS popular,
                            s.activo,
                            COALESCE(
                                (
                                    SELECT si.url
                                    FROM negocio.servicio_imagen si
                                    WHERE si.servicio_id = s.servicio_id
                                    ORDER BY si.orden ASC
                                    LIMIT 1
                                ),
                                ''
                            ) AS imagen_url
                        FROM negocio.servicio s
                        LEFT JOIN negocio.categoria_servicio cs
                            ON cs.categoria_servicio_id = s.categoria_servicio_id
                        WHERE s.activo = TRUE
                        ORDER BY s.servicio_id ASC
                        """
                    )
                    rows = cursor.fetchall()
                    servicios = [self._serialize_row(row) for row in rows]
                    return Response({"ok": True, "servicios": servicios})

                cursor.execute(
                    """
                    SELECT
                        s.servicio_id,
                        s.nombre,
                        COALESCE(s.descripcion, ''),
                        s.precio_base,
                        s.duracion_base_min,
                        COALESCE(cs.codigo, 'otros') AS categoria_codigo,
                        COALESCE(s.popular, FALSE) AS popular,
                        s.activo,
                        COALESCE(
                            (
                                SELECT si.url
                                FROM negocio.servicio_imagen si
                                WHERE si.servicio_id = s.servicio_id
                                ORDER BY si.orden ASC
                                LIMIT 1
                            ),
                            ''
                        ) AS imagen_url
                    FROM negocio.servicio s
                    LEFT JOIN negocio.categoria_servicio cs
                        ON cs.categoria_servicio_id = s.categoria_servicio_id
                    WHERE s.servicio_id = %s
                      AND s.activo = TRUE
                    LIMIT 1
                    """,
                    [servicio_id],
                )
                row = cursor.fetchone()
                if not row:
                    return Response({"ok": False, "error": "Servicio no encontrado."}, status=404)
                return Response({"ok": True, "servicio": self._serialize_row(row)})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class PublicProductosView(APIView):
    permission_classes = [AllowAny]

    def _build_relaciones(self, producto_id: int) -> dict:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT url
                FROM negocio.producto_imagen
                WHERE producto_id = %s
                ORDER BY orden ASC
                """,
                [producto_id],
            )
            galeria = [str(row[0] or "").strip() for row in cursor.fetchall() if str(row[0] or "").strip()]
        return {"imagenes_galeria": galeria}

    def _serialize_row(self, row) -> dict:
        producto_id = int(row[0])
        relaciones = self._build_relaciones(producto_id)
        return {
            "id": producto_id,
            "nombre": row[1] or "",
            "marca": row[2] or "",
            "descripcion": row[3] or "",
            "precio": float(row[4] or 0),
            "categoria": row[5] or "otros",
            "stock": int(row[6] or 0),
            "stock_minimo": int(row[7] or 0),
            "imagen_url": row[8] or "",
            "imagenes_galeria": relaciones["imagenes_galeria"],
            "peso_volumen": row[9] or "",
            "activo": True,
            "destacado": bool(row[10]),
            "nuevo": False,
        }

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        p.producto_id,
                        p.nombre,
                        COALESCE(m.nombre, ''),
                        COALESCE(p.descripcion, ''),
                        p.precio_venta,
                        COALESCE(cp.codigo, 'otros') AS categoria_codigo,
                        COALESCE(ie.stock_actual, 0) AS stock_actual,
                        COALESCE(p.stock_minimo_alerta, 0) AS stock_minimo_alerta,
                        COALESCE(
                            (
                                SELECT pi.url
                                FROM negocio.producto_imagen pi
                                WHERE pi.producto_id = p.producto_id
                                ORDER BY pi.orden ASC
                                LIMIT 1
                            ),
                            ''
                        ) AS imagen_url,
                        COALESCE(p.peso_volumen, '') AS peso_volumen,
                        COALESCE(p.destacado, FALSE) AS destacado
                    FROM negocio.producto p
                    LEFT JOIN negocio.marca m
                        ON m.marca_id = p.marca_id
                    LEFT JOIN negocio.categoria_producto cp
                        ON cp.categoria_producto_id = p.categoria_producto_id
                    LEFT JOIN negocio.inventario_existencia ie
                        ON ie.producto_id = p.producto_id
                    WHERE p.estado = 'activo'
                      AND p.disponible_venta = TRUE
                    ORDER BY p.producto_id ASC
                    """
                )
                rows = cursor.fetchall()

            productos = [self._serialize_row(row) for row in rows]
            return Response(productos)
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class PublicContactoView(APIView):
    permission_classes = [AllowAny]

    def _normalizar_paqueterias(self, raw):
        if raw is None:
            return []
        texto = str(raw).strip()
        if not texto:
            return []
        if texto.startswith("paqueterias::"):
            texto = texto[len("paqueterias::") :].strip()
        if texto.startswith("[") or texto.startswith("{"):
            try:
                dec = json.loads(texto)
                if isinstance(dec, dict):
                    items = dec.get("paqueterias", [])
                elif isinstance(dec, list):
                    items = dec
                else:
                    items = []
            except Exception:
                items = re.split(r"[,\n;]+", texto)
        else:
            items = re.split(r"[,\n;]+", texto)
        out = []
        seen = set()
        for item in items:
            v = str(item or "").strip()
            if not v:
                continue
            k = v.lower()
            if k in seen:
                continue
            seen.add(k)
            out.append(v)
        return out

    def _extraer_config_extra(self, raw):
        out = {
            "paqueterias_disponibles": [],
            "clip_habilitado": False,
            "clip_url": "",
        }
        texto = str(raw or "").strip()
        if not texto:
            return out

        # Formato actual: configuración extra unificada.
        if texto.startswith("{"):
            try:
                payload = json.loads(texto)
                if isinstance(payload, dict):
                    if payload.get("_sys") == "config_extra":
                        out["paqueterias_disponibles"] = self._normalizar_paqueterias(
                            payload.get("paqueterias_disponibles", [])
                        )
                        clip = payload.get("clip", {})
                        if isinstance(clip, dict):
                            out["clip_habilitado"] = bool(clip.get("habilitado", False))
                            out["clip_url"] = str(clip.get("url", "") or "").strip()
                        return out

                    # Compatibilidad con formato anterior.
                    if payload.get("_sys") == "paqueterias_disponibles":
                        out["paqueterias_disponibles"] = self._normalizar_paqueterias(payload.get("items", []))
                        return out
            except Exception:
                pass

        # Compatibilidad con formato legado.
        if texto.startswith("paqueterias::"):
            out["paqueterias_disponibles"] = self._normalizar_paqueterias(texto)
            return out

        return out

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        e.empresa_id,
                        COALESCE(e.telefono, ''),
                        COALESCE(e.email_contacto, ''),
                        COALESCE(e.direccion_texto, ''),
                        COALESCE(e.nombre_negocio, 'Stylo Barber Connect'),
                        COALESCE(e.logo_tipo, 'texto'),
                        COALESCE(e.logo_texto_parte1, 'Stylo'),
                        COALESCE(e.logo_texto_parte2, 'Barber'),
                        COALESCE(e.logo_url, ''),
                        COALESCE(e.google_maps_url, ''),
                        COALESCE(e.apple_maps_url, '')
                    FROM negocio.empresa e
                    ORDER BY e.empresa_id ASC
                    LIMIT 1
                    """
                )
                row = cursor.fetchone()

            if not row:
                return Response(
                    {
                        "detail": "No hay datos en negocio.empresa. Configura la empresa en la BD.",
                    },
                    status=404,
                )

            empresa_id = int(row[0])

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        dia_semana,
                        abierto,
                        hora_apertura,
                        hora_cierre
                    FROM negocio.horario_negocio
                    WHERE empresa_id = %s
                    ORDER BY dia_semana ASC
                    """,
                    [empresa_id],
                )
                horarios_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT plataforma, url, activa
                    FROM negocio.red_social_negocio
                    WHERE empresa_id = %s
                    ORDER BY red_social_id ASC
                    """,
                    [empresa_id],
                )
                redes_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT
                        COALESCE(banco_nombre, ''),
                        COALESCE(titular, ''),
                        COALESCE(clabe, COALESCE(numero_cuenta, ''))
                    FROM negocio.cuenta_bancaria
                    WHERE empresa_id = %s
                      AND activa = TRUE
                    ORDER BY cuenta_bancaria_id DESC
                    LIMIT 1
                    """,
                    [empresa_id],
                )
                cuenta_row = cursor.fetchone()

                cursor.execute(
                    """
                    SELECT
                        porcentaje_anticipo,
                        citas_penalizacion,
                        tiempo_espera_maximo_min
                    FROM negocio.politica_anticipo
                    WHERE empresa_id = %s
                      AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
                    ORDER BY vigente_desde DESC, politica_anticipo_id DESC
                    LIMIT 1
                    """,
                    [empresa_id],
                )
                politica_row = cursor.fetchone()

                cursor.execute(
                    """
                    SELECT codigo, activo
                    FROM negocio.metodo_pago_catalogo
                    WHERE codigo IN ('efectivo', 'tarjeta', 'transferencia')
                    """
                )
                metodos_rows = cursor.fetchall()

                cursor.execute(
                    """
                    SELECT codigo, costo_fijo
                    FROM negocio.metodo_entrega
                    WHERE codigo IN ('tienda', 'moto_mandado', 'paqueteria')
                    """
                )
                metodos_entrega_rows = cursor.fetchall()

            dias = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"]
            horario_txt = "No definido"
            if horarios_rows:
                abiertos = []
                for h in horarios_rows:
                    dia = dias[int(h[0])] if 0 <= int(h[0]) <= 6 else str(h[0])
                    if h[1]:
                        abiertos.append(f"{dia} {h[2]}-{h[3]}")
                if abiertos:
                    horario_txt = ", ".join(abiertos)

            horarios_por_dia = [
                {
                    "dia_semana": int(h[0]),
                    "abierto": bool(h[1]),
                    "apertura": h[2].strftime("%H:%M") if h[2] else None,
                    "cierre": h[3].strftime("%H:%M") if h[3] else None,
                }
                for h in horarios_rows
            ]

            redes = {
                "facebook_url": "",
                "instagram_url": "",
                "x_url": "",
                "tiktok_url": "",
                "whatsapp_url": "",
            }
            paqueterias_disponibles = ["DHL", "Estafeta", "FedEx", "Paquetexpress"]
            clip_habilitado = False
            clip_url = ""
            for plataforma, url, activa in redes_rows:
                if not activa:
                    continue
                if plataforma == "otro":
                    cfg_extra = self._extraer_config_extra(url)
                    parsed = cfg_extra.get("paqueterias_disponibles") or []
                    if parsed:
                        paqueterias_disponibles = parsed
                    clip_habilitado = bool(cfg_extra.get("clip_habilitado", False))
                    clip_url = str(cfg_extra.get("clip_url", "") or "").strip()
                    continue
                key = f"{plataforma}_url"
                if key in redes:
                    redes[key] = url or ""

            pagos_activos = {
                "efectivo": True,
                "tarjeta": False,
                "transferencia": True,
            }
            for codigo, activa in metodos_rows:
                pagos_activos[str(codigo)] = bool(activa)

            costos_envio = {
                "recoger_local": 0.0,
                "moto_mandado": 45.0,
                "paqueteria": 150.0,
            }
            for codigo, costo in metodos_entrega_rows:
                if codigo == "tienda":
                    costos_envio["recoger_local"] = float(costo or 0)
                elif codigo == "moto_mandado":
                    costos_envio["moto_mandado"] = float(costo or 0)
                elif codigo == "paqueteria":
                    costos_envio["paqueteria"] = float(costo or 0)

            return Response(
                {
                    "telefono": row[1] or "",
                    "correo": row[2] or "",
                    "direccion": row[3] or "",
                    "horario": horario_txt,
                    "nombre_negocio": row[4] or "Stylo Barber Connect",
                    "logo_tipo": row[5] or "texto",
                    "logo_texto_parte1": row[6] or "Stylo",
                    "logo_texto_parte2": row[7] or "Barber",
                    "logo_url": row[8] or "",
                    "google_maps_url": row[9] or "",
                    "apple_maps_url": row[10] or "",
                    "horarios_por_dia": horarios_por_dia,
                    "banco_nombre": cuenta_row[0] if cuenta_row else "",
                    "banco_titular": cuenta_row[1] if cuenta_row else "",
                    "banco_cuenta": cuenta_row[2] if cuenta_row else "",
                    "porcentaje_anticipo": float(politica_row[0]) if politica_row else 0.0,
                    "citas_penalizacion": int(politica_row[1]) if politica_row else 0,
                    "tiempo_espera_maximo": int(politica_row[2]) if politica_row else 10,
                    "pago_efectivo_activo": pagos_activos["efectivo"],
                    "pago_tarjeta_activo": pagos_activos["tarjeta"],
                    "pago_transferencia_activo": pagos_activos["transferencia"],
                    "costos_envio": costos_envio,
                    "paqueterias_disponibles": paqueterias_disponibles,
                    "clip_habilitado": clip_habilitado,
                    "clip_url": clip_url,
                    **redes,
                }
            )
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class PublicLegalView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        tipo_filtro = str(request.query_params.get("tipo", "")).strip().lower()
        try:
            with connection.cursor() as cursor:
                query = """
                    SELECT
                        LOWER(tcl.codigo) AS tipo_codigo,
                        COALESCE(tcl.nombre, tcl.codigo) AS tipo_display,
                        COALESCE(cl.titulo, tcl.nombre, tcl.codigo) AS titulo,
                        COALESCE(cl.cuerpo, '') AS contenido
                    FROM negocio.contenido_legal cl
                    JOIN negocio.tipo_contenido_legal tcl
                        ON tcl.tipo_contenido_legal_id = cl.tipo_contenido_legal_id
                    WHERE cl.activo = TRUE
                """
                params = []
                if tipo_filtro:
                    query += " AND LOWER(tcl.codigo) = %s"
                    params.append(tipo_filtro)
                query += " ORDER BY cl.contenido_legal_id ASC"
                cursor.execute(query, params)
                rows = cursor.fetchall()

            contenidos = [
                {
                    "tipo": row[0],
                    "tipo_display": row[1],
                    "titulo": row[2],
                    "contenido": row[3],
                }
                for row in rows
            ]
            return Response({"ok": True, "contenidos": contenidos})
        except DatabaseError as exc:
            return db_structure_error_response(exc)


class HealthCheckView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"status": "ok"})
