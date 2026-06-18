import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService, Usuario } from '../../services/auth.service';
import { ProductService, Product } from '../../services/product.service';
import { ModalService } from '../../services/modal.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css'
})
export class HomeComponent implements OnInit {
  currentUser: Usuario | null = null;
  products: Product[] = [];

  constructor(
    private authService: AuthService,
    private router: Router,
    private productService: ProductService,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    // Obtener usuario actual
    this.currentUser = this.authService.getCurrentUser();
    // Obtener productos
    this.products = this.productService.getProducts();
  }

  addToCart(product: Product): void {
    this.productService.addToCart(product, 1);
    this.showMessage(`${product.name} agregado al carrito`, 'success');
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  private showMessage(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    if (type === 'error') {
      this.modalService.showError(message);
    } else if (type === 'success') {
      this.modalService.showSuccess(message);
    } else {
      this.modalService.showInfo(message);
    }
  }
}
