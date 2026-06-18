import os
import unittest

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.firefox.service import Service as FirefoxService
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager
from webdriver_manager.firefox import GeckoDriverManager


class AdminRespaldoSeleniumTest(unittest.TestCase):
    """
    Prueba E2E (no unitaria) para validar flujo crítico:
    login admin -> panel admin -> respaldo DB carga estado.
    """

    @classmethod
    def setUpClass(cls):
        cls.base_url = os.getenv("SELENIUM_BASE_URL", "http://localhost:4200").rstrip("/")
        cls.username = os.getenv("SELENIUM_ADMIN_USER", "").strip()
        cls.password = os.getenv("SELENIUM_ADMIN_PASS", "").strip()
        cls.driver_name = os.getenv("SELENIUM_DRIVER", "chrome").strip().lower()
        cls.headless = os.getenv("SELENIUM_HEADLESS", "true").strip().lower() not in {"0", "false", "no"}
        cls.timeout = int(os.getenv("SELENIUM_TIMEOUT", "25"))

        if not cls.username or not cls.password:
            raise unittest.SkipTest(
                "Define SELENIUM_ADMIN_USER y SELENIUM_ADMIN_PASS para correr este test."
            )

    def setUp(self):
        if self.driver_name == "firefox":
            options = FirefoxOptions()
            if self.headless:
                options.add_argument("-headless")
            service = FirefoxService(GeckoDriverManager().install())
            self.driver = webdriver.Firefox(service=service, options=options)
        else:
            options = ChromeOptions()
            if self.headless:
                options.add_argument("--headless=new")
            options.add_argument("--window-size=1600,1000")
            options.add_argument("--disable-gpu")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            service = ChromeService(ChromeDriverManager().install())
            self.driver = webdriver.Chrome(service=service, options=options)
        self.wait = WebDriverWait(self.driver, self.timeout)

    def tearDown(self):
        self.driver.quit()

    def _login_admin(self):
        self.driver.get(f"{self.base_url}/login")
        self.wait.until(EC.presence_of_element_located((By.ID, "email"))).send_keys(self.username)
        self.driver.find_element(By.ID, "password").send_keys(self.password)
        self.driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()

        try:
            self.wait.until(EC.url_contains("/admin"))
        except TimeoutException as exc:
            current_url = self.driver.current_url
            if "/verify-2fa" in current_url:
                raise unittest.SkipTest(
                    "La cuenta requiere 2FA interactivo; usa un usuario de pruebas sin 2FA para Selenium."
                ) from exc
            raise AssertionError(
                f"No redirigió al panel admin tras login. URL actual: {current_url}"
            ) from exc

    def test_admin_respaldo_page_loads_without_backend_error(self):
        self._login_admin()
        self.driver.get(f"{self.base_url}/admin/respaldo-db")

        self.wait.until(
            EC.presence_of_element_located(
                (By.XPATH, "//h1[contains(normalize-space(), 'Respaldos de base de datos')]")
            )
        )

        refresh_btn = self.wait.until(
            EC.element_to_be_clickable(
                (By.XPATH, "//button[contains(normalize-space(), 'Actualizar estado')]")
            )
        )
        refresh_btn.click()

        # Si aparece alerta de error, fallamos mostrando el texto exacto.
        error_alerts = self.driver.find_elements(By.CSS_SELECTOR, ".alert.alert-error")
        if error_alerts:
            text = (error_alerts[0].text or "").strip()
            self.fail(f"La página de respaldo reportó error backend: {text}")


if __name__ == "__main__":
    unittest.main()
