import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ProductService, Product } from '../../services/product.service';
import { ModalService } from '../../services/modal.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule
  ],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css'
})
export class LandingComponent implements OnInit {
  products: Product[] = [];

  constructor(
    private productService: ProductService,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    this.products = this.productService.getProducts();
  }

  addToCart(product: Product): void {
    this.productService.addToCart(product, 1);
    this.showMessage(`${product.name} agregado al carrito`, 'success');
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


