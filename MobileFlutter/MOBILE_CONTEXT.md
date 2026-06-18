# MOBILE_CONTEXT.md
# Contexto vivo de Flutter

## Propósito

Mantener documentado el estado actual de la app móvil Flutter para Cursor, Codex y desarrolladores.

## Arquitectura esperada

```txt
mobile/lib/
├── app/
├── core/
├── shared/
└── features/
```

## Features esperadas

| Feature | Estado | Notas |
|---|---|---|
| auth | Pendiente | Login/registro |
| client_home | Pendiente | Home cliente |
| appointments | Pendiente | Agendado y mis citas |
| products | Pendiente | Catálogo |
| orders | Pendiente | Pedidos |
| payments | Pendiente | Abrir Clip |
| notifications | Pendiente | Notificaciones |
| profile | Pendiente | Perfil |

## Reglas

- Consumir API Django.
- Usar secure storage.
- No guardar secretos.
- No calcular montos finales.
- No confirmar pagos.
- Mantener estilo visual equivalente a Angular.

## Cambios recientes

| Fecha | Cambio | Nota |
|---|---|---|
| Pendiente | Inicializar Flutter |  |
