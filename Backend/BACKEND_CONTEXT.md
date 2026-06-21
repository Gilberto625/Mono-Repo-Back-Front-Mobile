# BACKEND_CONTEXT.md
# Contexto vivo del backend Django

## Propósito

Mantener documentado el estado actual del backend para Cursor, Codex y desarrolladores.

## Arquitectura esperada

- Django REST Framework.
- Apps por dominio.
- Services para lógica.
- Selectors para consultas.
- Serializers para contratos.
- Permissions para roles.
- Validators para reglas.
- PostgreSQL Neon.

## Apps esperadas

| App | Estado | Notas |
|---|---|---|
| accounts | Pendiente | Login, JWT, refresh |
| users | Pendiente | Usuarios y perfiles |
| appointments | Pendiente | Citas y agenda |
| payments | Pendiente | Clip y pagos externos |
| products | Pendiente | Productos |
| inventory | Pendiente | Stock y movimientos |
| orders | Pendiente | Pedidos |
| reports | Pendiente | Dashboard |
| audit | Pendiente | Bitácora |
| integrations | Pendiente | Brevo, Firebase, etc. |

## Endpoints importantes

```txt
/api/v1/auth/
/api/v1/client/appointments/
/api/v1/client/payments/clip/create/
/api/v1/client/payments/{id}/status/
/api/v1/webhooks/clip/
/api/v1/admin/products/
/api/v1/admin/inventory/
```

## Reglas críticas

- No lógica pesada en views.
- No monto final desde frontend.
- No stock directo.
- No estado sin historial.
- No webhook sin idempotencia.
- No acción crítica sin auditoría.

## Cambios recientes

| Fecha | Cambio | Nota |
|---|---|---|
| 2026-06-19 | Fase 2.5 Clip diagnóstico + CI | diagnose_clip_staging.py; 502 por credenciales Clip faltantes; workflow CI. |
| 2026-06-19 | Fase 2.4 limpieza repo + E2E guards | pycache fuera de Git, E2E_STAGING_PASSWORD, suite 20/20. |
| 2026-06-19 | Fase 2.3 E2E Neon staging | Diagnóstico esquema `negocio` OK; seed idempotente; scripts E2E. |
| 2026-06-18 | Fase 1 crítica de seguridad | DRF autenticado por defecto, RBAC reutilizable, configuración por entorno y OTP fuera de respuestas. |
| 2026-06-18 | Citas autoritativas | Precio, promoción, duración, anticipo, penalización y anticipación se calculan en Django; creación atómica con bloqueo por barbero. |
| 2026-06-18 | Endurecimiento Clip | Monto y referencia internos, estados aprobados explícitos, firma obligatoria, control de monto e idempotencia por transacción. |
| 2026-06-18 | Uploads seguros | Solo JPG/PNG/WebP validados por extensión, MIME y firma; SVG y fuentes remotas/base64 rechazados. |
| 2026-06-18 | Fase 1.1 crítica | Confirmación Clip centralizada, idempotencia por referencia/identidad/monto, conciliación directo-webhook y respuestas técnicas saneadas. |
| 2026-06-18 | Fase 1.2 pruebas críticas | 23 pruebas aisladas cubren settings seguros, OTP, RBAC/IDOR, reglas de citas, revalidación de horario, idempotencia Clip y errores genéricos. |
| Pendiente | Inicializar backend |  |

### Fase 2.5 — Clip diagnóstico + CI (2026-06-19)

**Script:** `scripts/diagnose_clip_staging.py` — reporta presencia de variables Clip sin valores.

**Diagnóstico 502 Clip:**

| Variable | Estado |
| -------- | ------ |
| `CLIP_API_KEY` | MISSING |
| `CLIP_API_SECRET` | MISSING |
| `CLIP_AUTH_TOKEN` | SET (insuficiente solo para checkout URL) |
| `CLIP_API_BASE_URL` | SET |
| `CLIP_WEBHOOK_SECRET` | SET |
| DB `clip_habilitado` | True |
| DB credenciales Clip | MISSING |
| OAuth | SKIPPED (sin key/secret) |

**Causa probable:** backend no puede autenticarse con Clip para crear `paymentrequest`; Clip devuelve error → 502 controlado.

**Sin cambios** en `core/views.py`. `.env.example` documenta `CLIP_API_KEY`/`CLIP_API_SECRET` para staging.

**CI:** `.github/workflows/ci.yml` — Python 3.12 + Node 20; `USE_LOCAL_DB=True` en CI para tests unitarios.

## Estado y límites después de Fase 1

- El backend continúa monolítico en `core`; la separación por dominios queda para una fase posterior.
- `negocio.pago_externo` se utiliza de forma compatible únicamente si ya existe con las columnas mínimas esperadas. El esquema actual no tiene migración Django formal para esa tabla; mientras tanto, la referencia, monto esperado, `payment_request_id`, `receipt_no` y estado se conservan también en notas estructuradas de cita/pedido.
- La exclusión absoluta de solapamientos aún no está garantizada por una restricción PostgreSQL. La creación bloquea al empleado y revalida la agenda dentro de la misma transacción, reduciendo el riesgo en este monolito.
- Las reglas de cancelación se exponen como fecha límite calculada (2 días en viernes-domingo, 1 día en demanda baja/media). No existe todavía un flujo cliente de cancelación que requiera aplicar esa validación.
- El webhook Clip queda deshabilitado de forma segura hasta configurar `CLIP_WEBHOOK_SECRET`; los eventos sin firma válida se rechazan.
- Solo puede existir un intento Clip activo por cita o pedido. Los reintentos devuelven el enlace vigente o un conflicto seguro; los intentos directos fallidos se cierran explícitamente.
- `CLIP_PAGO_CONFIRMADO` es el marcador canónico. Reintentos con la misma identidad son idempotentes; identidades o montos divergentes quedan marcados como `CLIP_PAGO_INCONSISTENTE` sin reaplicar anticipo, estado ni inventario.
- Pago directo y webhook usan la misma operación transaccional. Si Clip omite el monto, solo se confirma cuando coincide una referencia o `payment_request_id` confiable; de lo contrario queda pendiente de conciliación.
- Variables mínimas documentadas en `.env.example`: `SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS`, `DATABASE_URL` y `CLIP_WEBHOOK_SECRET`.

## Cobertura automatizada Fase 1.2

- Las pruebas unitarias viven en `tests/` y usan `SimpleTestCase`, cursores simulados y mocks; no llaman Clip, Cloudinary ni Neon.
- Se verifica que los montos enviados por cliente no sustituyan precio, descuento o anticipo calculados por Django.
- Se cubren primera cita, penalización de diez citas, anticipo del 50 %, anticipación por demanda y revalidación final contra doble reserva.
- Se cubren estados Clip permitidos, monto divergente, identidad confiable cuando falta monto, conciliación directo-webhook e idempotencia de webhook repetido.
- Queda pendiente una suite de integración sobre PostgreSQL temporal con el esquema `negocio` real para validar SQL, bloqueos concurrentes y restricciones de base de datos.
- Queda pendiente una prueba de contrato contra Clip sandbox/staging; las pruebas actuales no dependen de la API real.

## Fase 2.3 — E2E Neon staging controlado (2026-06-19)

### Diagnóstico 503/500

| Síntoma | Causa raíz | Corrección |
| ------- | ---------- | ---------- |
| `GET /api/public/servicios/` → 503 | `USE_LOCAL_DB=True` (SQLite sin esquema `negocio`) | Usar Neon staging con `USE_LOCAL_DB=False` |
| `GET /api/public/servicios/` → 503 en Neon (Fase 2.1) | No reproducido en Fase 2.3; esquema y tablas OK | Ninguna en código |
| `POST /api/login/` inválido → 500 (Fase 2.1) | No reproducido en Neon Fase 2.3; responde **401** | Ninguna en código |
| `POST /api/login/` cliente en SQLite → 500 | Ruta 2FA intenta escribir en `negocio.codigo_verificacion` inexistente | No usar SQLite para E2E de negocio |

### Entorno validado

- `USE_LOCAL_DB=False`, motor PostgreSQL, esquema `negocio` presente.
- Tablas críticas verificadas: `usuario`, `rol`, `usuario_rol`, `servicio`, `empleado`, `cita`, `producto`, `inventario_existencia`, `codigo_verificacion`.
- Catálogo público: **200** con datos existentes + seed E2E.

### Seed E2E (idempotente, sin borrar datos)

Comando: `python manage.py seed_e2e_staging` (`--dry-run` disponible).

| Recurso | Username / nombre |
| ------- | ----------------- |
| Admin | `e2e_admin_stylo` |
| Cliente | `e2e_cliente_stylo` (`verificacion_2fa=false`) |
| Barbero | `e2e_barbero_stylo` |
| Servicio | `E2E_TEST Corte Básico` |
| Producto | `E2E_TEST Pomada` (+ stock mínimo en `inventario_existencia`) |

Password de prueba: variable `E2E_STAGING_PASSWORD` (ver `.env.example`); fallback solo staging en el comando.

### Fase 2.4 — Limpieza repo (2026-06-19)

**Auditoría commit `ddb10f4`:** archivos legítimos únicamente (scripts E2E + docs). Sin `db.sqlite3`, `.env`, `node_modules`, `dist`, `.tools`.

**Artefactos indebidos preexistentes en el repo:**

* ~50 archivos `Backend/**/__pycache__/*.pyc` rastreados → `git rm --cached` (archivos locales conservados).
* `.gitignore` reforzado en Backend y FrontendAngular.

**Seed E2E:** password desde `E2E_STAGING_PASSWORD` (`decouple`), documentada en `.env.example`.

**E2E suite ampliada:** guards API (cliente 403 en admin/secretaria), 20/20 pruebas OK en Neon staging.

**Sin cambios** en `core/views.py`.

### Scripts auxiliares (read-only o controlados)

| Archivo | Uso |
| ------- | --- |
| `scripts/diagnose_neon_staging.py` | Esquema, tablas, conteos, usuarios E2E |
| `scripts/e2e_api_staging.py` | Suite HTTP contra `http://127.0.0.1:8000/api` |
| `bootstrap/management/commands/seed_e2e_staging.py` | Seed mínimo idempotente |

### Resultados E2E API (Neon staging)

| Endpoint | Status | Notas |
| -------- | ------ | ----- |
| `GET /api/health/` | 200 | OK |
| `GET /api/public/servicios/` | 200 | OK |
| `GET /api/public/productos/` | 200 | OK |
| `POST /api/login/` inválido | 401 | OK |
| `POST /api/login/` `e2e_admin_stylo` | 200 | JWT |
| `POST /api/login/` `e2e_cliente_stylo` | 200 | Sin 2FA |
| `POST /api/citas/` | 201 | Totales calculados en backend |
| `POST /api/pedidos/crear/` | 200 | `total` devuelto por backend (ej. 99.0) |
| `POST /api/pagos/clip/intentar/` | 502 | Clip no generó URL; sin pago real |

### Cambios de código Fase 2.3

- **Sin cambios** en `core/views.py`, `public_views.py` ni lógica de negocio.
- Solo herramientas de seed/diagnóstico/E2E y documentación.

### Riesgos pendientes

- Rotar secretos expuestos (Neon, Firebase, Brevo, Cloudinary, Datadog, Clip).
- **Clip staging:** configurar `CLIP_API_KEY` + `CLIP_API_SECRET` sandbox para obtener `checkout_url` https.
- Datos `E2E_TEST_*` en Neon staging: no ejecutar limpiezas masivas.
- Playwright E2E Neon en CI pendiente (job comentado en workflow).
