import { test, expect } from '@playwright/test';
import {
  e2eAdminUser,
  e2eClientUser,
  e2eCredentialsConfigured,
  e2ePassword,
  loginAs,
  assertNoTokenLeaksInConsole,
} from './helpers/auth';

test.describe('Auth E2E', () => {
  test('login inválido muestra error sin stack trace', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('invalido_e2e@test.stylo.local');
    await page.locator('#password').fill('wrong-password-not-real');
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('body')).not.toContainText(/Traceback|Exception|SQLSTATE|500 Internal/i);
  });

  test.describe('credenciales staging', () => {
    test.skip(!e2eCredentialsConfigured(), 'E2E_STAGING_PASSWORD no configurada');

    test('login cliente redirige fuera de /login', async ({ page }) => {
      await loginAs(page, e2eClientUser, e2ePassword);
      await expect(page).toHaveURL(/\/(cliente|verify-2fa)/);
    });

    test('login admin redirige a panel admin', async ({ page }) => {
      await loginAs(page, e2eAdminUser, e2ePassword);
      await expect(page).toHaveURL(/\/admin/);
      await assertNoTokenLeaksInConsole(page);
    });
  });
});
