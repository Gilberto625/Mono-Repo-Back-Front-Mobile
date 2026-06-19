# FRONTEND_CONTEXT.md

# Contexto vivo del frontend Angular

## Propósito

Mantener documentado el estado actual del frontend Angular para Cursor, Codex y desarrolladores.

## Estado actual

Angular Fase 1 crítica, **Fase 2.0 (toolchain)**, **Fase 2.1 (integración API — parcial)**, **Fase 2.2 (E2E SQLite — parcial)**, **Fase 2.3 (E2E Neon staging)** y **Fase 2.4 (limpieza repo + E2E UI/API + API_ENDPOINTS)** fueron aplicadas.

### Fase 1 — seguridad e integración crítica

Objetivos cerrados:

* XSS corregido en ModalService.
* Legal, sidebar y main.ts ya no insertan HTML dinámico inseguro.
* TokenService creado como punto central de lectura/escritura JWT.
* auth.interceptor.ts usa TokenService.
* API_ENDPOINTS creado para centralizar rutas críticas.
* auth.service.ts ya no llama endpoints inexistentes de seguridad/TOTP/backup codes cuando backend no los expone.
* Flujo de creación de cita (agendar-cita → admin.service.createCita) ya no envía precio_total, descuento, anticipo_monto, porcentaje, penalizada ni modo_cobro como verdad final.
* cita.service.ts centraliza GET de mis-citas y dashboard-stats; cliente-dashboard y mis-citas consumen el servicio sin leer tokens directamente.
* pedido.service.ts ya no envía total final como autoridad de negocio en crear pedido.
* checkout.component.ts valida estado_pago antes de mostrar éxito de pago Clip.
* agendar-cita.component.ts usa montos del backend o valores claramente informativos en UI.

### Fase 2.0 — estabilización de toolchain

Objetivos cerrados:

* Node **20.19.0 LTS** fijado en `.nvmrc` y `.node-version`.
* `package.json` declara `engines`: Node `>=20.9.0 <21`, npm `>=10 <11`.
* `package-lock.json` regenerado con **Node 20.19.0 / npm 10.8.2** (no con Node 24/npm 11).
* `npm ci` validado en instalación limpia (sin `node_modules` previo).
* `npm run build` validado tras `npm ci`.
* `.tools/` ignorado en Git (Node portable local opcional; no commitear).

**Nota de entorno:** el sistema global puede seguir en Node 24; para este proyecto usar Node 20 vía nvm/fnm o `.nvmrc` antes de `npm ci` / `npm install`.

### Fase 2.1 — integración API (parcial)

Objetivos cerrados en código:

* `API_ENDPOINTS` ampliado: auth, client, public, orders, promotions, payments, admin (más usadas), secretaria.
* Helpers: `apiEndpoint()`, `apiEndpointWithQuery()`, `publicServiceDetailPath()`.
* Servicios migrados a `API_ENDPOINTS`: `auth.service`, `cita.service`, `pedido.service`, `servicio.service`, `producto.service`, `logo.service`, rutas cliente en `admin.service`.
* `environment.ts` alineado a `http://127.0.0.1:8000/api` (igual que development).
* `security-dashboard` muestra mensaje “Próximamente” ante HTTP 501 (TOTP/seguridad no expuesto).

Pruebas manuales HTTP (backend local, `USE_LOCAL_DB=False` → Neon):

| Flujo | Resultado | Notas |
| ----- | --------- | ----- |
| `GET /api/health/` | 200 OK | Backend responde |
| `GET /api/public/servicios/` | 503 | Catálogo no disponible (probable fallo DB/Neon) |
| `GET /api/public/productos/` | No probado (mismo contexto 503) | Pendiente con DB estable |
| `POST /api/login/` (credencial inválida) | 500 | Requiere revisión backend; no se usaron credenciales reales |
| `GET /api/mis-citas/` sin token | 401 OK | Protección backend correcta |
| Crear cita / pedido / Clip | **No ejecutado** | Neon sensible; requiere confirmación o `USE_LOCAL_DB=True` |
| Login UI / refresh / rol | **No ejecutado E2E** | Pendiente con credenciales de prueba y DB estable |

Build post-cambios: `npm run build` OK (Node 20.19.0).

### Fase 2.2 — E2E con entorno seguro (parcial)

**Entorno usado:** `USE_LOCAL_DB=True` vía variable de entorno (sin modificar `Backend/.env`). Base SQLite local (`Backend/db.sqlite3`). Django en `http://127.0.0.1:8001`. **No se escribió en Neon productivo.**

**Preparación backend:**

| Comando | Resultado |
| ------- | --------- |
| `python manage.py check` | 0 issues |
| `python manage.py test` | 23 OK, 1 skipped |
| `python manage.py migrate` (SQLite) | OK |
| `python manage.py runserver 127.0.0.1:8001` | OK |

Usuarios E2E creados solo en SQLite local (no Neon): `e2e_admin`, `e2e_cliente` (password de prueba documentada en sesión de desarrollo, no en repo).

**Preparación frontend (Node 20.19.0 / npm 10.8.2):**

| Comando | Resultado |
| ------- | --------- |
| `npm ci` | OK |
| `npm run build` | OK (exit 0, ~193 s) |

**Limitación arquitectónica:** `USE_LOCAL_DB=True` activa SQLite con tablas Django (`auth`, `sessions`). El negocio vive en esquema PostgreSQL `negocio.*` (consultas raw en vistas públicas y cliente). Sin ese esquema, catálogo, citas, pedidos y login cliente con 2FA fallan aunque auth básico funcione.

**Pruebas HTTP E2E (SQLite, puerto 8001):**

| # | Flujo | Método | Endpoint | Status | Notas |
| - | ----- | ------ | -------- | ------ | ----- |
| 1 | Health | GET | `/api/health/` | **200** | OK |
| 2 | Catálogo servicios | GET | `/api/public/servicios/` | **503** | Estructura `negocio` no disponible en SQLite |
| 3 | Catálogo productos | GET | `/api/public/productos/` | **503** | Misma causa |
| 4 | Login inválido | POST | `/api/login/` | **401** | Correcto (vs 500 observado en Fase 2.1 contra Neon) |
| 5 | Login admin prueba | POST | `/api/login/` | **200** | Tokens JWT; `rol: admin` |
| 6 | Refresh token | POST | `/api/auth/token/refresh/` | **200** | Nuevo access |
| 7 | Mis citas sin token | GET | `/api/mis-citas/` | **401** | Protección correcta |
| 8 | Mis citas con token admin | GET | `/api/mis-citas/` | **500** | Falta esquema `negocio` |
| 9 | Dashboard stats | GET | `/api/dashboard-stats/` | **500** | Falta esquema `negocio` |
| 10 | Login cliente prueba | POST | `/api/login/` | **500** | Ruta 2FA intenta `negocio.codigo_verificacion` |

**Re-verificación Neon (solo lectura, puerto 8000, sin escrituras):**

| Flujo | Status | Notas |
| ----- | ------ | ----- |
| `POST /api/login/` credencial inválida | **401** | Mejoró respecto a 500 en Fase 2.1 (posible estado transitorio previo) |
| `GET /api/health/` | **200** | Backend Neon accesible |

**Flujos no ejecutados E2E (bloqueados por DB):**

| Flujo | Motivo |
| ----- | ------ |
| Crear cita | Catálogo 503; sin barberos/servicios en SQLite |
| Crear pedido | Catálogo productos 503 |
| Checkout / Clip intent | Requiere cita o pedido creado |
| Login UI cliente + guards en navegador | Login cliente 500 en SQLite (2FA → `negocio`) |

**Verificación estática de contratos Angular (código, sin POST real):**

| Área | Resultado |
| ---- | --------- |
| Payload crear cita | Solo `barbero_id`, `servicio_id`, `fecha`, `hora`, `comprobante_pago`, `codigo_descuento`, `notas` |
| Payload crear pedido | Solo `items`, `metodo_entrega`, `metodo_pago`, dirección/código/notas; sin `subtotal`/`total` en POST |
| Clip | `clipIntentarPago` sin monto; valida `https:` en `checkout_url`; éxito UI solo con `estado_pago` confirmado |
| TokenService + interceptor | JWT centralizado; `Authorization` en peticiones autenticadas |
| Guards (`app.routes.ts`) | `authGuard`, `clienteGuard`, `secretariaGuard`, `barberoGuard`, `adminGuard` configurados |
| XSS | Sin `innerHTML` / `bypassSecurityTrustHtml` en `.ts` del app |

**Errores backend reportados (sin corregir — requiere confirmación):**

1. **503** `GET /api/public/servicios/` y `/api/public/productos/` con SQLite: falta esquema `negocio` (esperado en `USE_LOCAL_DB=True`).
2. **500** `POST /api/login/` usuario cliente en SQLite: `_save_login_otp` / tablas `negocio.*` inexistentes.
3. **500** endpoints cliente (`mis-citas`, `dashboard-stats`) en SQLite: dependen de `negocio.*`.
4. **503** catálogo en Neon (Fase 2.1): revisar conectividad o migración de esquema `negocio` en PostgreSQL.

**Correcciones realizadas en Fase 2.2:** ninguna en código Angular ni Backend. Solo documentación en este archivo.

### Fase 2.3 — E2E Neon staging controlado

**Entorno:** Neon PostgreSQL staging (`USE_LOCAL_DB=False`). Django `http://127.0.0.1:8000`. Sin operaciones destructivas (sin DROP/TRUNCATE/DELETE masivo).

**Diagnóstico Fase A (sin modificar datos existentes):**

| Endpoint | Status | Causa / hallazgo |
| -------- | ------ | -------------- |
| `GET /api/public/servicios/` | **200** | Esquema `negocio` OK en Neon; 503 de Fase 2.1/2.2 era por SQLite (`USE_LOCAL_DB=True`) |
| `GET /api/public/productos/` | **200** | Igual |
| `POST /api/login/` inválido | **401** | Comportamiento correcto en Neon (no reproducible el 500 de Fase 2.1) |
| Esquema `negocio` | **OK** | Presente |
| Tablas críticas | **OK** | usuario, rol, usuario_rol, servicio, empleado, cita, producto, inventario_existencia, codigo_verificacion |
| Datos mínimos previos | **OK** | 15 servicios activos, 3 barberos, 19 productos; sin usuarios `e2e_*` hasta seed |

**Fase B (corrección backend):** no requirió cambios. Catálogo y login inválido ya responden correctamente en Neon.

**Fase C — Seed mínimo autorizado** (`python manage.py seed_e2e_staging`):

| Recurso | Identificador |
| ------- | ------------- |
| Admin | `e2e_admin_stylo` |
| Cliente | `e2e_cliente_stylo` (2FA deshabilitado para E2E) |
| Barbero | `e2e_barbero_stylo` + horario + `barbero_servicio` |
| Servicio | `E2E_TEST Corte Básico` (id 16) |
| Producto | `E2E_TEST Pomada` (id 21, stock 10) |

Password de prueba documentada en `Backend/bootstrap/management/commands/seed_e2e_staging.py` (no en `.env`).

**Pruebas E2E HTTP (Neon staging):**

| # | Flujo | Método | Endpoint | Status | Notas |
| - | ----- | ------ | -------- | ------ | ----- |
| 1 | Health | GET | `/api/health/` | **200** | OK |
| 2 | Catálogo servicios | GET | `/api/public/servicios/` | **200** | Incluye `E2E_TEST Corte Básico` |
| 3 | Catálogo productos | GET | `/api/public/productos/` | **200** | Incluye `E2E_TEST Pomada` |
| 4 | Login inválido | POST | `/api/login/` | **401** | OK |
| 5 | Login admin | POST | `/api/login/` | **200** | JWT; `rol: admin` |
| 6 | Login cliente | POST | `/api/login/` | **200** | `requires2fa: false` |
| 7 | Refresh | POST | `/api/auth/token/refresh/` | **200** | OK |
| 8 | Mis citas sin token | GET | `/api/mis-citas/` | **401** | OK |
| 9 | Mis citas cliente | GET | `/api/mis-citas/` | **200** | OK |
| 10 | Barberos | GET | `/api/barberos/` | **200** | `e2e_barbero_stylo` disponible |
| 11 | Disponibilidad | GET | `/api/disponibilidad/` | **200** | 32 slots |
| 12 | Crear cita | POST | `/api/citas/` | **201** | Payload sin montos; backend devuelve totales |
| 13 | Crear pedido | POST | `/api/pedidos/crear/` | **200** | Payload sin `total`/`subtotal`; backend: `total: 99.0` |
| 14 | Clip intent | POST | `/api/pagos/clip/intentar/` | **502** | Sin pago real; Clip no generó URL (credenciales/config staging) |
| 15 | Dashboard admin | GET | `/api/dashboard-stats/` | **200** | OK |

**Contratos Angular verificados en E2E:**

* Cita POST: solo campos permitidos (sin `precio_total`, `anticipo_monto`, etc.).
* Pedido POST: `metodo_entrega: recoger_local` (como `checkout.component.ts`); sin `total`/`subtotal` en request.
* Clip: payload sin monto; no se confirmó pago en frontend.

**Guards (revisión estática + prueba manual UI parcial):**

* `authGuard`, `clienteGuard`, `secretariaGuard`, `barberoGuard`, `adminGuard` en `app.routes.ts`.
* Cliente autenticado recibe 403 en `/api/admin/dashboard/` y `/api/admin/empleados/` (esperado).

**Toolchain Fase 2.3:**

| Comando | Resultado |
| ------- | --------- |
| `python manage.py check` | 0 issues |
| `python manage.py test` | 23 OK, 1 skipped |
| `npm ci` | **EPERM** en Windows (`esbuild.exe` en uso); `node_modules` parcialmente corrupto |
| `npm run build` | **Bloqueado** por `ng` ausente tras EPERM; build OK en Fase 2.0/2.2 con Node 20.19.0 |

**Scripts E2E backend (no Angular):**

* `Backend/scripts/diagnose_neon_staging.py` — diagnóstico read-only esquema/datos.
* `Backend/scripts/e2e_api_staging.py` — suite HTTP controlada.
* `Backend/bootstrap/management/commands/seed_e2e_staging.py` — seed idempotente.

### Fase 2.4 — Limpieza repo + E2E UI/API + API_ENDPOINTS

**Auditoría commit `ddb10f4`:** solo 6 archivos legítimos; sin basura en ese commit.

**Limpieza repo (preexistente):** ~50 `Backend/**/__pycache__/*.pyc` rastreados → eliminados del índice Git. `.gitignore` reforzado. Password E2E → `E2E_STAGING_PASSWORD`.

**API_ENDPOINTS:** helpers CRUD admin (`adminEmployeeDetailPath`, etc.), `uploads.*`, migración en `admin.service.ts` y `secretaria-cita-detalle.component.ts`.

**E2E (20/20 OK):** login, guards API (cliente 403 admin/secretaria), cita 201, pedido 200, Clip 502 sin pago real. Sin Playwright; validación HTTP + estática.

**Toolchain:** `npm ci` y `npm run build` OK (Node 20.19.0).

## API_ENDPOINTS (Fase 2.1 + 2.4)

Rutas centralizadas en `src/app/core/api/api-endpoints.ts`:

| Grupo | Rutas |
| ----- | ----- |
| `health` | `/health/` |
| `auth.*` | login, register, refresh, perfil, 2FA, OTP recuperación |
| `client.*` | dashboard-stats, mis-citas, citas, política-pago, barberos, disponibilidad, comprobantes |
| `public.*` | servicios, productos, contacto, configuracion-publica, legal |
| `orders.*` | list, create |
| `promotions.validate` | validar cupón |
| `payments.clipIntent` | intentar pago Clip |
| `admin.*` | dashboard, configuración, servicios, productos, empleados, promociones, inventario, reportes, legal |
| `secretaria.*` | dashboard, citas, pedidos |
| `uploads.*` | admin upload, delete-image |

**Helpers Fase 2.4:** `withResourceId`, `admin*DetailPath`, `secretariaAppointment*Path`.

**Pendiente en `API_ENDPOINTS`:** reportes, respaldo-db, monitoreo-bd, predicción-ventas, alexa, secretaria pedidos detalle.

## Arquitectura esperada

```txt
FrontendAngular/src/app/
├── core/
│   ├── api/
│   └── auth/
├── components/
├── services/
├── interceptors/
└── ...
```

La estructura actual todavía no está completamente migrada a core/shared/layouts/features/data-access. Esa reorganización queda para una fase posterior.

### Archivos nuevos en Fase 1

| Archivo | Rol |
| ------- | --- |
| `src/app/core/auth/token.service.ts` | Lectura/escritura centralizada de JWT en localStorage |
| `src/app/core/api/api-endpoints.ts` | Rutas críticas: auth refresh, pedidos, promociones, Clip |

### Archivos nuevos en Fase 2.0

| Archivo | Rol |
| ------- | --- |
| `.nvmrc` | Versión Node 20.19.0 para nvm / fnm |
| `.node-version` | Versión Node para asdf / rbenv-style tools |

### Archivos modificados en Fase 2.1 (referencia)

`core/api/api-endpoints.ts`, `services/auth.service.ts`, `services/cita.service.ts`, `services/pedido.service.ts`, `services/servicio.service.ts`, `services/producto.service.ts`, `services/logo.service.ts`, `services/admin.service.ts` (rutas cliente), `environments/environment.ts`, `components/security-dashboard/security-dashboard.component.ts`.

### Archivos modificados en Fase 2.0 (referencia)

`.gitignore` (ignora `.tools/`), `package.json` (`engines`), `package-lock.json` (regenerado con Node 20).

### Archivos modificados en Fase 1 (referencia)

`main.ts`, `interceptors/auth.interceptor.ts`, `services/modal.service.ts`, `services/auth.service.ts`, `services/pedido.service.ts`, `services/cita.service.ts`, `services/admin.service.ts`, `components/cliente/checkout/*`, `components/cliente/agendar/*`, `components/cliente/dashboard/*`, `components/cliente/mis-citas/*`, `components/publico/legal/legal.component.html`, `components/shared/sidebar/*`.

## Toolchain (Fase 2.0)

| Herramienta | Versión fijada / validada |
| ----------- | ------------------------- |
| Node        | 20.19.0 LTS (`.nvmrc`, `.node-version`) |
| npm         | 10.8.2 (rango `>=10 <11` en `engines`) |
| Angular     | 17.3.x (sin cambio de major) |

Comandos de validación (con Node 20 activo):

```bash
cd FrontendAngular
node -v    # debe ser v20.x
npm -v     # debe ser 10.x
rm -rf node_modules
npm ci
npm run build
```

## Módulos esperados

| Feature             | Estado    | Notas                                                                                   |
| ------------------- | --------- | --------------------------------------------------------------------------------------- |
| public/landing      | Parcial   | Existe interfaz pública; falta rediseño premium completo.                               |
| auth                | Parcial   | TokenService e interceptor centralizados; pendiente migración futura a cookie HttpOnly. |
| client/appointments | Parcial   | E2E POST OK en Neon staging; payload sin montos críticos verificado.                     |
| client/orders       | Parcial   | E2E POST OK en Neon staging; totales solo desde backend.                                 |
| client/payments     | Parcial   | Clip intent probado; 502 por config Clip staging; sin pago real.                       |
| secretary/agenda    | Pendiente | Agenda operativa pendiente de revisión.                                                 |
| barber/schedule     | Pendiente | Agenda barbero pendiente de revisión.                                                   |
| admin/dashboard     | Parcial   | Existe admin.service; pendiente desacoplar por dominios.                                |
| admin/products      | Pendiente | Pendiente revisión funcional.                                                           |
| admin/inventory     | Pendiente | Pendiente revisión; Angular no debe modificar stock directo.                            |
| admin/reports       | Pendiente | Pendiente revisión.                                                                     |

## Reglas visuales

* Dark-first.
* Verde salvia grisáceo.
* Negro carbón.
* Dorado oro.
* Scroll reveal.
* Microinteracciones.
* Responsive.
* No rediseñar completo hasta terminar integración API.

## Reglas funcionales vigentes

Angular no debe:

* Calcular montos finales como autoridad.
* Confirmar pagos.
* Modificar inventario directamente.
* Saltar reglas de backend.
* Guardar secretos.
* Guardar CLIP_API_KEY.
* Insertar HTML dinámico inseguro.

Angular sí debe:

* Consumir API Django.
* Mostrar estados devueltos por backend.
* Redirigir a Clip usando checkout_url devuelto por backend.
* Consultar estado de pago al backend.
* Proteger rutas por rol.
* Mostrar estados loading/error/empty.
* Mantener mensajes de error seguros.

### Contratos HTTP críticos (post Fase 1)

**Crear cita** (`POST /api/citas/` vía `admin.service.createCita`):

```json
{
  "barbero_id": 0,
  "servicio_id": 0,
  "fecha": "YYYY-MM-DD",
  "hora": "HH:MM",
  "comprobante_pago": "",
  "codigo_descuento": "",
  "notas": ""
}
```

No enviar: `precio_total`, `descuento`, `anticipo_monto`, `porcentaje_anticipo`, `penalizada`, `modo_cobro`.

**Crear pedido** (`POST /api/pedidos/crear/` vía `pedido.service.crearPedido`):

```json
{
  "items": [{ "producto_id": 0, "cantidad": 0 }],
  "metodo_entrega": "",
  "metodo_pago": "",
  "direccion_entrega": "",
  "codigo_descuento": "",
  "notas": "",
  "comprobante_url": ""
}
```

No enviar: `subtotal`, `descuento`, `costo_envio`, `total`.

**Clip** (`POST /api/pagos/clip/intentar/`):

```json
{
  "tipo": "pedido|cita",
  "pedido_id": 0,
  "cita_id": 0,
  "card_token_id": "",
  "cliente_email": "",
  "cliente_phone": ""
}
```

Éxito de pago en UI solo si `normalizarEstadoPago(estado_pago)` devuelve `confirmado`. Redirección a `checkout_url` valida protocolo `https:`.

## Cambios recientes

| Fecha      | Cambio                    | Nota                                                                                                     |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-06-19 | Angular Fase 2.4 limpieza + E2E UI/API | pycache fuera de Git, API_ENDPOINTS CRUD admin, guards E2E 20/20, Clip 502. |
| 2026-06-19 | Angular Fase 2.3 E2E Neon staging | Catálogo/login OK, seed E2E, cita/pedido E2E; Clip 502 sin pago real.                    |
| 2026-06-19 | Angular Fase 2.2 E2E entorno seguro (parcial) | SQLite local, health/auth OK, catálogo/citas bloqueados por esquema `negocio`; build OK. |
| 2026-06-18 | Angular Fase 2.1 integración API (parcial) | API_ENDPOINTS ampliado, servicios cliente migrados, pruebas HTTP limitadas (Neon).       |
| 2026-06-18 | Angular Fase 2.0 toolchain | Node 20 LTS fijado, engines en package.json, lock regenerado, npm ci y build validados.  |
| 2026-06-18 | Angular Fase 1 crítica    | XSS cerrado, TokenService creado, API_ENDPOINTS creado, pagos/citas alineados al backend, build exitoso. |

## Riesgos pendientes

* JWT sigue en localStorage como mitigación temporal; migración futura a cookie HttpOnly.
* Node global del sistema puede seguir en v24; desarrolladores deben activar Node 20 (nvm/fnm) antes de instalar dependencias.
* **Neon staging:** datos `E2E_TEST_*` / `e2e_*_stylo` conviven con datos reales; no ejecutar limpiezas masivas.
* **Clip staging:** intent devuelve 502 (credenciales/endpoint); rotar secretos expuestos y validar sandbox antes de E2E Clip completo.
* **npm ci EPERM** resuelto en Fase 2.4 (reinstalación limpia con Node 20).
* E2E UI navegador con Playwright pendiente; guards validados vía API + estática.
* Rutas admin restantes (reportes, respaldo-db, monitoreo) aún no migradas a `API_ENDPOINTS`.
* admin.service.ts sigue concentrando varios dominios.
* Totales locales en UI (carrito, checkout, agendar) deben mantenerse solo como informativos.
* Cupones pueden enviar subtotal para prevalidación, pero Django debe recalcular al confirmar.
* setup-totp usa bypassSecurityTrustUrl para QR; mantener deshabilitado hasta que backend exponga endpoint seguro.
* Checkout efectivo/transferencia marca éxito de pedido registrado, no de pago confirmado.

## Próxima fase recomendada

Angular Fase 2.5 — Playwright + Clip sandbox:

1. Configurar Clip sandbox y validar `checkout_url` https (sin completar pago).
2. Playwright opcional para guards visuales en rutas protegidas.
3. Migrar rutas admin restantes a `API_ENDPOINTS`.
4. CI con Node 20 + job E2E Neon staging.
