# FRONTEND_CONTEXT.md

# Contexto vivo del frontend Angular

## Propósito

Mantener documentado el estado actual del frontend Angular para Cursor, Codex y desarrolladores.

## Estado actual

Angular Fase 1 crítica, **Fase 2.0 (toolchain)** y **Fase 2.1 (integración API — parcial)** fueron aplicadas.

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

## API_ENDPOINTS (Fase 2.1)

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

**Pendiente en `API_ENDPOINTS`:** rutas admin CRUD con `:id`, secretaria detalle/actualizar, alexa, upload admin (siguen como strings en `admin.service` y componentes secretaria).

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
| client/appointments | Parcial   | Endpoints centralizados; POST sin montos críticos; E2E pendiente (DB/Neon).             |
| client/orders       | Parcial   | Endpoints centralizados; POST sin total; E2E pendiente (DB/Neon).                       |
| client/payments     | Parcial   | Clip vía backend; E2E pendiente staging/sandbox.                                        |
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
| 2026-06-18 | Angular Fase 2.1 integración API (parcial) | API_ENDPOINTS ampliado, servicios cliente migrados, pruebas HTTP limitadas (Neon).       |
| 2026-06-18 | Angular Fase 2.0 toolchain | Node 20 LTS fijado, engines en package.json, lock regenerado, npm ci y build validados.  |
| 2026-06-18 | Angular Fase 1 crítica    | XSS cerrado, TokenService creado, API_ENDPOINTS creado, pagos/citas alineados al backend, build exitoso. |

## Riesgos pendientes

* JWT sigue en localStorage como mitigación temporal; migración futura a cookie HttpOnly.
* Node global del sistema puede seguir en v24; desarrolladores deben activar Node 20 (nvm/fnm) antes de instalar dependencias.
* **Backend local con `USE_LOCAL_DB=False`:** catálogo público devolvió 503; login con credencial inválida devolvió 500. Resolver conectividad Neon o usar `USE_LOCAL_DB=True` para E2E.
* No se ejecutaron pruebas de creación (cita/pedido/Clip) contra Neon sin confirmación explícita.
* Falta E2E completo: login UI, refresh, agendar, checkout, estado de pago.
* Falta probar Clip en staging/sandbox.
* Rutas admin/secretaria con parámetros dinámicos aún no migradas a `API_ENDPOINTS`.
* admin.service.ts sigue concentrando varios dominios.
* Totales locales en UI (carrito, checkout, agendar) deben mantenerse solo como informativos.
* Cupones pueden enviar subtotal para prevalidación, pero Django debe recalcular al confirmar.
* setup-totp usa bypassSecurityTrustUrl para QR; mantener deshabilitado hasta que backend exponga endpoint seguro.
* Checkout efectivo/transferencia marca éxito de pedido registrado, no de pago confirmado.

## Próxima fase recomendada

Angular Fase 2.2 — E2E con entorno seguro:

1. Levantar backend con `USE_LOCAL_DB=True` o base temporal confirmada.
2. Probar login, refresh, logout y redirección por rol en UI.
3. Probar agendar cita, pedido, checkout y consulta de estado de pago.
4. Migrar rutas admin/secretaria restantes a `API_ENDPOINTS`.
5. Investigar 503 en catálogo público y 500 en login (backend/DB).
6. Configurar CI con Node 20 LTS (`.nvmrc`).
