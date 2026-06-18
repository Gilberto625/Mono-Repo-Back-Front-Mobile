# mobile/AGENTS.md
# Instrucciones específicas para Codex en Flutter

## Alcance

Aplica a todo lo dentro de `mobile/`.

## Stack

- Flutter
- Dart
- API Django REST
- Secure storage
- url_launcher para abrir pagos Clip
- Tema visual equivalente a Angular.

## Estructura recomendada

```txt
mobile/lib/
├── app/
├── core/
├── shared/
└── features/
    ├── auth/
    ├── client/
    ├── appointments/
    ├── products/
    ├── orders/
    ├── payments/
    ├── notifications/
    └── profile/
```

## Reglas

Flutter no debe:

- Guardar secretos.
- Guardar CLIP_API_KEY.
- Confirmar pagos.
- Calcular montos finales.
- Modificar inventario.
- Duplicar reglas críticas del backend.

Flutter sí debe:

- Consumir API Django.
- Guardar tokens en secure storage.
- Abrir `checkout_url` de Clip con url_launcher.
- Consultar estado de pago en Django.
- Mantener diseño dark-first premium.
- Usar widgets reutilizables.

## Documentación

Después de modificar módulos relevantes, actualizar:

- `mobile/MOBILE_CONTEXT.md`
- `docs/context/PROJECT_CONTEXT.md` si cambia flujo general.
