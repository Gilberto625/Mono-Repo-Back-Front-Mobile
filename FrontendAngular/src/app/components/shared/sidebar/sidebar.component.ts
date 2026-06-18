import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RolUsuario } from '../../../models';
import { LogoService } from '../../../services/logo.service';
import { AuthService } from '../../../services/auth.service';

interface MenuItem {
  label: string;
  route: string;
  icon: SafeHtml;
}

export interface MenuSection {
  sectionLabel?: string;
  items: MenuItem[];
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html'
})
export class SidebarComponent {
  @Input() rol: RolUsuario = 'cliente';
  private readonly sanitizer = inject(DomSanitizer);
  private readonly authService = inject(AuthService);
  readonly logoService = inject(LogoService);

  get rolLabel(): string {
    const labels: Record<RolUsuario, string> = {
      cliente: '',
      secretaria: 'Secretaría',
      barbero: 'Barbero',
      admin: 'Administrador'
    };
    return labels[this.rol];
  }

  get logoRoute(): string {
    const routes: Record<RolUsuario, string> = {
      cliente: '/cliente',
      secretaria: '/secretaria',
      barbero: '/barbero',
      admin: '/admin'
    };
    return routes[this.rol] || '/';
  }

  get userNombre(): string {
    const u: any = this.authService.getCurrentUser?.();
    const nombre = String(u?.nombre || u?.username || u?.email || '').trim();
    return nombre || 'Usuario';
  }

  get userIniciales(): string {
    const n = this.userNombre;
    const tokens = n.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 'U';
    if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
    return `${tokens[0][0] || ''}${tokens[1][0] || ''}`.toUpperCase();
  }

  /** Menú plano (para roles que no usan secciones). */
  get menuItems(): MenuItem[] {
    return this.menuSections.flatMap((s) => s.items);
  }

  /** Menú por secciones. Secretaría tiene secciones; otros roles una sola sin etiqueta. */
  get menuSections(): MenuSection[] {
    const s = (label: string, ...items: MenuItem[]): MenuSection => ({ sectionLabel: label, items: [...items] });
    const sinSeccion = (...items: MenuItem[]): MenuSection => ({ items: [...items] });

    const menus: Record<RolUsuario, MenuSection[]> = {
      cliente: [
        sinSeccion(
          { label: 'Dashboard', route: '/cliente', icon: this.sanitize(this.iconDashboard) },
          { label: 'Mi Perfil', route: '/cliente/perfil', icon: this.sanitize(this.iconUser) },
          { label: '¿Qué corte me queda?', route: '/cliente/recomendador', icon: this.sanitize(this.iconSparkle) },
          { label: 'Servicios', route: '/cliente/servicios', icon: this.sanitize(this.iconScissors) },
          { label: 'Productos', route: '/cliente/productos', icon: this.sanitize(this.iconPackage) },
          { label: 'Agendar Cita', route: '/cliente/agendar', icon: this.sanitize(this.iconCalendar) },
          { label: 'Mis Citas', route: '/cliente/citas', icon: this.sanitize(this.iconDocument) },
          { label: 'Carrito', route: '/cliente/carrito', icon: this.sanitize(this.iconCart) },
          { label: 'Mis Pedidos', route: '/cliente/pedidos', icon: this.sanitize(this.iconPackage) }
        )
      ],
      secretaria: [
        s(
          'Principal',
          { label: 'Dashboard', route: '/secretaria', icon: this.sanitize(this.iconDashboard) },
          { label: 'Mi cuenta', route: '/secretaria/mi-cuenta', icon: this.sanitize(this.iconUser) },
          { label: 'Agenda General', route: '/secretaria/agenda', icon: this.sanitize(this.iconCalendar) },
          { label: 'Crear Cita', route: '/secretaria/crear-cita', icon: this.sanitize(this.iconPlus) },
          { label: 'Punto de Venta', route: '/secretaria/ventas', icon: this.sanitize(this.iconDollar) },
          { label: 'Transferencias', route: '/secretaria/transferencias', icon: this.sanitize(this.iconCard) },
          { label: 'WhatsApp', route: '/secretaria/whatsapp', icon: this.sanitize(this.iconChat) }
        ),
        s(
          'Equipo',
          { label: 'Empleados', route: '/secretaria/empleados', icon: this.sanitize(this.iconUsers) },
          { label: 'Sillas', route: '/secretaria/sillas', icon: this.sanitize(this.iconChair) }
        ),
        s(
          'Servicios y productos',
          { label: 'Servicios', route: '/secretaria/servicios', icon: this.sanitize(this.iconScissors) },
          { label: 'Productos', route: '/secretaria/catalogo', icon: this.sanitize(this.iconPackage) },
          { label: 'Marcas', route: '/secretaria/marcas', icon: this.sanitize(this.iconTag) }
        ),
        s(
          'Inventario y ventas',
          { label: 'Inventario', route: '/secretaria/inventario', icon: this.sanitize(this.iconFolder) },
          { label: 'Pedidos', route: '/secretaria/pedidos', icon: this.sanitize(this.iconDocument) },
          { label: 'Entregas', route: '/secretaria/entregas', icon: this.sanitize(this.iconTruck) }
        )
      ],
      barbero: [
        sinSeccion(
          { label: 'Dashboard', route: '/barbero', icon: this.sanitize(this.iconDashboard) },
          { label: 'Mi cuenta', route: '/barbero/mi-cuenta', icon: this.sanitize(this.iconUser) },
          { label: 'Mi Agenda', route: '/barbero/agenda', icon: this.sanitize(this.iconCalendar) },
          { label: 'Tiempos de Servicio', route: '/barbero/tiempos', icon: this.sanitize(this.iconClock) },
          { label: 'Notificaciones', route: '/barbero/notificaciones', icon: this.sanitize(this.iconBell) }
        )
      ],
      admin: [
        s(
          'Principal',
          { label: 'Dashboard', route: '/admin', icon: this.sanitize(this.iconDashboard) },
          { label: 'Mi cuenta', route: '/admin/mi-cuenta', icon: this.sanitize(this.iconUser) }
        ),
        s(
          'Equipo',
          { label: 'Empleados', route: '/admin/empleados', icon: this.sanitize(this.iconUsers) },
          { label: 'Sillas', route: '/admin/sillas', icon: this.sanitize(this.iconChair) }
        ),
        s(
          'Servicios y productos',
          { label: 'Servicios', route: '/admin/servicios', icon: this.sanitize(this.iconScissors) },
          { label: 'Productos', route: '/admin/productos', icon: this.sanitize(this.iconPackage) },
          { label: 'Marcas', route: '/admin/marcas', icon: this.sanitize(this.iconTag) }
        ),
        s(
          'Inventario y reportes',
          { label: 'Inventario', route: '/admin/inventario', icon: this.sanitize(this.iconSliders) },
          { label: 'Reportes', route: '/admin/reportes', icon: this.sanitize(this.iconChart) },
          { label: 'Predicción Ventas', route: '/admin/prediccion-ventas', icon: this.sanitize(this.iconChart) }
        ),
        s(
          'Sistema y configuración',
          { label: 'Monitoreo BD', route: '/admin/monitoreo-bd', icon: this.sanitize(this.iconDatabase) },
          { label: 'Respaldos BD', route: '/admin/respaldo-db', icon: this.sanitize(this.iconFolder) },
          { label: 'Contenido Legal', route: '/admin/contenido-legal', icon: this.sanitize(this.iconDocument) },
          { label: 'Configuración', route: '/admin/configuracion', icon: this.sanitize(this.iconSettings) },
          { label: 'Promociones', route: '/admin/promociones', icon: this.sanitize(this.iconTag) }
        )
      ]
    };
    return menus[this.rol];
  }

  private sanitize(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  onLogout(): void {
    this.authService.logout();
  }

  // SVG Icons
  private readonly iconDashboard = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
  private readonly iconUser = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  private readonly iconUsers = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  private readonly iconCalendar = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  private readonly iconDocument = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  private readonly iconCart = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
  private readonly iconPackage = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="6" width="10" height="14" rx="3"/><path d="M10 6V4h4v2"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="10" y1="15" x2="14" y2="15"/></svg>';
  private readonly iconBookmark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  private readonly iconPlus = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
  private readonly iconCard = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>';
  private readonly iconDollar = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
  private readonly iconFolder = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  private readonly iconTruck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16,8 20,8 23,11 23,16 16,16 16,8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>';
  private readonly iconClock = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>';
  private readonly iconBell = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  private readonly iconScissors = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>';
  private readonly iconSliders = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>';
  private readonly iconChart = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>';
  private readonly iconDatabase = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>';
  private readonly iconSettings = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  private readonly iconTag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  private readonly iconSparkle = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/></svg>';
  private readonly iconChair = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 20v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><path d="M8 18V8a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v10"/><path d="M4 12h16"/></svg>';
  private readonly iconChat = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.5 8.5 0 0 1-12.58 7.46L3 20l1.09-4.08A8.5 8.5 0 1 1 21 11.5z"/></svg>';
}
