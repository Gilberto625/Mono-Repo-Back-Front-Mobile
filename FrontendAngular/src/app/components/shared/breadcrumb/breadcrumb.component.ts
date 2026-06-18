import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd, ActivatedRoute } from '@angular/router';
import { filter, map } from 'rxjs/operators';

export interface BreadcrumbItem {
  label: string;
  url: string;
}

@Component({
  selector: 'app-breadcrumb',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './breadcrumb.component.html',
  styleUrl: './breadcrumb.component.css'
})
export class BreadcrumbComponent implements OnInit {
  breadcrumbs: BreadcrumbItem[] = [];

  constructor(
    private router: Router,
    private activatedRoute: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.router.events
      .pipe(
        filter(event => event instanceof NavigationEnd),
        map(() => this.activatedRoute),
        map(route => {
          while (route.firstChild) {
            route = route.firstChild;
          }
          return route;
        })
      )
      .subscribe(route => {
        this.breadcrumbs = this.buildBreadcrumbs(route);
      });

    // Construir breadcrumbs iniciales
    this.breadcrumbs = this.buildBreadcrumbs(this.activatedRoute);
  }

  private buildBreadcrumbs(route: ActivatedRoute): BreadcrumbItem[] {
    const breadcrumbs: BreadcrumbItem[] = [];
    const routeLabels: Record<string, string> = {
      'servicios': 'Servicios',
      'productos': 'Productos',
      'login': 'Iniciar Sesión',
      'register': 'Registro',
      'forgot-password': 'Recuperar Contraseña',
      'reset-password': 'Restablecer Contraseña',
      'verify-2fa': 'Verificación 2FA',
      'cliente': 'Panel Cliente',
      'perfil': 'Mi Perfil',
      'recomendador': '¿Qué corte me queda?',
      'agendar': 'Agendar Cita',
      'citas': 'Mis Citas',
      'carrito': 'Carrito',
      'pedidos': 'Pedidos',
      'admin': 'Panel Administrador',
      'empleados': 'Empleados',
      'editar': 'Editar empleado',
      'nuevo': 'Nuevo empleado',
      'sillas': 'Sillas',
      'inventario': 'Inventario',
      'entrada': 'Registrar entrada',
      'salida': 'Registrar salida',
      'reportes': 'Reportes',
      'respaldo-db': 'Respaldos BD',
      'vista': 'Vista del reporte',
      'contenido-legal': 'Contenido Legal',
      'configuracion': 'Configuración',
      'promociones': 'Promociones',
      'secretaria': 'Panel Secretaria',
      'agenda': 'Agenda General',
      'crear-cita': 'Crear Cita',
      'transferencias': 'Anticipos de Citas',
      'whatsapp': 'WhatsApp',
      'ventas': 'Punto de Venta',
      'catalogo': 'Productos',
      'entregas': 'Entregas',
      'barbero': 'Panel Barbero',
      'tiempos': 'Tiempos de Servicio',
      'notificaciones': 'Notificaciones',
      'profile': 'Perfil',
      'security': 'Seguridad',
      'setup-totp': 'Configurar TOTP',
      'backup-codes': 'Códigos de Respaldo',
      'change-password': 'Cambiar Contraseña',
      'home': 'Inicio'
    };

    let currentRoute = route;
    const urlSegments: string[] = [];

    // Construir la ruta completa desde la raíz
    while (currentRoute) {
      if (currentRoute.snapshot.url.length > 0) {
        urlSegments.unshift(...currentRoute.snapshot.url.map(segment => segment.path));
      }
      currentRoute = currentRoute.parent!;
    }

    // Siempre agregar "Inicio" como primer breadcrumb
    breadcrumbs.push({ label: 'Inicio', url: '/' });

    // Construir breadcrumbs basados en los segmentos de URL
    let currentPath = '';
    for (let i = 0; i < urlSegments.length; i++) {
      const segment = urlSegments[i];
      currentPath += (currentPath ? '/' : '') + segment;
      
      // Obtener el label del breadcrumb ("nuevo" y "editar" dependen del contexto)
      let label: string;
      if (segment === 'nuevo' && i > 0) {
        const padre = urlSegments[i - 1];
        label = padre === 'servicios'
          ? 'Nuevo servicio'
          : (padre === 'empleados'
            ? 'Nuevo empleado'
            : (padre === 'productos'
              ? 'Nuevo producto'
              : (padre === 'promociones'
                ? 'Nueva promocion'
                : (routeLabels[segment] || this.formatLabel(segment)))));
      } else if (segment === 'editar' && i > 0) {
        const padre = urlSegments[i - 1];
        label = padre === 'servicios'
          ? 'Editar servicio'
          : (padre === 'empleados'
            ? 'Editar empleado'
            : (padre === 'productos'
              ? 'Editar producto'
              : (padre === 'promociones'
                ? 'Editar promocion'
                : (routeLabels[segment] || this.formatLabel(segment)))));
      } else if (/^\d+$/.test(segment)) {
        // Si es un ID numérico, mostrar como "Detalle #ID"
        const padre = i > 0 ? urlSegments[i - 1] : '';
        if (padre === 'pedidos') {
          label = `Pedido #${segment}`;
        } else if (padre === 'recomendador') {
          label = 'Detalle del servicio';
        } else if (padre === 'transferencias') {
          label = `Cita #${segment}`;
        } else {
          label = `Detalle #${segment}`;
        }
        breadcrumbs.push({ label, url: '/' + currentPath });
        continue;
      } else {
        label = routeLabels[currentPath] || routeLabels[segment] || this.formatLabel(segment);
      }
      
      // URL: en "editar", incluir el id siguiente para que el enlace sea correcto
      let urlPath = currentPath;
      if (segment === 'editar' && i + 1 < urlSegments.length && /^\d+$/.test(urlSegments[i + 1])) {
        urlPath = currentPath + '/' + urlSegments[i + 1];
      }
      breadcrumbs.push({ label, url: '/' + urlPath });
    }

    return breadcrumbs;
  }

  private formatLabel(segment: string): string {
    // Convertir "mi-perfil" a "Mi Perfil"
    return segment
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
