import { Component, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { ServicioService } from '../../../services/servicio.service';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-inicio',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent, ScrollRevealDirective],
  template: `
    <app-navbar></app-navbar>

    <!-- Hero premium (landing) -->
    <section class="hero hero--premium">
      <div class="hero-premium-visual" aria-hidden="true">
        <div class="hero-orb hero-orb--1"></div>
        <div class="hero-orb hero-orb--2"></div>
        <div class="hero-orb hero-orb--3"></div>
      </div>

      <div class="container hero-premium-inner text-center">
        <div class="hero-eyebrow">
          <span class="hero-eyebrow-dot"></span>
          Barbería premium
        </div>

        <h1 class="hero-premium-title">
          <span class="hero-w"><span>Tu</span></span>
          <span class="hero-w"><span>Estilo,</span></span>
          <span class="hero-w"><span>Nuestra</span></span>
          <span class="hero-w"><span class="text-gradient-gold">Pasión</span></span>
        </h1>

        <p class="hero-premium-sub">
          Descubre la experiencia de una barbería premium. Cortes modernos, ambiente exclusivo y atención personalizada.
        </p>

        <div class="hero-buttons hero-premium-actions">
          <a routerLink="/agendar" class="btn btn-primary btn--premium-primary">Agendar cita</a>
          <a routerLink="/servicios" class="btn btn-secondary btn--premium-outline">Ver servicios</a>
        </div>
      </div>
    </section>

    <!-- Carrusel premium de funcionalidades -->
    <section class="marquee-section marquee-section--premium" aria-label="Funcionalidades destacadas">
      <div class="marquee-track">
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12" /></svg>
          Servicios premium
        </div>
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
          Citas en tiempo real
        </div>
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>
          Reserva en linea 24/7
        </div>
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></svg>
          Barberos expertos
        </div>
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>
          Atencion personalizada
        </div>
        <div class="marquee-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          Promociones exclusivas
        </div>

        <!-- duplicados para loop continuo -->
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12" /></svg>
          Servicios premium
        </div>
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
          Citas en tiempo real
        </div>
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>
          Reserva en linea 24/7
        </div>
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></svg>
          Barberos expertos
        </div>
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>
          Atencion personalizada
        </div>
        <div class="marquee-item" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          Promociones exclusivas
        </div>
      </div>
    </section>

    <!-- Beneficios -->
    <section class="section">
      <div class="container">
        <div class="pp-section-head" appScrollReveal>
          <div class="pp-section-label">Por qué elegirnos</div>
          <h2 class="pp-section-title">Excelencia en cada detalle</h2>
          <p class="pp-section-sub">Respetamos tu tiempo y elevamos tu imagen con un servicio pensado para ti.</p>
        </div>

        <div class="grid grid-3" appScrollReveal="stagger">
          <div class="card text-center card--benefit card--premium-hover">
            <div class="stat-card-icon" style="margin: 0 auto var(--spacing-md);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <h3>Puntualidad</h3>
            <p class="card-content">Respetamos tu tiempo. Sistema de citas que garantiza atención sin esperas.</p>
          </div>
          <div class="card text-center card--benefit card--premium-hover">
            <div class="stat-card-icon" style="margin: 0 auto var(--spacing-md);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </div>
            <h3>Calidad premium</h3>
            <p class="card-content">Barberos certificados con las últimas tendencias y técnicas.</p>
          </div>
          <div class="card text-center card--benefit card--premium-hover">
            <div class="stat-card-icon" style="margin: 0 auto var(--spacing-md);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path
                  d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                />
              </svg>
            </div>
            <h3>Experiencia única</h3>
            <p class="card-content">Ambiente exclusivo con bebidas de cortesía y atención VIP.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Servicios Destacados -->
    <section class="section section--muted">
      <div class="container">
        <div class="pp-section-head" appScrollReveal>
          <div class="pp-section-label">Catálogo</div>
          <h2 class="pp-section-title">Nuestros servicios</h2>
          <p class="pp-section-sub">Un vistazo a lo más solicitado en la barbería.</p>
        </div>

        <div class="grid grid-4" appScrollReveal="stagger">
          @for (servicio of serviciosDestacados(); track servicio.id) {
            <a
              [routerLink]="['/servicios', servicio.id]"
              class="card card--link-reset card--premium-hover"
            >
              @if (servicio.imagen) {
                <div
                  style="width:100%;aspect-ratio:4/3;overflow:hidden;border-radius:10px;margin-bottom:1rem;background:var(--color-gray-light);"
                >
                  <img
                    [src]="servicio.imagen"
                    [alt]="servicio.nombre"
                    style="width:100%;height:100%;object-fit:contain;display:block;"
                  />
                </div>
              } @else {
                <div
                  style="width:100%;aspect-ratio:4/3;background:var(--color-gray-light);border-radius:10px;margin-bottom:1rem;display:flex;align-items:center;justify-content:center;"
                >
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <path
                      d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                    />
                  </svg>
                </div>
              }
              <h4>{{ servicio.nombre }}</h4>
              <p class="text-small">{{ servicio.duracionMinutos }} min</p>
              <p class="text-gold" style="font-weight: 600;">\${{ servicio.precio }} MXN</p>
            </a>
          }
        </div>

        <div class="text-center mt-lg" appScrollReveal>
          <a routerLink="/servicios" class="btn btn-secondary btn--premium-outline">Ver todos los servicios</a>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="section section--gradient-cta">
      <div class="container text-center pp-cta-inner" appScrollReveal>
        <h2>¿Listo para un nuevo look?</h2>
        <p style="max-width: 500px; margin: 0 auto var(--spacing-lg); opacity: 0.92;">
          Agenda tu cita ahora y disfruta de la mejor experiencia en barbería.
        </p>
        <a routerLink="/register" class="btn btn-primary btn--premium-primary">Agendar ahora</a>
      </div>
    </section>

    <app-footer></app-footer>
  `
})
export class InicioComponent implements OnInit {
  private readonly servicioService = inject(ServicioService);
  private readonly authService = inject(AuthService);

  serviciosDestacados = computed(() => this.servicioService.servicios().slice(0, 4));

  ngOnInit(): void {
    if (this.authService.isAuthenticated()) {
      this.authService.logout();
    }
    this.servicioService.loadServiciosPublicos();
  }
}
