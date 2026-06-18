import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { clienteGuard, secretariaGuard, barberoGuard, adminGuard } from './guards/role.guard';
import { verify2faGuard } from './guards/verify-2fa.guard';

export const routes: Routes = [
  // ============================================
  // RUTAS PÚBLICAS
  // ============================================
  {
    path: '',
    loadComponent: () => import('./components/publico/inicio/inicio.component').then(m => m.InicioComponent)
  },
  {
    path: 'servicios/:id',
    loadComponent: () => import('./components/publico/servicio-detalle/servicio-detalle.component').then(m => m.ServicioDetalleComponent)
  },
  {
    path: 'servicios',
    data: { preload: true },
    loadComponent: () => import('./components/publico/servicios-lista/servicios-lista.component').then(m => m.ServiciosListaComponent)
  },
  {
    path: 'productos/:id',
    loadComponent: () => import('./components/publico/producto-detalle/producto-detalle.component').then(m => m.ProductoDetalleComponent)
  },
  {
    path: 'productos',
    data: { preload: true },
    loadComponent: () => import('./components/publico/productos-lista/productos-lista.component').then(m => m.ProductosListaComponent)
  },
  {
    path: 'ayuda',
    loadComponent: () => import('./components/publico/ayuda/ayuda.component').then(m => m.AyudaComponent)
  },
  {
    path: 'contacto',
    data: { preload: true },
    loadComponent: () => import('./components/publico/contacto/contacto.component').then(m => m.ContactoComponent)
  },
  {
    path: 'nosotros',
    loadComponent: () => import('./components/publico/legal/legal.component').then(m => m.LegalComponent)
  },
  {
    path: 'mapa-sitio',
    loadComponent: () => import('./components/publico/mapa-sitio/mapa-sitio.component').then(m => m.MapaSitioComponent)
  },
  
  // ============================================
  // AUTENTICACIÓN
  // ============================================
  {
    path: 'register',
    loadComponent: () => import('./components/register/register.component').then(m => m.RegisterComponent)
  },
  {
    path: 'login',
    loadComponent: () => import('./components/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'verify-2fa',
    canActivate: [verify2faGuard],
    loadComponent: () => import('./components/verify2fa/verify2fa.component').then(m => m.Verify2faComponent)
  },
  {
    path: 'forgot-password',
    loadComponent: () => import('./components/forgot-password/forgot-password.component').then(m => m.ForgotPasswordComponent)
  },
  {
    path: 'reset-password',
    loadComponent: () => import('./components/reset-password/reset-password.component').then(m => m.ResetPasswordComponent)
  },

  // ============================================
  // RUTAS CLIENTE
  // ============================================
  {
    path: 'cliente',
    canActivate: [authGuard, clienteGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./components/cliente/dashboard/cliente-dashboard.component').then(m => m.ClienteDashboardComponent)
      },
      {
        path: 'perfil/editar',
        loadComponent: () => import('./components/profile/editar-perfil/editar-perfil.component').then(m => m.EditarPerfilComponent)
      },
      {
        path: 'perfil',
        loadComponent: () => import('./components/profile/profile.component').then(m => m.ProfileComponent)
      },
      {
        path: 'recomendador',
        loadComponent: () => import('./components/cliente/recomendador-estilos/recomendador-estilos.component').then(m => m.RecomendadorEstilosComponent)
      },
      {
        path: 'recomendador/:id',
        loadComponent: () => import('./components/publico/servicio-detalle/servicio-detalle.component').then(m => m.ServicioDetalleComponent)
      },
      {
        path: 'servicios/:id',
        loadComponent: () => import('./components/publico/servicio-detalle/servicio-detalle.component').then(m => m.ServicioDetalleComponent)
      },
      {
        path: 'servicios',
        data: { preload: true },
        loadComponent: () => import('./components/cliente/servicios-panel/cliente-servicios.component').then(m => m.ClienteServiciosComponent)
      },
      {
        path: 'productos/:id',
        loadComponent: () => import('./components/publico/producto-detalle/producto-detalle.component').then(m => m.ProductoDetalleComponent)
      },
      {
        path: 'productos',
        loadComponent: () => import('./components/cliente/productos-panel/cliente-productos.component').then(m => m.ClienteProductosComponent)
      },
      {
        path: 'agendar',
        data: { preload: true },
        loadComponent: () => import('./components/cliente/agendar/agendar-cita.component').then(m => m.AgendarCitaComponent)
      },
      {
        path: 'citas',
        data: { preload: true },
        loadComponent: () => import('./components/cliente/mis-citas/mis-citas.component').then(m => m.MisCitasComponent)
      },
      {
        path: 'carrito',
        loadComponent: () => import('./components/cliente/carrito/carrito.component').then(m => m.CarritoComponent)
      },
      {
        path: 'checkout',
        loadComponent: () => import('./components/cliente/checkout/checkout.component').then(m => m.CheckoutComponent)
      },
      {
        path: 'pedidos',
        data: { preload: true },
        loadComponent: () => import('./components/cliente/pedidos-panel/cliente-pedidos.component').then(m => m.ClientePedidosComponent)
      },
      // Fallback: cualquier /cliente/* no definido muestra panel cliente (no 404 público)
      {
        path: '**',
        loadComponent: () => import('./components/cliente/no-disponible/cliente-no-disponible.component').then(m => m.ClienteNoDisponibleComponent)
      }
    ]
  },

  // ============================================
  // RUTAS SECRETARIA
  // ============================================
  {
    path: 'secretaria',
    canActivate: [authGuard, secretariaGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./components/secretaria/dashboard/secretaria-dashboard.component').then(m => m.SecretariaDashboardComponent)
      },
      {
        path: 'mi-cuenta',
        loadComponent: () => import('./components/profile/editar-perfil/editar-perfil.component').then(m => m.EditarPerfilComponent)
      },
      {
        path: 'agenda',
        data: { titulo: 'Agenda' },
        loadComponent: () =>
          import('./components/secretaria/no-disponible/secretaria-no-disponible.component').then(
            (m) => m.SecretariaNoDisponibleComponent
          )
      },
      {
        path: 'crear-cita',
        data: { titulo: 'Crear cita' },
        loadComponent: () =>
          import('./components/secretaria/no-disponible/secretaria-no-disponible.component').then(
            (m) => m.SecretariaNoDisponibleComponent
          )
      },
      {
        path: 'transferencias',
        loadComponent: () => import('./components/secretaria/citas/secretaria-citas-anticipos.component').then(m => m.SecretariaCitasAnticiposComponent)
      },
      {
        path: 'transferencias/:id',
        loadComponent: () => import('./components/secretaria/citas/secretaria-cita-detalle.component').then(m => m.SecretariaCitaDetalleComponent)
      },
      {
        path: 'ventas',
        data: { titulo: 'Punto de venta' },
        loadComponent: () =>
          import('./components/secretaria/no-disponible/secretaria-no-disponible.component').then(
            (m) => m.SecretariaNoDisponibleComponent
          )
      },
      {
        path: 'empleados',
        data: { preload: true },
        loadComponent: () => import('./components/admin/empleados/empleados-lista.component').then(m => m.EmpleadosListaComponent)
      },
      {
        path: 'empleados/nuevo',
        data: { preload: true },
        loadComponent: () => import('./components/admin/empleados/empleado-form/empleado-form.component').then(m => m.EmpleadoFormComponent)
      },
      {
        path: 'empleados/editar/:id',
        data: { preload: true },
        loadComponent: () => import('./components/admin/empleados/empleado-editar/empleado-editar.component').then(m => m.EmpleadoEditarComponent)
      },
      {
        path: 'sillas',
        data: { preload: true },
        loadComponent: () => import('./components/secretaria/sillas/sillas-lista.component').then(m => m.SillasListaComponent)
      },
      {
        path: 'marcas',
        data: { preload: true },
        loadComponent: () => import('./components/admin/marcas/marcas-lista.component').then(m => m.MarcasListaComponent)
      },
      {
        path: 'catalogo',
        data: { preload: true },
        loadComponent: () => import('./components/admin/productos/productos-lista.component').then(m => m.ProductosListaComponent)
      },
      {
        path: 'catalogo/nuevo',
        loadComponent: () => import('./components/admin/productos/producto-form/producto-form.component').then(m => m.ProductoFormComponent)
      },
      {
        path: 'catalogo/editar/:id',
        data: { preload: true },
        loadComponent: () => import('./components/admin/productos/producto-editar/producto-editar.component').then(m => m.ProductoEditarComponent)
      },
      {
        path: 'servicios',
        data: { preload: true },
        loadComponent: () => import('./components/admin/servicios/servicios-lista.component').then(m => m.ServiciosListaComponent)
      },
      {
        path: 'servicios/nuevo',
        data: { preload: true },
        loadComponent: () => import('./components/admin/servicios/servicio-form/servicio-form.component').then(m => m.ServicioFormComponent)
      },
      {
        path: 'servicios/editar/:id',
        data: { preload: true },
        loadComponent: () => import('./components/admin/servicios/servicio-editar/servicio-editar.component').then(m => m.ServicioEditarComponent)
      },
      {
        path: 'inventario',
        data: { preload: true },
        loadComponent: () => import('./components/secretaria/inventario/inventario.component').then(m => m.SecretariaInventarioComponent)
      },
      {
        path: 'inventario/entrada',
        loadComponent: () => import('./components/secretaria/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.SecretariaMovimientoInventarioComponent)
      },
      {
        path: 'inventario/entrada/:productoId',
        loadComponent: () => import('./components/secretaria/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.SecretariaMovimientoInventarioComponent)
      },
      {
        path: 'inventario/salida',
        loadComponent: () => import('./components/secretaria/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.SecretariaMovimientoInventarioComponent)
      },
      {
        path: 'inventario/salida/:productoId',
        loadComponent: () => import('./components/secretaria/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.SecretariaMovimientoInventarioComponent)
      },
      {
        path: 'pedidos',
        data: { preload: true },
        loadComponent: () => import('./components/secretaria/pedidos/secretaria-pedidos.component').then(m => m.SecretariaPedidosComponent)
      },
      {
        path: 'pedidos/:id',
        data: { preload: true },
        loadComponent: () => import('./components/secretaria/pedidos/secretaria-pedido-detalle.component').then(m => m.SecretariaPedidoDetalleComponent)
      },
      {
        path: 'entregas',
        loadComponent: () => import('./components/secretaria/entregas/secretaria-entregas.component').then(m => m.SecretariaEntregasComponent)
      },
      {
        path: 'whatsapp',
        loadComponent: () => import('./components/secretaria/whatsapp/secretaria-whatsapp.component').then(m => m.SecretariaWhatsappComponent)
      }
    ]
  },

  // ============================================
  // RUTAS BARBERO
  // ============================================
  {
    path: 'barbero',
    canActivate: [authGuard, barberoGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./components/barbero/dashboard/barbero-dashboard.component').then(m => m.BarberoDashboardComponent)
      },
      {
        path: 'mi-cuenta',
        loadComponent: () => import('./components/profile/editar-perfil/editar-perfil.component').then(m => m.EditarPerfilComponent)
      },
      {
        path: 'agenda',
        loadComponent: () => import('./components/barbero/dashboard/barbero-dashboard.component').then(m => m.BarberoDashboardComponent)
      },
      {
        path: 'tiempos',
        loadComponent: () => import('./components/barbero/dashboard/barbero-dashboard.component').then(m => m.BarberoDashboardComponent)
      },
      {
        path: 'notificaciones',
        loadComponent: () => import('./components/barbero/dashboard/barbero-dashboard.component').then(m => m.BarberoDashboardComponent)
      }
    ]
  },

  // ============================================
  // RUTAS ADMIN
  // ============================================
  {
    path: 'admin',
    canActivate: [authGuard, adminGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./components/admin/dashboard/admin-dashboard.component').then(m => m.AdminDashboardComponent)
      },
      {
        path: 'mi-cuenta',
        loadComponent: () => import('./components/profile/editar-perfil/editar-perfil.component').then(m => m.EditarPerfilComponent)
      },
      {
        path: 'empleados/nuevo',
        loadComponent: () => import('./components/admin/empleados/empleado-form/empleado-form.component').then(m => m.EmpleadoFormComponent)
      },
      {
        path: 'empleados/editar/:id',
        loadComponent: () => import('./components/admin/empleados/empleado-editar/empleado-editar.component').then(m => m.EmpleadoEditarComponent)
      },
      {
        path: 'empleados',
        data: { preload: true },
        loadComponent: () => import('./components/admin/empleados/empleados-lista.component').then(m => m.EmpleadosListaComponent)
      },
      {
        path: 'sillas',
        data: { preload: true },
        loadComponent: () => import('./components/admin/sillas/sillas-lista.component').then(m => m.SillasListaComponent)
      },
      {
        path: 'marcas',
        data: { preload: true },
        loadComponent: () => import('./components/admin/marcas/marcas-lista.component').then(m => m.MarcasListaComponent)
      },
      {
        path: 'servicios/nuevo',
        loadComponent: () => import('./components/admin/servicios/servicio-form/servicio-form.component').then(m => m.ServicioFormComponent)
      },
      {
        path: 'servicios/editar/:id',
        loadComponent: () => import('./components/admin/servicios/servicio-editar/servicio-editar.component').then(m => m.ServicioEditarComponent)
      },
      {
        path: 'servicios',
        data: { preload: true },
        loadComponent: () => import('./components/admin/servicios/servicios-lista.component').then(m => m.ServiciosListaComponent)
      },
      {
        path: 'productos/nuevo',
        data: { preload: true },
        loadComponent: () => import('./components/admin/productos/producto-form/producto-form.component').then(m => m.ProductoFormComponent)
      },
      {
        path: 'productos/editar/:id',
        data: { preload: true },
        loadComponent: () => import('./components/admin/productos/producto-editar/producto-editar.component').then(m => m.ProductoEditarComponent)
      },
      {
        path: 'productos',
        data: { preload: true },
        loadComponent: () => import('./components/admin/productos/productos-lista.component').then(m => m.ProductosListaComponent)
      },
      {
        path: 'inventario/entrada/:productoId',
        data: { preload: true },
        loadComponent: () => import('./components/admin/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.MovimientoInventarioComponent)
      },
      {
        path: 'inventario/entrada',
        data: { preload: true },
        loadComponent: () => import('./components/admin/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.MovimientoInventarioComponent)
      },
      {
        path: 'inventario/salida/:productoId',
        data: { preload: true },
        loadComponent: () => import('./components/admin/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.MovimientoInventarioComponent)
      },
      {
        path: 'inventario/salida',
        data: { preload: true },
        loadComponent: () => import('./components/admin/inventario/movimiento-inventario/movimiento-inventario.component').then(m => m.MovimientoInventarioComponent)
      },
      {
        path: 'inventario',
        data: { preload: true },
        loadComponent: () => import('./components/admin/inventario/inventario.component').then(m => m.InventarioComponent)
      },
      {
        path: 'reportes/vista',
        data: { preload: true },
        loadComponent: () => import('./components/admin/reportes/reporte-vista/reporte-vista.component').then(m => m.ReporteVistaComponent)
      },
      {
        path: 'reportes',
        data: { preload: true },
        loadComponent: () => import('./components/admin/reportes/reportes.component').then(m => m.ReportesComponent)
      },
      {
        path: 'prediccion-ventas',
        data: { preload: true },
        loadComponent: () => import('./components/admin/prediccion-ventas/prediccion-ventas.component').then(m => m.PrediccionVentasComponent)
      },
      {
        path: 'prediccion-ventas-prueba',
        data: { modo: 'prueba', preload: true },
        loadComponent: () => import('./components/admin/prediccion-ventas/prediccion-ventas.component').then(m => m.PrediccionVentasComponent)
      },
      {
        path: 'respaldo-db',
        data: { preload: true },
        loadComponent: () => import('./components/admin/respaldo-db/respaldo-db.component').then(m => m.RespaldoDbComponent)
      },
      {
        path: 'monitoreo-bd',
        data: { preload: true },
        loadComponent: () => import('./components/admin/monitoreo-bd/monitoreo-bd.component').then(m => m.MonitoreoBdComponent)
      },
      {
        path: 'contenido-legal',
        data: { preload: true },
        loadComponent: () => import('./components/admin/contenido-legal/contenido-legal.component').then(m => m.ContenidoLegalComponent)
      },
      {
        path: 'configuracion',
        data: { preload: true },
        loadComponent: () => import('./components/admin/configuracion/configuracion.component').then(m => m.ConfiguracionComponent)
      },
      {
        path: 'promociones',
        data: { preload: true },
        loadComponent: () => import('./components/admin/promociones/promociones.component').then(m => m.PromocionesComponent)
      },
      {
        path: 'promociones/nuevo',
        data: { preload: true },
        loadComponent: () => import('./components/admin/promociones/promociones.component').then(m => m.PromocionesComponent)
      },
      {
        path: 'promociones/editar/:id',
        data: { preload: true },
        loadComponent: () => import('./components/admin/promociones/promociones.component').then(m => m.PromocionesComponent)
      }
    ]
  },

  // ============================================
  // RUTAS DE SEGURIDAD (existentes)
  // ============================================
  {
    path: 'home',
    loadComponent: () => import('./components/home/home.component').then(m => m.HomeComponent),
    canActivate: [authGuard]
  },
  {
    path: 'setup-totp',
    loadComponent: () => import('./components/setup-totp/setup-totp.component').then(m => m.SetupTotpComponent),
    canActivate: [authGuard]
  },
  {
    path: 'backup-codes',
    loadComponent: () => import('./components/backup-codes/backup-codes.component').then(m => m.BackupCodesComponent),
    canActivate: [authGuard]
  },
  {
    path: 'security',
    loadComponent: () => import('./components/security-dashboard/security-dashboard.component').then(m => m.SecurityDashboardComponent),
    canActivate: [authGuard]
  },
  {
    path: 'change-password',
    loadComponent: () => import('./components/change-password/change-password.component').then(m => m.ChangePasswordComponent),
    canActivate: [authGuard]
  },
  {
    path: 'profile',
    loadComponent: () => import('./components/profile/profile.component').then(m => m.ProfileComponent),
    canActivate: [authGuard]
  },

  // ============================================
  // PÁGINAS DE ERROR
  // ============================================
  {
    path: '404',
    loadComponent: () => import('./components/errors/not-found/not-found.component').then(m => m.NotFoundComponent)
  },
  {
    path: '400',
    loadComponent: () => import('./components/errors/bad-request/bad-request.component').then(m => m.BadRequestComponent)
  },
  {
    path: '500',
    loadComponent: () => import('./components/errors/server-error/server-error.component').then(m => m.ServerErrorComponent)
  },

  // ============================================
  // REDIRECCIÓN POR DEFECTO (404)
  // ============================================
  {
    path: '**',
    loadComponent: () => import('./components/errors/not-found/not-found.component').then(m => m.NotFoundComponent)
  }
];
