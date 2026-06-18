# PROJECT_CONTEXT.md
# Contexto vivo del proyecto Stylo Barber Connect

## Estado general

Este archivo debe actualizarse conforme avance el desarrollo para que Cursor, Codex y cualquier agente de código tengan contexto actualizado del proyecto.

## Stack oficial

- Backend: Django REST Framework.
- Frontend web: Angular.
- Mobile: Flutter.
- Base de datos: PostgreSQL Neon.
- Pagos: Clip.
- Correo: Brevo.
- Push: Firebase.
- Archivos: Cloudinary/S3.
- Mapas: Google Maps.
- Comunicación: WhatsApp.
- Voz futura: Alexa.

## Arquitectura

```txt
Angular Web      Flutter Mobile
      |                |
      +-------+--------+
              |
              v
      Django REST Framework
              |
              v
        PostgreSQL Neon
```

## Módulos del sistema

- Auth.
- Usuarios y roles.
- Servicios.
- Barberos.
- Citas y agenda.
- Pagos Clip.
- Productos.
- Inventario.
- Pedidos.
- Ventas.
- Notificaciones.
- Reportes.
- Configuración.
- Apariencia.
- Legal.
- Auditoría.
- Flutter móvil.

## Estado de implementación

> Actualizar esta tabla durante el desarrollo.

| Módulo | Backend | Angular | Flutter | Estado | Notas |
|---|---|---|---|---|---|
| Auth | Pendiente | Pendiente | Pendiente | Pendiente |  |
| Citas | Pendiente | Pendiente | Pendiente | Pendiente |  |
| Clip | Pendiente | Pendiente | Pendiente | Pendiente |  |
| Productos | Pendiente | Pendiente | Pendiente | Pendiente |  |
| Inventario | Pendiente | Pendiente | N/A | Pendiente |  |
| Pedidos | Pendiente | Pendiente | Pendiente | Pendiente |  |
| Reportes | Pendiente | Pendiente | Parcial | Pendiente |  |

## Decisiones vigentes

- PostgreSQL + Django son la fuente oficial del negocio.
- Angular y Flutter no conectan directo a PostgreSQL.
- Clip solo procesa pagos.
- Productos oficiales viven en Stylo Barber Connect.
- Inventario oficial vive en PostgreSQL.
- La estética visual se basa en verde salvia grisáceo + negro carbón + dorado.

## Próximos pendientes

- Definir estructura real de carpetas.
- Implementar auth.
- Implementar servicios.
- Implementar citas.
- Implementar Clip.
- Implementar productos/inventario.
- Implementar Flutter inicial.

## Registro de cambios

| Fecha | Cambio | Responsable |
|---|---|---|
| Pendiente | Crear estructura inicial | Equipo |
