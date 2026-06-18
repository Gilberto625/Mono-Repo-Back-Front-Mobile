# Reporte de cobertura MDC — Stylo Barber Connect

## Archivos analizados
- Documentos Word del proyecto: 22
- Reglas MDC originales: 8

## Problemas encontrados en MDC originales
- `index.mdc` tenía contexto general, pero no cubría reglas fuertes de negocio ni Clip.
- `angular.mdc` era útil, pero no cubría landing, roles completos, pagos, notificaciones, configuración, legal ni Flutter.
- `django.mdc` tenía estructura antigua y no cubría apps reales del proyecto ni services/selectors.
- `base_datos.mdc` no reflejaba completamente los esquemas `private`, `negocio`, `stg`, `rpt` ni tablas reales.
- `seguridad.mdc` no cubría Clip, Flutter, webhooks, secretos e idempotencia con detalle.
- No existía regla específica de Flutter.
- No existía regla específica de Clip.
- No existía regla específica de módulos por rol.
- No existía regla específica de landing y apariencia administrable.

## Cobertura generada
- Angular web responsive.
- Flutter mobile.
- Django REST Framework.
- PostgreSQL Neon.
- Landing pública.
- Navbar.
- Roles admin/secretaria/barbero/cliente.
- Citas y agenda.
- Productos, inventario, pedidos y ventas.
- Pagos Clip.
- Notificaciones e integraciones.
- Configuración, apariencia y legal.
- Auditoría.
- QA y despliegue.
- Workflows para Cursor.

## Recomendación
Usar estos archivos como reemplazo de los MDC actuales. Si prefieres conservar nombres antiguos, puedes copiar el contenido nuevo sobre los archivos existentes o mantener ambos, pero evita reglas duplicadas contradictorias.


## Nueva cobertura agregada

### 23-estilo-premium-barberia-real-animaciones.mdc

Cubre:

- Estilo premium inspirado en barbería real.
- Paleta #739177, #637F6E, #5F7B6B, #485846, #2F3A31, #070908, #D4AF37.
- Animaciones suaves.
- Scroll reveal.
- Aparición de imágenes.
- Hover premium.
- Cards, navbar, landing, agendado y galería.
- Panel administrador.
- Panel secretaria.
- Panel barbero.
- Panel cliente.
- Equivalente visual para Flutter.
- Checklist visual para aceptar pantallas generadas por Cursor.


## Regla maestra global

### 00-master-context-always.mdc

Cubre:

- Identidad global del proyecto.
- Arquitectura Angular + Django + PostgreSQL + Flutter.
- Reglas de negocio críticas.
- Pagos Clip.
- Estilo premium real.
- Roles.
- Seguridad.
- Auditoría.
- Base de datos.
- Activación conceptual de reglas especializadas.

Esta regla debe permanecer pequeña y global para no saturar el contexto de Cursor.
