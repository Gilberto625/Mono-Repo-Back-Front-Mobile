import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { map } from 'rxjs';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';

@Component({
  selector: 'app-secretaria-no-disponible',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-no-disponible.component.html',
  styleUrl: './secretaria-no-disponible.component.css'
})
export class SecretariaNoDisponibleComponent {
  private readonly route = inject(ActivatedRoute);

  /** Título de la sección (viene de `data.titulo` en la ruta). */
  readonly titulo = toSignal(this.route.data.pipe(map((d) => d['titulo'] as string | undefined)), {
    initialValue: this.route.snapshot.data['titulo'] as string | undefined
  });
}
