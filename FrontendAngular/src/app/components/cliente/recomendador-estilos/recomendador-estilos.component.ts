import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { ServicioService } from '../../../services/servicio.service';
import { Servicio } from '../../../models';

export type TipoRostro = 'ovalado' | 'redondo' | 'cuadrado' | 'oblongo' | 'corazon' | 'diamante';
export type TipoEstilo = 'clasico' | 'moderno' | 'deportivo' | 'elegante' | 'casual' | 'urbano';
export type QueBusca = 'corte' | 'barba' | 'ambos';

interface Recomendacion {
  servicio: Servicio;
  razon: string;
  puntaje: number;
}

const RAZONES_ROSTRO: Record<TipoRostro, string> = {
  ovalado: 'Tu tipo de rostro ovalado es muy versátil; casi cualquier estilo te queda bien.',
  redondo: 'Con rostro redondo, los cortes que añaden altura y definición te favorecen.',
  cuadrado: 'Para rostro cuadrado, los estilos que suavizan las líneas te quedan excelente.',
  oblongo: 'En rostro oblongo, cortes que añaden volumen a los lados equilibran tu perfil.',
  corazon: 'Con rostro en corazón, equilibrar la barbilla con volumen abajo te favorece.',
  diamante: 'En rostro diamante, estilos que suavizan pómulos y mentón resaltan tus rasgos.'
};

const RAZONES_ESTILO: Record<TipoEstilo, string> = {
  clasico: 'Un look clásico siempre transmite elegancia y confianza.',
  moderno: 'Un estilo moderno te da un aire fresco y actual.',
  deportivo: 'Un corte deportivo es práctico y siempre luce bien.',
  elegante: 'Un estilo elegante resalta tu personalidad con sofisticación.',
  casual: 'Un look casual es cómodo y versátil para cualquier ocasión.',
  urbano: 'Un estilo urbano te da personalidad y actitud.'
};

const ROSTROS: { value: TipoRostro; label: string }[] = [
  { value: 'ovalado', label: 'Ovalado' },
  { value: 'redondo', label: 'Redondo' },
  { value: 'cuadrado', label: 'Cuadrado' },
  { value: 'oblongo', label: 'Oblongo' },
  { value: 'corazon', label: 'Corazón' },
  { value: 'diamante', label: 'Diamante' }
];

const ESTILOS: { value: TipoEstilo; label: string }[] = [
  { value: 'clasico', label: 'Clásico' },
  { value: 'moderno', label: 'Moderno' },
  { value: 'deportivo', label: 'Deportivo' },
  { value: 'elegante', label: 'Elegante' },
  { value: 'casual', label: 'Casual' },
  { value: 'urbano', label: 'Urbano' }
];

@Component({
  selector: 'app-recomendador-estilos',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './recomendador-estilos.component.html',
  styleUrl: './recomendador-estilos.component.css'
})
export class RecomendadorEstilosComponent implements OnInit {
  private servicioService = inject(ServicioService);
  private router = inject(Router);

  tipoRostro = signal<TipoRostro | null>(null);
  tipoEstilo = signal<TipoEstilo | null>(null);
  queBusca = signal<QueBusca | null>(null);
  yaConsulto = signal(false);

  readonly ROSTROS = ROSTROS;
  readonly ESTILOS = ESTILOS;

  ngOnInit(): void {
    this.servicioService.loadServiciosPublicos();
  }

  recomendaciones = computed<Recomendacion[]>(() => {
    if (!this.yaConsulto()) return [];
    const rostro = this.tipoRostro();
    const estilo = this.tipoEstilo();
    const busca = this.queBusca();
    if (!rostro || !estilo || !busca) return [];

    const servicios = this.servicioService.servicios();
    const activos = servicios.filter(s => s.activo);

    // 1. Filtrar por categoría según qué busca
    let filtrados: Servicio[];
    if (busca === 'corte') {
      filtrados = activos.filter(s => s.categoria === 'corte');
    } else if (busca === 'barba') {
      filtrados = activos.filter(s => s.categoria === 'barba');
    } else {
      filtrados = activos.filter(s => s.categoria === 'combo' || s.categoria === 'corte' || s.categoria === 'barba');
    }

    // 2. Calcular puntaje de coincidencia por etiquetas
    const etiquetaRostro = `rostro-${rostro}`;
    const etiquetaEstilo = `estilo-${estilo}`;

    const recomendaciones: Recomendacion[] = [];

    for (const servicio of filtrados) {
      const tags = servicio.etiquetas || [];
      let puntaje = 0;
      if (tags.includes(etiquetaRostro)) puntaje += 2;
      if (tags.includes(etiquetaEstilo)) puntaje += 1;

      if (puntaje === 0) continue;

      let razon = RAZONES_ROSTRO[rostro];
      if (tags.includes(etiquetaRostro) && tags.includes(etiquetaEstilo)) {
        razon += ' ' + RAZONES_ESTILO[estilo];
      } else if (tags.includes(etiquetaRostro)) {
        razon += ' Este servicio es ideal para tu tipo de rostro.';
      } else if (tags.includes(etiquetaEstilo)) {
        razon = RAZONES_ESTILO[estilo] + ' Este servicio encaja con tu estilo.';
      }

      recomendaciones.push({ servicio, razon, puntaje });
    }

    // 3. Ordenar por mayor coincidencia
    recomendaciones.sort((a, b) => {
      if (b.puntaje !== a.puntaje) return b.puntaje - a.puntaje;
      if (a.servicio.popular && !b.servicio.popular) return -1;
      if (!a.servicio.popular && b.servicio.popular) return 1;
      return 0;
    });

    return recomendaciones;
  });

  seleccionarRostro(v: TipoRostro): void {
    this.tipoRostro.set(v);
  }
  seleccionarEstilo(v: TipoEstilo): void {
    this.tipoEstilo.set(v);
  }
  seleccionarQueBusca(v: QueBusca): void {
    this.queBusca.set(v);
  }

  verRecomendaciones(): void {
    this.yaConsulto.set(true);
  }

  nuevaBusqueda(): void {
    this.yaConsulto.set(false);
    this.tipoRostro.set(null);
    this.tipoEstilo.set(null);
    this.queBusca.set(null);
  }

  // ── Navegar al detalle del servicio dentro del recomendador ──
  verDetalle(servicioId: string): void {
    this.router.navigate(['/cliente/recomendador', servicioId]);
  }

  // ── Navegar a agendar cita con servicio preseleccionado ──
  irAgendar(servicioId: string): void {
    this.router.navigate(['/cliente/agendar'], { queryParams: { servicio: servicioId } });
  }
}
