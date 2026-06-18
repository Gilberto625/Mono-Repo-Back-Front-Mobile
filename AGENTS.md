# AGENTS.md
# Stylo Barber Connect - Instrucciones para Codex y agentes de desarrollo

## Identidad del proyecto

Proyecto: Stylo Barber Connect  
Empresa: Tony Stylo Barbería  
Stack oficial: Angular + Django REST Framework + PostgreSQL Neon + Flutter.  
Pagos: Clip como procesador de pagos.  
Diseño: dark-first premium, verde salvia grisáceo de la barbería real, negro carbón y dorado oro.

## Regla arquitectónica principal

Django + PostgreSQL son la fuente oficial del negocio.

Angular y Flutter son interfaces de usuario.

Clip solo procesa pagos, genera link, cobra y manda webhook. Clip no controla productos, inventario, citas ni reglas de negocio.

## Estructura esperada

```txt
stylo-barber-connect/
├── backend/
├── frontend/
├── mobile/
├── database/
├── docs/
├── .cursor/
│   └── rules/
├── AGENTS.md
└── README.md
```

## Contexto que debe respetarse

Antes de modificar código, revisar si aplica:

- `docs/context/PROJECT_CONTEXT.md`
- `backend/BACKEND_CONTEXT.md`
- `frontend/FRONTEND_CONTEXT.md`
- `mobile/MOBILE_CONTEXT.md`
- `.cursor/rules/00-master-context-always.mdc`
- `.cursor/rules/23-estilo-premium-barberia-real-animaciones.mdc`

## Reglas de negocio críticas

- Primera cita sin anticipo.
- Cliente con inasistencia: siguientes 10 citas requieren anticipo del 50%.
- Alta demanda: viernes, sábado y domingo.
- Anticipación alta demanda: 3 días.
- Anticipación baja/media: 1 día.
- Cancelación alta demanda: 2 días.
- Cancelación baja/media: 1 día.
- Tolerancia: 5 a 10 minutos.
- Anticipo no reembolsable por inasistencia.
- Si el cliente asiste, el anticipo se descuenta del total.

## Reglas de Clip

- El frontend no calcula montos finales.
- El frontend no confirma pagos.
- Django crea el link de pago.
- Django guarda `payment_request_id`.
- Django recibe webhook.
- Django procesa webhook de forma idempotente.
- Django actualiza cita, pedido, inventario, notificaciones, reportes y auditoría.
- Guardar `receipt_no` cuando Clip lo entregue.
- No usar productos de Clip como catálogo oficial.
- Los productos oficiales viven en PostgreSQL.

## Reglas de backend

- No poner lógica de negocio compleja en views.
- Usar services, selectors, serializers y permissions.
- Usar transacciones en operaciones críticas.
- Validar permisos por rol y por objeto.
- Evitar IDOR.
- Auditar acciones críticas.
- No confiar en datos del frontend.
- No exponer secretos ni errores técnicos.

## Reglas de Angular

- Usar arquitectura por features.
- Usar core, shared, data-access, layouts y features.
- Usar guards por rol.
- Usar interceptors para JWT y errores.
- Usar estilo premium dark-first.
- Usar tokens de color del proyecto.
- No calcular montos finales.
- No confirmar pagos.
- No modificar inventario.

## Reglas de Flutter

- Consumir la misma API que Angular.
- Guardar tokens en secure storage.
- No guardar secretos.
- Mantener tema visual equivalente.
- Abrir pagos Clip con URL externa.
- Consultar estado de pago en Django.
- No duplicar lógica crítica.

## Estilo visual

Paleta oficial:

```txt
#070908 negro carbón
#0D1110 negro suave
#739177 verde pared claro
#637F6E verde pared medio
#5F7B6B verde principal
#485846 verde sombra
#2F3A31 verde profundo
#D4AF37 dorado oro
#F0CC55 dorado suave
#F5F5F0 texto claro
#BAC2B7 texto secundario
```

La interfaz debe ser premium, dark-first, responsive, con scroll reveal, microinteracciones, cards elegantes, bordes dorados sutiles y verde salvia como identidad atmosférica.

## Comportamiento esperado del agente

Antes de programar:

1. Identificar el módulo.
2. Identificar rol afectado.
3. Identificar reglas de negocio.
4. Identificar si debe cambiar backend, frontend o Flutter.
5. Validar permisos.
6. Validar seguridad.
7. Mantener documentación contextual actualizada.
8. No generar código genérico.
