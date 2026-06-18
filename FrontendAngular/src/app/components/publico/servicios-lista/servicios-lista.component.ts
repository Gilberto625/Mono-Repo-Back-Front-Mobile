import { Component, inject, signal, computed, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { ServicioService } from '../../../services/servicio.service';
import { Servicio } from '../../../models';

type CategoriaFiltro = 'todos' | 'corte' | 'barba' | 'tratamiento' | 'combo';
type OrdenFiltro = 'popularidad' | 'precio_asc' | 'precio_desc' | 'duracion';

@Component({
  selector: 'app-servicios-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent, ScrollRevealDirective],
  template: `
    <app-navbar></app-navbar>

    <div class="servicios-page">
      <section class="servicios-hero" appScrollReveal>
        <div class="servicios-hero__visual" aria-hidden="true">
          <div class="servicios-hero__orb servicios-hero__orb--1"></div>
          <div class="servicios-hero__orb servicios-hero__orb--2"></div>
        </div>
        <div class="container servicios-hero__inner">
          <div class="servicios-eyebrow">
            <span class="servicios-eyebrow__dot"></span>
            Catálogo
          </div>
          <h1 class="servicios-hero__title">Nuestros servicios</h1>
          <p class="servicios-hero__sub">
            Elige tu corte, barba o tratamiento y agenda en minutos. Precios claros y tiempos reales.
          </p>
          <div class="servicios-hero__actions">
            <a routerLink="/agendar" class="btn btn-primary btn--premium-primary">Agendar cita</a>
            <a routerLink="/" class="btn btn-secondary btn--premium-outline">Volver al inicio</a>
          </div>
        </div>
      </section>

      <section class="section servicios-section">
        <div class="container">
          <div class="servicios-toolbar" appScrollReveal="reveal-scale">
            <div class="servicios-toolbar__row">
              <div class="tabs tabs--premium servicios-tabs" role="tablist" aria-label="Filtrar por categoría">
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [class.active]="categoriaActiva() === 'todos'"
                  [attr.aria-selected]="categoriaActiva() === 'todos'"
                  (click)="filtrarCategoria('todos')"
                >
                  Todos
                </button>
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [class.active]="categoriaActiva() === 'corte'"
                  [attr.aria-selected]="categoriaActiva() === 'corte'"
                  (click)="filtrarCategoria('corte')"
                >
                  Cortes
                </button>
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [class.active]="categoriaActiva() === 'barba'"
                  [attr.aria-selected]="categoriaActiva() === 'barba'"
                  (click)="filtrarCategoria('barba')"
                >
                  Barba
                </button>
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [class.active]="categoriaActiva() === 'tratamiento'"
                  [attr.aria-selected]="categoriaActiva() === 'tratamiento'"
                  (click)="filtrarCategoria('tratamiento')"
                >
                  Tratamientos
                </button>
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [class.active]="categoriaActiva() === 'combo'"
                  [attr.aria-selected]="categoriaActiva() === 'combo'"
                  (click)="filtrarCategoria('combo')"
                >
                  Combos
                </button>
              </div>
              <div class="servicios-sort">
                <label class="servicios-sort__label" for="orden-servicios">Ordenar</label>
                <div class="servicios-sort__wrap">
                  <select
                  id="orden-servicios"
                  class="servicios-sort__select"
                  [value]="ordenActivo()"
                  (change)="ordenar($event)"
                >
                    <option value="popularidad">Popularidad</option>
                    <option value="precio_asc">Precio: menor a mayor</option>
                    <option value="precio_desc">Precio: mayor a menor</option>
                    <option value="duracion">Duración</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          @if (totalServicios() > 0) {
            <div class="public-catalog-toolbar" appScrollReveal="reveal-scale">
              <span class="public-catalog-pill">
                Mostrando {{ rangoInicio() }}–{{ rangoFin() }} de {{ totalServicios() }} servicio{{ totalServicios() === 1 ? '' : 's' }}
              </span>
              @if (totalPaginas() > 1) {
                <nav class="public-catalog-pagination" role="navigation" aria-label="Paginación de servicios">
                  <button
                    type="button"
                    class="public-pag-nav"
                    [disabled]="pagina() <= 1"
                    (click)="irAPagina(pagina() - 1)"
                  >
                    Anterior
                  </button>
                  <div class="public-pagination-pages">
                    @for (item of indicadoresPaginacion(); track $index) {
                      @if (item.kind === 'gap') {
                        <span class="public-pagination-gap" aria-hidden="true">…</span>
                      } @else {
                        <button
                          type="button"
                          class="public-pagination-page"
                          [class.public-pagination-page--active]="pagina() === item.n"
                          [attr.aria-current]="pagina() === item.n ? 'page' : null"
                          (click)="irAPagina(item.n)"
                        >
                          {{ item.n }}
                        </button>
                      }
                    }
                  </div>
                  <span class="public-pagination-meta">Página {{ pagina() }} / {{ totalPaginas() }}</span>
                  <button
                    type="button"
                    class="public-pag-nav"
                    [disabled]="pagina() >= totalPaginas()"
                    (click)="irAPagina(pagina() + 1)"
                  >
                    Siguiente
                  </button>
                </nav>
              }
            </div>
          }

          <div class="servicios-grid" appScrollReveal="stagger">
            @for (servicio of serviciosPagina(); track servicio.id) {
              <article class="servicio-card card--premium-hover">
                <a [routerLink]="['/servicios', servicio.id]" class="servicio-card__media">
                  @if (imagenServicio(servicio); as img) {
                    <div class="servicio-card__image-wrap">
                      <img [src]="img" [alt]="servicio.nombre" class="servicio-card__image" loading="lazy" />
                    </div>
                  } @else {
                    <div class="servicio-card__placeholder" aria-hidden="true">
                      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
                        <path
                          d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                        />
                      </svg>
                    </div>
                  }
                  @if (servicio.popular) {
                    <span class="servicio-card__badge">Popular</span>
                  }
                </a>
                <div class="servicio-card__body">
                  <a [routerLink]="['/servicios', servicio.id]" class="servicio-card__title-link">
                    <h3 class="servicio-card__title">{{ servicio.nombre }}</h3>
                  </a>
                  <p class="servicio-card__desc">{{ servicio.descripcion }}</p>
                  <div class="servicio-card__meta">
                    <span class="servicio-card__price">\${{ servicio.precio }} <span class="servicio-card__currency">MXN</span></span>
                    <span class="servicio-card__duration">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      {{ servicio.duracionMinutos }} min
                    </span>
                  </div>
                  <a [routerLink]="['/servicios', servicio.id]" class="btn btn-primary btn--premium-primary servicio-card__cta">Ver detalle</a>
                </div>
              </article>
            } @empty {
              <div class="servicios-empty" style="grid-column: 1 / -1;">
                <div class="servicios-empty__icon" aria-hidden="true">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <p class="servicios-empty__text">No hay servicios disponibles en esta categoría.</p>
                <button type="button" class="btn btn-secondary btn--premium-outline" (click)="filtrarCategoria('todos')">
                  Ver todos
                </button>
              </div>
            }
          </div>
        </div>
      </section>
    </div>

    <app-footer></app-footer>
  `,
  styles: [`
    .servicios-page {
      min-height: 100vh;
      background: var(--surface-page);
    }

    .servicios-hero {
      position: relative;
      overflow: hidden;
      padding: clamp(5.5rem, 12vw, 7rem) 0 clamp(2.5rem, 6vw, 3.5rem);
      text-align: center;
      border-bottom: 1px solid rgba(61, 79, 73, 0.25);
    }

    .servicios-hero__visual {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
    }

    .servicios-hero__orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(72px);
      opacity: 0.55;
      animation: servHeroOrb 10s ease-in-out infinite alternate;
    }

    .servicios-hero__orb--1 {
      width: min(420px, 70vw);
      height: min(420px, 70vw);
      top: -120px;
      left: -80px;
      background: radial-gradient(circle, rgba(50, 65, 61, 0.5) 0%, transparent 68%);
    }

    .servicios-hero__orb--2 {
      width: min(360px, 60vw);
      height: min(360px, 60vw);
      bottom: -100px;
      right: -60px;
      background: radial-gradient(circle, rgba(212, 175, 55, 0.12) 0%, transparent 70%);
      animation-delay: -4s;
    }

    @keyframes servHeroOrb {
      from {
        transform: translate(0, 0) scale(1);
      }
      to {
        transform: translate(16px, 12px) scale(1.04);
      }
    }

    .servicios-hero__inner {
      position: relative;
      z-index: 1;
      max-width: 640px;
      margin: 0 auto;
    }

    .servicios-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      margin-bottom: 1rem;
      font-family: 'Outfit', var(--font-family);
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-accent);
      background: rgba(212, 175, 55, 0.1);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-radius: 99px;
    }

    .servicios-eyebrow__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--color-accent);
      animation: servEyebrowPulse 1.8s ease-in-out infinite;
    }

    @keyframes servEyebrowPulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }

    .servicios-hero__title {
      font-family: 'Outfit', var(--font-family);
      font-size: clamp(1.85rem, 4.5vw, 2.65rem);
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1.12;
      color: var(--text-on-dark);
      margin: 0 0 0.75rem;
    }

    .servicios-hero__sub {
      font-size: 1.02rem;
      line-height: 1.65;
      color: var(--text-on-dark-secondary);
      margin: 0 0 1.5rem;
    }

    .servicios-hero__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      justify-content: center;
    }

    html[data-theme='light'] .servicios-hero__title {
      color: var(--text-on-light);
    }

    html[data-theme='light'] .servicios-hero__sub {
      color: var(--text-on-light-secondary);
    }

    html[data-theme='light'] .servicios-eyebrow {
      background: rgba(212, 175, 55, 0.12);
    }

    .servicios-section {
      padding-top: var(--spacing-xl);
      padding-bottom: var(--spacing-3xl);
    }

    .servicios-section .container {
      padding-left: max(var(--spacing-md, 1rem), env(safe-area-inset-left, 0px));
      padding-right: max(var(--spacing-md, 1rem), env(safe-area-inset-right, 0px));
      box-sizing: border-box;
    }

    @media (min-width: 768px) {
      .servicios-section .container {
        padding-left: max(var(--spacing-lg, 1.25rem), env(safe-area-inset-left, 0px));
        padding-right: max(var(--spacing-lg, 1.25rem), env(safe-area-inset-right, 0px));
      }
    }

    @media (min-width: 1024px) {
      .servicios-section .container {
        padding-left: max(var(--spacing-xl, 1.5rem), env(safe-area-inset-left, 0px));
        padding-right: max(var(--spacing-xl, 1.5rem), env(safe-area-inset-right, 0px));
      }
    }

    .servicios-toolbar {
      margin-bottom: var(--spacing-xl);
      padding: 1.15rem 1.25rem;
      border-radius: 18px;
      background: rgba(20, 31, 24, 0.55);
      border: 1px solid rgba(61, 79, 73, 0.4);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      box-shadow: var(--shadow-md);
    }

    html[data-theme='light'] .servicios-toolbar {
      background: var(--surface-card);
      border-color: var(--card-border);
    }

    .servicios-toolbar__row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 1.25rem;
    }

    .servicios-tabs {
      flex: 1;
      min-width: min(100%, 520px);
      border-bottom: none !important;
      flex-wrap: wrap;
      gap: 0.35rem;
    }

    .servicios-tabs .tab {
      border: none;
      background: transparent;
      font-family: inherit;
      cursor: pointer;
      margin: 0;
    }

    .servicios-sort {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 200px;
    }

    .servicios-sort__label {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-on-dark-tertiary);
      font-family: 'Outfit', var(--font-family);
    }

    html[data-theme='light'] .servicios-sort__label {
      color: var(--text-on-light-tertiary);
    }

    .servicios-sort__wrap {
      position: relative;
    }

    .servicios-sort__select {
      width: 100%;
      appearance: none;
      -webkit-appearance: none;
      padding: 11px 40px 11px 14px;
      font-size: 0.9rem;
      font-family: var(--font-family);
      font-weight: 500;
      color: var(--text-on-dark);
      background: var(--form-input-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      cursor: pointer;
      transition:
        border-color 0.2s ease,
        box-shadow 0.2s ease;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%23c9a962' stroke-width='2'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      background-size: 18px;
    }

    html[data-theme='light'] .servicios-sort__select {
      color: var(--text-on-light);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%23243830' stroke-width='2'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E");
    }

    .servicios-sort__select:focus {
      outline: none;
      border-color: rgba(212, 175, 55, 0.5);
      box-shadow: 0 0 0 3px rgba(212, 175, 55, 0.12);
    }

    /* Menú nativo del SO suele ser claro; el select en tema oscuro hereda texto claro → opciones ilegibles */
    .servicios-sort__select option {
      color: #13221a !important;
      background-color: #f0f4f0;
    }

    .servicios-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
      gap: clamp(0.85rem, 3vw, var(--spacing-lg));
    }

    .servicio-card {
      display: flex;
      flex-direction: column;
      height: 100%;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid rgba(61, 79, 73, 0.35);
      background: rgba(18, 28, 22, 0.65);
      transition:
        transform 0.35s cubic-bezier(0.34, 1.2, 0.64, 1),
        box-shadow 0.35s ease,
        border-color 0.3s ease;
    }

    html[data-theme='light'] .servicio-card {
      background: var(--surface-card);
      border-color: var(--card-border);
    }

    .servicio-card__media {
      position: relative;
      display: block;
      text-decoration: none;
      color: inherit;
    }

    .servicio-card__image-wrap {
      width: 100%;
      aspect-ratio: 4 / 3;
      overflow: hidden;
      background: var(--color-gray-light);
    }

    .servicio-card__image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
      display: block;
      transition: transform 0.45s cubic-bezier(0.22, 0.68, 0, 1);
    }

    .servicio-card:hover .servicio-card__image {
      transform: scale(1.04);
    }

    .servicio-card__placeholder {
      aspect-ratio: 4 / 3;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(61, 79, 73, 0.2);
      color: var(--text-on-dark-tertiary);
    }

    html[data-theme='light'] .servicio-card__placeholder {
      background: rgba(36, 56, 48, 0.08);
      color: var(--text-on-light-tertiary);
    }

    .servicio-card__badge {
      position: absolute;
      top: 12px;
      left: 12px;
      padding: 5px 12px;
      font-size: 0.65rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #1a1700;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-dark));
      border-radius: 99px;
      box-shadow: 0 4px 14px rgba(212, 175, 55, 0.35);
    }

    .servicio-card__body {
      display: flex;
      flex-direction: column;
      flex: 1;
      padding: 1.15rem 1.2rem 1.25rem;
      gap: 0.5rem;
    }

    .servicio-card__title-link {
      text-decoration: none;
      color: inherit;
    }

    .servicio-card__title {
      font-family: 'Outfit', var(--font-family);
      font-size: 1.12rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin: 0;
      color: var(--text-on-dark);
      transition: color 0.2s ease;
    }

    .servicio-card__title-link:hover .servicio-card__title {
      color: var(--color-accent);
    }

    html[data-theme='light'] .servicio-card__title {
      color: var(--text-on-light);
    }

    html[data-theme='light'] .servicio-card__title-link:hover .servicio-card__title {
      color: var(--color-accent-dark);
    }

    .servicio-card__desc {
      font-size: 0.88rem;
      line-height: 1.55;
      color: var(--text-on-dark-secondary);
      margin: 0;
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    html[data-theme='light'] .servicio-card__desc {
      color: var(--text-on-light-secondary);
    }

    .servicio-card__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding-top: 0.35rem;
    }

    .servicio-card__price {
      font-family: 'Outfit', var(--font-family);
      font-size: 1.2rem;
      font-weight: 800;
      color: var(--color-accent);
      letter-spacing: -0.02em;
    }

    .servicio-card__currency {
      font-size: 0.72rem;
      font-weight: 600;
      opacity: 0.85;
    }

    .servicio-card__duration {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-on-dark-tertiary);
    }

    html[data-theme='light'] .servicio-card__duration {
      color: var(--text-on-light-tertiary);
    }

    .servicio-card__cta {
      width: 100%;
      margin-top: 0.35rem;
      justify-content: center;
      text-align: center;
      text-decoration: none;
    }

    .servicios-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      border-radius: 18px;
      border: 1px dashed rgba(61, 79, 73, 0.45);
      background: rgba(20, 31, 24, 0.35);
    }

    html[data-theme='light'] .servicios-empty {
      background: rgba(36, 56, 48, 0.06);
      border-color: var(--card-border);
    }

    .servicios-empty__icon {
      display: flex;
      justify-content: center;
      margin-bottom: 1rem;
      color: var(--color-accent);
      opacity: 0.85;
    }

    .servicios-empty__text {
      margin: 0 0 1.25rem;
      color: var(--text-on-dark-secondary);
      font-size: 1rem;
    }

    html[data-theme='light'] .servicios-empty__text {
      color: var(--text-on-light-secondary);
    }

    /* Misma barra resultado + paginación que /productos públicos */
    .public-catalog-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      justify-content: flex-start;
      margin-bottom: 1.35rem;
    }

    .public-catalog-pill {
      display: inline-flex;
      align-items: center;
      font-family: 'Inter', var(--font-family, system-ui), sans-serif;
      font-size: 0.82rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: #e8ede6;
      background: rgba(24, 34, 25, 0.85);
      border: 1px solid rgba(61, 79, 73, 0.55);
      border-radius: 999px;
      padding: 7px 16px;
      box-shadow:
        0 4px 18px rgba(0, 0, 0, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.07);
    }

    html[data-theme='light'] .public-catalog-pill {
      color: var(--text-on-light-primary, #1a1f1c);
      background: rgba(255, 255, 255, 0.92);
      border-color: rgba(61, 79, 73, 0.35);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    }

    .public-catalog-pagination {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
      flex: 1;
      min-width: 0;
      justify-content: flex-start;
    }

    .public-pagination-pages {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      max-width: 100%;
    }

    .public-pagination-gap {
      padding: 0 2px;
      color: rgba(232, 237, 230, 0.42);
      font-size: 0.85rem;
      user-select: none;
    }

    html[data-theme='light'] .public-pagination-gap {
      color: rgba(26, 31, 28, 0.45);
    }

    .public-pagination-meta {
      font-family: 'Inter', var(--font-family, system-ui), sans-serif;
      font-size: 0.72rem;
      padding: 0 4px;
      white-space: nowrap;
      color: rgba(232, 237, 230, 0.52);
    }

    html[data-theme='light'] .public-pagination-meta {
      color: rgba(26, 31, 28, 0.55);
    }

    .public-pag-nav,
    .public-pagination-page {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', var(--font-family, system-ui), sans-serif;
      font-size: 0.72rem;
      font-weight: 600;
      min-height: 28px;
      background: rgba(24, 34, 25, 0.85);
      color: #e8ede6;
      border: 1px solid rgba(61, 79, 73, 0.55);
      border-radius: 10px;
      cursor: pointer;
      transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    }

    html[data-theme='light'] .public-pag-nav,
    html[data-theme='light'] .public-pagination-page {
      background: rgba(255, 255, 255, 0.95);
      color: var(--text-on-light-primary, #1a1f1c);
      border-color: rgba(61, 79, 73, 0.4);
    }

    .public-pag-nav {
      padding: 4px 12px;
    }

    .public-pagination-page {
      min-width: 30px;
      padding-left: 8px;
      padding-right: 8px;
    }

    .public-pag-nav:hover:not(:disabled),
    .public-pagination-page:hover:not(:disabled) {
      border-color: rgba(212, 175, 55, 0.3);
      color: #d4af37;
      background: rgba(212, 175, 55, 0.06);
    }

    html[data-theme='light'] .public-pag-nav:hover:not(:disabled),
    html[data-theme='light'] .public-pagination-page:hover:not(:disabled) {
      border-color: rgba(212, 175, 55, 0.45);
      color: #9a7b1a;
    }

    .public-pagination-page--active {
      background: linear-gradient(135deg, #32413d, #28342f);
      border-color: #3d4f49;
      color: #e8ede6;
      box-shadow: 0 2px 10px rgba(50, 65, 61, 0.45);
    }

    html[data-theme='light'] .public-pagination-page--active {
      background: linear-gradient(135deg, #32413d, #28342f);
      color: #e8ede6;
    }

    .public-pagination-page--active:hover:not(:disabled) {
      color: #e8ede6;
      border-color: #3d4f49;
    }

    .public-catalog-pagination button:focus-visible {
      outline: none;
      border-color: rgba(212, 175, 55, 0.35);
      box-shadow: 0 0 0 3px rgba(212, 175, 55, 0.08);
    }

    .public-catalog-pagination button:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }

    @media (min-width: 900px) {
      .public-catalog-toolbar {
        flex-wrap: nowrap;
        justify-content: space-between;
        align-items: center;
      }

      .public-catalog-pagination {
        justify-content: flex-end;
        flex: 1 1 auto;
      }
    }

    @media (max-width: 899px) and (min-width: 561px) {
      .public-catalog-toolbar {
        justify-content: center;
      }

      .public-catalog-pagination {
        justify-content: center;
        flex: 1 1 100%;
      }
    }

    @media (max-width: 720px) {
      .servicios-tabs {
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
        gap: 0.3rem;
        padding-bottom: 6px;
        margin-bottom: -2px;
      }

      .servicios-tabs .tab {
        flex: 0 0 auto;
        white-space: nowrap;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
      }
    }

    @media (max-width: 640px) {
      .servicios-toolbar {
        padding: 1rem max(0.75rem, env(safe-area-inset-left, 0px)) 1rem max(0.75rem, env(safe-area-inset-right, 0px));
      }

      .servicios-toolbar__row {
        flex-direction: column;
        align-items: stretch;
      }

      .servicios-sort {
        min-width: 100%;
      }

      .servicios-hero__sub {
        font-size: clamp(0.92rem, 3.8vw, 1.02rem);
        padding: 0 0.25rem;
      }
    }

    @media (max-width: 560px) {
      .public-catalog-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
        margin-bottom: 1.1rem;
      }

      .public-catalog-pill {
        width: 100%;
        max-width: 100%;
        justify-content: center;
        text-align: center;
        font-size: 0.74rem;
        padding: 8px 12px;
        line-height: 1.35;
        box-sizing: border-box;
        word-break: break-word;
      }

      .public-catalog-pagination {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-areas:
          'pag-prev pag-next'
          'pag-pages pag-pages'
          'pag-meta pag-meta';
        gap: 8px 10px;
        width: 100%;
        flex: none;
        align-items: center;
      }

      .public-catalog-pagination > .public-pag-nav:first-of-type {
        grid-area: pag-prev;
        justify-self: stretch;
        width: 100%;
      }

      .public-catalog-pagination > .public-pag-nav:last-of-type {
        grid-area: pag-next;
        justify-self: stretch;
        width: 100%;
      }

      .public-pagination-pages {
        grid-area: pag-pages;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        flex-wrap: nowrap;
        justify-content: center;
        padding: 6px 2px 8px;
        scrollbar-width: thin;
        box-sizing: border-box;
      }

      .public-pagination-meta {
        grid-area: pag-meta;
        text-align: center;
        width: 100%;
      }

      .public-pag-nav,
      .public-pagination-page {
        min-height: 40px;
        font-size: 0.78rem;
      }

      .public-pagination-page {
        min-width: 36px;
      }

      .servicios-grid {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .servicio-card__body {
        padding: 1rem 1rem 1.1rem;
      }

      .servicio-card__title {
        font-size: 1rem;
      }
    }

    @media (max-width: 380px) {
      .servicios-hero {
        padding-left: max(0.5rem, env(safe-area-inset-left, 0px));
        padding-right: max(0.5rem, env(safe-area-inset-right, 0px));
      }

      .public-catalog-pill {
        font-size: 0.7rem;
        padding: 7px 10px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .servicios-hero__orb {
        animation: none;
      }

      .servicios-eyebrow__dot {
        animation: none;
      }

      .servicio-card:hover .servicio-card__image {
        transform: none;
      }
    }
  `]
})
export class ServiciosListaComponent implements OnInit {
  private readonly servicioService = inject(ServicioService);

  readonly serviciosPorPagina = 8;

  categoriaActiva = signal<CategoriaFiltro>('todos');
  ordenActivo = signal<OrdenFiltro>('popularidad');
  pagina = signal(1);

  constructor() {
    effect(() => {
      const max = this.totalPaginas();
      const p = this.pagina();
      if (p > max) {
        this.pagina.set(max);
      }
    });
  }

  ngOnInit(): void {
    this.servicioService.loadServiciosPublicos();
  }

  imagenServicio(servicio: Servicio): string | null {
    if (servicio.imagen) return servicio.imagen;
    if (servicio.imagenesGaleria?.length) return servicio.imagenesGaleria[0];
    return null;
  }

  serviciosOrdenados = computed(() => {
    const categoria = this.categoriaActiva();
    const orden = this.ordenActivo();
    const base = this.servicioService.servicios();

    let servicios = categoria === 'todos' ? [...base] : base.filter(s => s.categoria === categoria);
    servicios = servicios.slice();

    switch (orden) {
      case 'precio_asc':
        servicios.sort((a, b) => a.precio - b.precio);
        break;
      case 'precio_desc':
        servicios.sort((a, b) => b.precio - a.precio);
        break;
      case 'duracion':
        servicios.sort((a, b) => a.duracionMinutos - b.duracionMinutos);
        break;
      case 'popularidad':
      default:
        servicios.sort((a, b) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0));
        break;
    }

    return servicios;
  });

  totalServicios = computed(() => this.serviciosOrdenados().length);

  totalPaginas = computed(() => {
    const n = this.totalServicios();
    return Math.max(1, Math.ceil(n / this.serviciosPorPagina));
  });

  serviciosPagina = computed(() => {
    const list = this.serviciosOrdenados();
    const p = this.pagina();
    const start = (p - 1) * this.serviciosPorPagina;
    return list.slice(start, start + this.serviciosPorPagina);
  });

  rangoInicio = computed(() => {
    if (this.totalServicios() === 0) {
      return 0;
    }
    return (this.pagina() - 1) * this.serviciosPorPagina + 1;
  });

  rangoFin = computed(() =>
    Math.min(this.pagina() * this.serviciosPorPagina, this.totalServicios())
  );

  indicadoresPaginacion = computed((): Array<{ kind: 'num'; n: number } | { kind: 'gap' }> => {
    const max = this.totalPaginas();
    const cur = this.pagina();
    if (max <= 1) {
      return [];
    }
    const nums = new Set<number>([1, max]);
    for (let d = -3; d <= 3; d++) {
      const x = cur + d;
      if (x >= 1 && x <= max) {
        nums.add(x);
      }
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const out: Array<{ kind: 'num'; n: number } | { kind: 'gap' }> = [];
    let prev = 0;
    for (const n of sorted) {
      if (prev > 0 && n - prev > 1) {
        out.push({ kind: 'gap' });
      }
      out.push({ kind: 'num', n });
      prev = n;
    }
    return out;
  });

  irAPagina(p: number): void {
    const max = this.totalPaginas();
    const next = Math.max(1, Math.min(Math.floor(p), max));
    if (next === this.pagina()) {
      return;
    }
    this.pagina.set(next);
    const el = document.querySelector('.public-catalog-toolbar');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  filtrarCategoria(categoria: CategoriaFiltro): void {
    this.pagina.set(1);
    this.categoriaActiva.set(categoria);
  }

  ordenar(event: Event): void {
    this.pagina.set(1);
    const select = event.target as HTMLSelectElement;
    this.ordenActivo.set(select.value as OrdenFiltro);
  }
}
