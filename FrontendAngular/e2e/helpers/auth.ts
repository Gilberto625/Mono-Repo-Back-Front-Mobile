import { expect, Page } from '@playwright/test';

export const e2ePassword = process.env.E2E_STAGING_PASSWORD || '';
export const e2eAdminUser = process.env.E2E_STAGING_USERNAME_ADMIN || 'e2e_admin_stylo';
export const e2eClientUser = process.env.E2E_STAGING_USERNAME_CLIENT || 'e2e_cliente_stylo';

export function e2eCredentialsConfigured(): boolean {
  return Boolean(e2ePassword.trim());
}

export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

export async function assertNoTokenLeaksInConsole(page: Page): Promise<void> {
  const leaks: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./.test(text)) {
      leaks.push('JWT pattern in console');
    }
    if (/access.*token|refresh.*token/i.test(text) && text.length > 80) {
      leaks.push('token logged in console');
    }
  });
  await page.waitForTimeout(500);
  expect(leaks, leaks.join(', ')).toHaveLength(0);
}
