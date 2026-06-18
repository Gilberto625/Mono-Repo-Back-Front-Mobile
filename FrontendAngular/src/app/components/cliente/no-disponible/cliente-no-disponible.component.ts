import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';

@Component({
  selector: 'app-cliente-no-disponible',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './cliente-no-disponible.component.html',
  styleUrl: './cliente-no-disponible.component.css'
})
export class ClienteNoDisponibleComponent {}
