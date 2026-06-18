import { Component, inject, signal, computed, effect, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { ServicioService } from '../../../services/servicio.service';

type CategoriaFiltro = 'todos' | 'corte' | 'barba' | 'tratamiento' | 'combo';
type OrdenFiltro = 'popularidad' | 'precio_asc' | 'precio_desc' | 'duracion';

@Component({
  selector: 'app-cliente-servicios',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './cliente-servicios.component.html',
  styleUrl: './cliente-servicios.component.css'
})
export class ClienteServiciosComponent implements OnInit {
  private servicioService = inject(ServicioService);

  /** 4 columnas × 3 filas */
  readonly serviciosPorPagina = 12;

  categoriaActiva = signal<CategoriaFiltro>('todos');
  ordenActivo = signal<OrdenFiltro>('popularidad');
  paginaActual = signal(1);

  serviciosFiltrados = computed(() => {
    let servicios = [...this.servicioService.servicios()];

    if (this.categoriaActiva() !== 'todos') {
      servicios = servicios.filter(s => s.categoria === this.categoriaActiva());
    }

    switch (this.ordenActivo()) {
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

  totalPaginas = computed(() => {
    const n = this.serviciosFiltrados().length;
    return Math.max(1, Math.ceil(n / this.serviciosPorPagina));
  });

  serviciosPagina = computed(() => {
    const all = this.serviciosFiltrados();
    const p = Math.min(this.paginaActual(), this.totalPaginas());
    const start = (p - 1) * this.serviciosPorPagina;
    return all.slice(start, start + this.serviciosPorPagina);
  });

  constructor() {
    effect(() => {
      const total = this.totalPaginas();
      const p = this.paginaActual();
      if (p > total) {
        this.paginaActual.set(total);
      }
    });
  }

  ngOnInit(): void {
    this.servicioService.loadServiciosPublicos();
  }

  filtrarCategoria(categoria: CategoriaFiltro): void {
    this.categoriaActiva.set(categoria);
    this.paginaActual.set(1);
  }

  ordenar(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.ordenActivo.set(select.value as OrdenFiltro);
    this.paginaActual.set(1);
  }

  irAPagina(pagina: number): void {
    const total = this.totalPaginas();
    const p = Math.max(1, Math.min(total, pagina));
    this.paginaActual.set(p);
    document.getElementById('catalogo-servicios')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  irPaginaAnterior(): void {
    this.irAPagina(this.paginaActual() - 1);
  }

  irPaginaSiguiente(): void {
    this.irAPagina(this.paginaActual() + 1);
  }
}
