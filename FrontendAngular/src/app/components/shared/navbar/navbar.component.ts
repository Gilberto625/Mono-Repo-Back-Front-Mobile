import { Component, HostListener, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { LogoService } from '../../../services/logo.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './navbar.component.html'
})
export class NavbarComponent {
  @Input() isLoggedIn = false;
  logoService = inject(LogoService);
  authService = inject(AuthService);
  readonly themeService = inject(ThemeService);

  toggleTheme(): void {
    this.themeService.toggle();
  }

  navScrolled = false;

  @HostListener('window:scroll')
  onWindowScroll(): void {
    this.navScrolled = typeof window !== 'undefined' && window.scrollY > 12;
  }

  get effectiveLoggedIn(): boolean {
    // Fuente única de verdad para evitar "sesión vieja" en UI.
    return this.authService.isAuthenticated();
  }

  private getRoleHomeRoute(): string {
    if (!this.effectiveLoggedIn) return '/';
    try {
      const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const rol = user.rol || 'cliente';
      const routes: Record<string, string> = {
        cliente: '/cliente',
        secretaria: '/secretaria',
        barbero: '/barbero',
        admin: '/admin'
      };
      return routes[rol] || '/';
    } catch {
      return '/';
    }
  }

  get logoRoute(): string {
    return this.getRoleHomeRoute();
  }

  get panelRoute(): string {
    return this.effectiveLoggedIn ? this.getRoleHomeRoute() : '/login';
  }
}
