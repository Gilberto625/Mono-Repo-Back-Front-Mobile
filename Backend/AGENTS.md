# backend/AGENTS.md
# Instrucciones específicas para Codex en Backend Django

## Alcance

Aplica a todo lo dentro de `backend/`.

## Stack

- Python 3.12+
- Django
- Django REST Framework
- PostgreSQL Neon
- JWT
- RBAC
- Integraciones externas: Clip, Brevo, Firebase, Cloudinary/S3, Google Maps, WhatsApp, Alexa futura.

## Arquitectura backend

Usar esta separación:

```txt
apps/
├── accounts/
├── users/
├── employees/
├── services/
├── appointments/
├── payments/
├── products/
├── inventory/
├── orders/
├── sales/
├── notifications/
├── reports/
├── business_settings/
├── appearance/
├── legal/
├── audit/
└── integrations/
```

## Reglas obligatorias

- Views delgadas.
- Lógica de negocio en services.
- Consultas complejas en selectors.
- Validación en serializers y validators.
- Permisos en permissions.
- Acciones críticas con `transaction.atomic()`.
- Bloqueo de registros con `select_for_update()` cuando aplique.
- No aceptar montos finales desde frontend.
- No confirmar pagos desde frontend.
- No modificar stock directo.
- No cambiar estados sin historial.
- Auditar acciones críticas.

## Clip

El backend crea pagos Clip para:

- Anticipos de citas.
- Pedidos.
- Ventas si aplica.

Debe guardar:

- `payment_request_id`
- `receipt_no`
- `checkout_url`
- `monto`
- `estado`
- `referencia_tipo`
- `referencia_id`

## Documentación

Después de modificar módulos relevantes, actualizar:

- `backend/BACKEND_CONTEXT.md`
- `docs/context/PROJECT_CONTEXT.md` si cambia arquitectura general.
