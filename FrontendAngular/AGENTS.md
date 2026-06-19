# frontend/AGENTS.md
# Instrucciones específicas para Codex en Frontend Angular

## Alcance

Aplica a todo lo dentro de `frontend/`.

## Stack

- Angular
- TypeScript
- SCSS
- Guards
- Interceptors
- Services
- Diseño responsive dark-first premium.

## Estructura recomendada

```txt
frontend/src/app/
├── core/
├── shared/
├── data-access/
├── layouts/
└── features/
    ├── public/
    ├── auth/
    ├── client/
    ├── secretary/
    ├── barber/
    └── admin/
```

## Reglas visuales

Usar el estilo premium de la barbería real:

- Verde salvia grisáceo.
- Negro carbón.
- Dorado oro.
- Scroll reveal.
- Microinteracciones.
- Navbar premium.
- Cards elegantes.
- Responsive móvil/tablet/desktop.

## Reglas funcionales

Angular no debe:

- Calcular montos finales.
- Confirmar pagos.
- Modificar inventario.
- Saltar reglas de backend.
- Guardar secretos.
- Guardar CLIP_API_KEY.

Angular sí debe:

- Consumir API.
- Mostrar estados.
- Redirigir a Clip con `checkout_url`.
- Consultar estado de pago.
- Proteger rutas por rol.
- Mostrar estados loading/error/empty.

## Documentación

Después de modificar módulos relevantes, actualizar:

- `frontend/FRONTEND_CONTEXT.md`
- `docs/context/PROJECT_CONTEXT.md` si cambia flujo general.
