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
| 2026-06-18 | Fase 1 crítica de seguridad | DRF autenticado por defecto, RBAC reutilizable, configuración por entorno y OTP fuera de respuestas. |
| 2026-06-18 | Citas autoritativas | Precio, promoción, duración, anticipo, penalización y anticipación se calculan en Django; creación atómica con bloqueo por barbero. |
| 2026-06-18 | Endurecimiento Clip | Monto y referencia internos, estados aprobados explícitos, firma obligatoria, control de monto e idempotencia por transacción. |
| 2026-06-18 | Uploads seguros | Solo JPG/PNG/WebP validados por extensión, MIME y firma; SVG y fuentes remotas/base64 rechazados. |
| 2026-06-18 | Fase 1.1 crítica | Confirmación Clip centralizada, idempotencia por referencia/identidad/monto, conciliación directo-webhook y respuestas técnicas saneadas. |
| 2026-06-18 | Fase 1.2 pruebas críticas | 23 pruebas aisladas cubren settings seguros, OTP, RBAC/IDOR, reglas de citas, revalidación de horario, idempotencia Clip y errores genéricos. |
| Pendiente | Inicializar backend |  |

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
