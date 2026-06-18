import { Injectable, computed, signal } from '@angular/core';

const STORAGE_KEY = 'stylo-ui-theme';

export type UiTheme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<UiTheme>(this.readStored());

  readonly isDark = computed(() => this.theme() === 'dark');

  constructor() {
    this.apply(this.theme());
  }

  toggle(): void {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  setTheme(t: UiTheme): void {
    this.theme.set(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    this.apply(t);
  }

  private readStored(): UiTheme {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch {
      /* ignore */
    }
    return 'dark';
  }

  private apply(t: UiTheme): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', t);
  }
}
