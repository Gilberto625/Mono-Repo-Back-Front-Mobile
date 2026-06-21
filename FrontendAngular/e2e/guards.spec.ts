import { test, expect } from '@playwright/test';
import {
  e2eAdminUser,
  e2eClientUser,
  e2eCredentialsConfigured,
  e2ePassword,
  loginAs,
} from './helpers/auth';

test.describe('Guards — anónimo', () => {
  test('no entra a /cliente', async ({ page }) => {
    await page.goto('/cliente');
    await expect(page).toHaveURL(/\/login/);
  });

  test('no entra a /admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login/);
  });

  test('no entra a /secretaria', async ({ page }) => {
    await page.goto('/secretaria');
    await expect(page).toHaveURL(/\/login/);
  });

  test('no entra a /barbero', async ({ page }) => {
    await page.goto('/barbero');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Guards — cliente E2E', () => {
  test.skip(!e2eCredentialsConfigured(), 'E2E_STAGING_PASSWORD no configurada');

  test.beforeEach(async ({ page }) => {
    await loginAs(page, e2eClientUser, e2ePassword);
  });

  test('entra a panel cliente', async ({ page }) => {
    await page.goto('/cliente');
    await expect(page).toHaveURL(/\/cliente/);
  });

  test('no entra a /admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/\/admin\/dashboard/);
    await expect(page).toHaveURL(/\/(cliente|login)/);
  });

  test('no entra a /secretaria', async ({ page }) => {
    await page.goto('/secretaria');
    await expect(page).not.toHaveURL(/\/secretaria\/dashboard/);
    await expect(page).toHaveURL(/\/(cliente|login)/);
  });

  test('no entra a /barbero', async ({ page }) => {
    await page.goto('/barbero');
    await expect(page).not.toHaveURL(/\/barbero/);
    await expect(page).toHaveURL(/\/(cliente|login)/);
  });

  test('puede ver catálogo público', async ({ page }) => {
    await page.goto('/servicios');
    await expect(page).toHaveURL(/\/servicios/);
    await expect(page.locator('body')).not.toContainText(/Traceback|Exception|SQLSTATE/i);
  });
});

test.describe('Guards — admin E2E', () => {
  test.skip(!e2eCredentialsConfigured(), 'E2E_STAGING_PASSWORD no configurada');

  test('login admin y acceso a panel', async ({ page }) => {
    await loginAs(page, e2eAdminUser, e2ePassword);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.locator('body')).not.toContainText(/Traceback|Exception|SQLSTATE/i);
  });
});
