import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  icon: string;
  category: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

@Injectable({
  providedIn: 'root'
})
export class ProductService {
  private products: Product[] = [
    {
      id: 1,
      name: 'Corte de Cabello',
      description: 'Corte profesional de cabello con las últimas tendencias',
      price: 150,
      icon: '✂️',
      category: 'servicios'
    },
    {
      id: 2,
      name: 'Corte + Barba',
      description: 'Corte de cabello y arreglo de barba completo',
      price: 250,
      icon: '👔',
      category: 'servicios'
    },
    {
      id: 3,
      name: 'Arreglo de Barba',
      description: 'Arreglo y diseño profesional de barba',
      price: 120,
      icon: '🧔',
      category: 'servicios'
    },
    {
      id: 4,
      name: 'Cera para Cabello',
      description: 'Cera profesional para peinado y fijación',
      price: 180,
      icon: '💇',
      category: 'productos'
    },
    {
      id: 5,
      name: 'Shampoo Profesional',
      description: 'Shampoo de alta calidad para cabello y cuero cabelludo',
      price: 220,
      icon: '🧴',
      category: 'productos'
    },
    {
      id: 6,
      name: 'Acondicionador',
      description: 'Acondicionador reparador y nutritivo',
      price: 200,
      icon: '🧴',
      category: 'productos'
    },
    {
      id: 7,
      name: 'Pomada para Cabello',
      description: 'Pomada de alta fijación y brillo natural',
      price: 190,
      icon: '💼',
      category: 'productos'
    },
    {
      id: 8,
      name: 'Aceite para Barba',
      description: 'Aceite nutritivo para barba y bigote',
      price: 160,
      icon: '🛢️',
      category: 'productos'
    },
    {
      id: 9,
      name: 'Tratamiento Capilar',
      description: 'Tratamiento reparador y revitalizante',
      price: 300,
      icon: '💆',
      category: 'servicios'
    },
    {
      id: 10,
      name: 'Tinte para Cabello',
      description: 'Tinte profesional de alta calidad',
      price: 350,
      icon: '🎨',
      category: 'servicios'
    }
  ];

  private cartSubject = new BehaviorSubject<CartItem[]>(this.loadCartFromStorage());
  public cart$ = this.cartSubject.asObservable();

  constructor() {
    // Cargar carrito del localStorage al iniciar
    this.loadCartFromStorage();
  }

  /**
   * Obtener todos los productos
   */
  getProducts(): Product[] {
    return this.products;
  }

  /**
   * Obtener producto por ID
   */
  getProductById(id: number): Product | undefined {
    return this.products.find(p => p.id === id);
  }

  /**
   * Agregar producto al carrito
   */
  addToCart(product: Product, quantity: number = 1): void {
    const cart = this.cartSubject.value;
    const existingItem = cart.find(item => item.product.id === product.id);

    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      cart.push({ product, quantity });
    }

    this.updateCart(cart);
  }

  /**
   * Remover producto del carrito
   */
  removeFromCart(productId: number): void {
    const cart = this.cartSubject.value.filter(item => item.product.id !== productId);
    this.updateCart(cart);
  }

  /**
   * Actualizar cantidad de un producto en el carrito
   */
  updateQuantity(productId: number, quantity: number): void {
    const cart = this.cartSubject.value;
    const item = cart.find(item => item.product.id === productId);
    
    if (item) {
      if (quantity <= 0) {
        this.removeFromCart(productId);
      } else {
        item.quantity = quantity;
        this.updateCart(cart);
      }
    }
  }

  /**
   * Obtener carrito actual
   */
  getCart(): CartItem[] {
    return this.cartSubject.value;
  }

  /**
   * Obtener total del carrito
   */
  getCartTotal(): number {
    return this.cartSubject.value.reduce((total, item) => {
      return total + (item.product.price * item.quantity);
    }, 0);
  }

  /**
   * Obtener cantidad total de items en el carrito
   */
  getCartItemsCount(): number {
    return this.cartSubject.value.reduce((total, item) => total + item.quantity, 0);
  }

  /**
   * Limpiar carrito
   */
  clearCart(): void {
    this.updateCart([]);
  }

  /**
   * Actualizar carrito y guardar en localStorage
   */
  private updateCart(cart: CartItem[]): void {
    this.cartSubject.next(cart);
    this.saveCartToStorage(cart);
  }

  /**
   * Guardar carrito en localStorage
   */
  private saveCartToStorage(cart: CartItem[]): void {
    try {
      localStorage.setItem('barber_cart', JSON.stringify(cart));
    } catch (error) {
      console.error('Error guardando carrito:', error);
    }
  }

  /**
   * Cargar carrito desde localStorage
   */
  private loadCartFromStorage(): CartItem[] {
    try {
      const cartData = localStorage.getItem('barber_cart');
      if (cartData) {
        return JSON.parse(cartData);
      }
    } catch (error) {
      console.error('Error cargando carrito:', error);
    }
    return [];
  }
}

