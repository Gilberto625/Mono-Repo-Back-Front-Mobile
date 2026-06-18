import { Component, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { ProductoService } from '../../../services/producto.service';
import { AuthService } from '../../../services/auth.service';
import { CarritoService } from '../../../services/carrito.service';
import { Producto } from '../../../models';

@Component({
  selector: 'app-producto-detalle',
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
  templateUrl: './producto-detalle.component.html',
  styleUrl: './producto-detalle.component.css'
})
export class ProductoDetalleComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private productoService = inject(ProductoService);
  private authService = inject(AuthService);
  private carritoService = inject(CarritoService);
  private autoSlideTimer: ReturnType<typeof setInterval> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private touchStartX: number | null = null;
  private readonly swipeMinDistance = 40;

  producto = signal<Producto | null>(null);
  loading = signal(true);
  agregado = signal(false);
  imagenActual = signal(0);
  animandoImagen = signal(true);
  direccionAnimacion = signal<'rtl' | 'ltr'>('rtl');
  esCliente = false;

  get isLoggedIn(): boolean {
    return this.authService.isAuthenticated();
  }

  ngOnInit(): void {
    const fullUrl = this.router.url;
    this.esCliente = fullUrl.startsWith('/cliente/');

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.router.navigate([this.rutaLista]);
      return;
    }
    this.productoService.getProductoPublicoById(id).subscribe({
      next: (p) => {
        this.loading.set(false);
        if (p) {
          this.producto.set(p);
          this.imagenActual.set(0);
          this.iniciarAutoSlide();
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

  ngOnDestroy(): void {
    this.detenerAutoSlide();
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  get rutaLista(): string {
    return this.esCliente ? '/cliente/productos' : '/productos';
  }

  agregarAlCarrito(): void {
    const p = this.producto();
    if (p) {
      const ok = this.carritoService.agregarItem(p);
      if (ok) {
        this.agregado.set(true);
        setTimeout(() => this.agregado.set(false), 2000);
      }
    }
  }

  irACarrito(): void {
    this.router.navigate(['/cliente/carrito']);
  }

  /** Lista de URLs de la galería (hasta 5); si no hay galería, usa imagen principal */
  imagenes(p: Producto | null): string[] {
    if (!p) return [];
    if (p.imagenesGaleria?.length) return p.imagenesGaleria.filter(Boolean);
    if (p.imagen) return [p.imagen];
    return [];
  }

  setImagenActual(index: number): void {
    if (index === this.imagenActual()) return;
    this.direccionAnimacion.set(index > this.imagenActual() ? 'rtl' : 'ltr');
    this.imagenActual.set(index);
    this.reproducirTransicion();
    this.iniciarAutoSlide();
  }

  onGaleriaPrincipalClick(event: MouseEvent): void {
    const imgs = this.imagenes(this.producto());
    if (imgs.length <= 1) return;
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const mitad = rect.width / 2;
    if (clickX < mitad) {
      this.cambiarImagen(-1);
    } else {
      this.cambiarImagen(1);
    }
  }

  onTouchStart(event: TouchEvent): void {
    const touch = event.touches?.[0];
    this.touchStartX = touch ? touch.clientX : null;
  }

  onTouchEnd(event: TouchEvent): void {
    if (this.touchStartX === null) return;
    const touch = event.changedTouches?.[0];
    if (!touch) {
      this.touchStartX = null;
      return;
    }
    const deltaX = touch.clientX - this.touchStartX;
    this.touchStartX = null;
    if (Math.abs(deltaX) < this.swipeMinDistance) return;
    if (deltaX < 0) {
      this.cambiarImagen(1);
    } else {
      this.cambiarImagen(-1);
    }
  }

  volver(): void {
    this.router.navigate([this.rutaLista]);
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase() || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const imgs = this.imagenes(this.producto());
    if (imgs.length <= 1) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.cambiarImagen(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.cambiarImagen(-1);
    }
  }

  private reproducirTransicion(): void {
    this.animandoImagen.set(false);
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
    }
    this.transitionTimer = setTimeout(() => {
      this.animandoImagen.set(true);
    }, 20);
  }

  private iniciarAutoSlide(): void {
    this.detenerAutoSlide();
    const imgs = this.imagenes(this.producto());
    if (imgs.length <= 1) return;
    this.autoSlideTimer = setInterval(() => {
      this.cambiarImagen(1, false);
    }, 3500);
  }

  private cambiarImagen(delta: 1 | -1, reiniciarAutoSlide: boolean = true): void {
    const total = this.imagenes(this.producto()).length;
    if (total <= 1) return;
    const actual = this.imagenActual();
    const siguiente = (actual + delta + total) % total;
    this.direccionAnimacion.set(delta > 0 ? 'rtl' : 'ltr');
    this.imagenActual.set(siguiente);
    this.reproducirTransicion();
    if (reiniciarAutoSlide) {
      this.iniciarAutoSlide();
    }
  }

  private detenerAutoSlide(): void {
    if (this.autoSlideTimer) {
      clearInterval(this.autoSlideTimer);
      this.autoSlideTimer = null;
    }
  }
}
