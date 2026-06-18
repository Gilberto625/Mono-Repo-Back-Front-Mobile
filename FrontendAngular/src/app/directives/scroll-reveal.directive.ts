import {
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  afterNextRender,
  inject
} from '@angular/core';

export type ScrollRevealMode = 'reveal' | 'reveal-left' | 'reveal-right' | 'reveal-scale' | 'stagger';

@Directive({
  selector: '[appScrollReveal]',
  standalone: true
})
export class ScrollRevealDirective implements OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private observer?: IntersectionObserver;

  /** Bare `appScrollReveal` binds as `""` / `true` in templates; normalize to default mode. */
  @Input() appScrollReveal: ScrollRevealMode | '' | boolean = 'reveal';

  constructor() {
    afterNextRender(() => this.setup());
  }

  private resolveMode(): ScrollRevealMode {
    const v = this.appScrollReveal;
    if (v === '' || typeof v === 'boolean') return 'reveal';
    return v;
  }

  private setup(): void {
    const host = this.el.nativeElement;
    const mode = this.resolveMode();
    const cls =
      mode === 'stagger'
        ? 'pp-stagger'
        : mode === 'reveal-left'
          ? 'pp-reveal-left'
          : mode === 'reveal-right'
            ? 'pp-reveal-right'
            : mode === 'reveal-scale'
              ? 'pp-reveal-scale'
              : 'pp-reveal';
    host.classList.add(cls);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('pp-visible');
            this.observer?.unobserve(e.target);
          }
        }
      },
      { threshold: 0.06, rootMargin: '0px 0px -32px 0px' }
    );
    this.observer.observe(host);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
