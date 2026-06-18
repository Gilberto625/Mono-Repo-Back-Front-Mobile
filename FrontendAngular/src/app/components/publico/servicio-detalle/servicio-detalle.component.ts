import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { ServicioService } from '../../../services/servicio.service';
import { AuthService } from '../../../services/auth.service';
import { Servicio } from '../../../models';

@Component({
  selector: 'app-servicio-detalle',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    NavbarComponent,
    FooterComponent,
    SidebarComponent,
    BreadcrumbComponent,
    ScrollRevealDirective
  ],
  templateUrl: './servicio-detalle.component.html',
  styleUrl: './servicio-detalle.component.css'
})
export class ServicioDetalleComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private servicioService = inject(ServicioService);
  private authService = inject(AuthService);

  servicio = signal<Servicio | null>(null);
  loading = signal(true);
  imagenActual = signal(0);
  esCliente = false;
  esRecomendador = false;

  get isLoggedIn(): boolean {
    return this.authService.isAuthenticated();
  }

  ngOnInit(): void {
    const fullUrl = this.router.url;
    this.esCliente = fullUrl.startsWith('/cliente/');
    this.esRecomendador = fullUrl.startsWith('/cliente/recomendador/');

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.router.navigate([this.rutaLista]);
      return;
    }
    this.servicioService.getServicioPublicoById(id).subscribe({
      next: (s) => {
        this.loading.set(false);
        if (s) {
          this.servicio.set(s);
        } else {
          this.router.navigate([this.rutaLista]);
        }
      },
      error: () => {
        this.loading.set(false);
        this.router.navigate([this.rutaLista]);
      }
    });
  }

  get rutaLista(): string {
    if (this.esRecomendador) return '/cliente/recomendador';
    return this.esCliente ? '/cliente/servicios' : '/servicios';
  }

  get textoVolver(): string {
    if (this.esRecomendador) return 'Volver a recomendaciones';
    return 'Volver a servicios';
  }

  /** Lista de URLs de la galería (hasta 5); si no hay galería, usa imagen principal */
  imagenes(s: Servicio | null): string[] {
    if (!s) return [];
    if (s.imagenesGaleria?.length) return s.imagenesGaleria.filter(Boolean);
    if (s.imagen) return [s.imagen];
    return [];
  }

  setImagenActual(index: number): void {
    this.imagenActual.set(index);
  }

  volver(): void {
    this.router.navigate([this.rutaLista]);
  }
}
