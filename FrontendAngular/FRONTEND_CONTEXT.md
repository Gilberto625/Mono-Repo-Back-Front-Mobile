# FRONTEND_CONTEXT.md

# Contexto vivo del frontend Angular

## Propósito

Mantener documentado el estado actual del frontend Angular para Cursor, Codex y desarrolladores.

## Estado actual

Angular Fase 1 crítica y **Fase 2.0 (toolchain)** fueron aplicadas.

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
| client/appointments | Parcial   | Agendado corregido para no enviar montos críticos; falta prueba real Angular ↔ Django.  |
| client/orders       | Parcial   | Pedido ya no envía total final como autoridad; falta prueba real con backend.           |
| client/payments     | Parcial   | Checkout valida estado_pago y usa checkout_url del backend; falta prueba Clip staging.  |
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
| 2026-06-18 | Angular Fase 2.0 toolchain | Node 20 LTS fijado, engines en package.json, lock regenerado, npm ci y build validados.                  |
| 2026-06-18 | Angular Fase 1 crítica    | XSS cerrado, TokenService creado, API_ENDPOINTS creado, pagos/citas alineados al backend, build exitoso. |

## Riesgos pendientes

* JWT sigue en localStorage como mitigación temporal; migración futura a cookie HttpOnly.
* Node global del sistema puede seguir en v24; desarrolladores deben activar Node 20 (nvm/fnm) antes de instalar dependencias.
* Falta probar flujo real Angular ↔ Django con backend levantado.
* Falta probar Clip en staging/sandbox o entorno controlado.
* API_ENDPOINTS todavía no cubre todas las rutas (login, perfil, citas en admin.service siguen como strings).
* admin.service.ts sigue concentrando varios dominios.
* Totales locales en UI (carrito, checkout, agendar) deben mantenerse solo como informativos.
* Cupones pueden enviar subtotal para prevalidación, pero Django debe recalcular al confirmar.
* setup-totp usa bypassSecurityTrustUrl para QR; mantener deshabilitado o controlado hasta que backend exponga endpoint seguro.
* Checkout efectivo/transferencia marca éxito de pedido registrado, no de pago confirmado; el estado final debe venir del backend.

## Próxima fase recomendada

Angular Fase 2.1 — integración API:

1. Migrar endpoints restantes a API_ENDPOINTS.
2. Probar integración Angular ↔ Django:

   * login
   * agendar cita
   * pedido
   * checkout
   * estado de pago
3. Revisar guards por rol.
4. Configurar CI con Node 20 LTS (usar `.nvmrc`).
5. Después iniciar rediseño premium completo.
