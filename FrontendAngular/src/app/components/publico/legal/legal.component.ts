import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { AdminService } from '../../../services/admin.service';

interface ContenidoPublico {
  tipo: string;
  tipo_display: string;
  titulo: string;
  contenido: string;
}

@Component({
  selector: 'app-legal',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent, ScrollRevealDirective],
  templateUrl: './legal.component.html',
  styleUrl: './legal.component.css'
})
export class LegalComponent implements OnInit {
  private adminService = inject(AdminService);
  private route = inject(ActivatedRoute);

  contenidos: ContenidoPublico[] = [];
  loading = true;
  tipoFiltro: string | null = null;

  /** Mapa de tipo a un icono SVG inline. */
  iconos: Record<string, string> = {
    mision: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    vision: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    valores: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    privacidad: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    terminos: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  };

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      this.tipoFiltro = params['tipo'] || null;
      this.cargar();
    });
  }

  cargar(): void {
    this.loading = true;
    this.adminService.getContenidoLegalPublico(this.tipoFiltro || undefined).subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.ok) {
          this.contenidos = res.contenidos || [];
        }
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  getIcono(tipo: string): string {
    return this.iconos[tipo] || this.iconos['mision'];
  }
}
