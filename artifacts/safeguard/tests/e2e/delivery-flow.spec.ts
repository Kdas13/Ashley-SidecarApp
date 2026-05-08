import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";

/**
 * End-to-end coverage for the "send the GP-export PDF straight to the
 * surgery" flow added in task #15.
 *
 * What this test guards:
 *   1. The review screen surfaces all three channels (QR, NHS-app share,
 *      email) and gates the deliver button on a surgery name being filled.
 *   2. The QR channel returns a token-gated public URL that actually
 *      serves the PDF when fetched, and that fetching it stamps the
 *      delivery as `delivered` in the audit history.
 *   3. The email channel returns a clear failure (`transport_not_configured`)
 *      when SMTP is not wired up, and the UI surfaces a retry path. We
 *      do NOT exercise the success path because that would require
 *      standing up a real SMTP transport, which is operator config.
 *
 * Required env (CI must provide all of these):
 *   - VITE_CLERK_PUBLISHABLE_KEY   (test instance pk_test_…)
 *   - CLERK_PUBLISHABLE_KEY        (same value, for @clerk/testing)
 *   - CLERK_SECRET_KEY             (test instance sk_test_…)
 *   - DATABASE_URL                 (writable Postgres for safeguard tables)
 *   - AI_INTEGRATIONS_OPENAI_BASE_URL + AI_INTEGRATIONS_OPENAI_API_KEY
 *
 * The test depends on a profile/appointment/export already existing for
 * the test user. It walks the same onboarding+intake path as
 * appointment-flow.spec.ts before exercising delivery, so the two specs
 * stay independent.
 */

const TEST_USER_EMAIL = `safeguard.delivery+clerk_test@example.com`;

async function fetchPublicPdf(
  request: APIRequestContext,
  url: string,
): Promise<APIResponse> {
  // The QR's public URL may be relative (no SAFEGUARD_PUBLIC_BASE_URL
  // set) or absolute; Playwright's request fixture handles both.
  return request.get(url);
}

test.beforeAll(async () => {
  await clerkSetup();
});

test("Surgery delivery: QR end-to-end + email failure surfaces retry", async ({
  page,
  request,
}) => {
  // -------------------------------------------------------------------
  // Sign in + drive an appointment to the review screen with a PDF.
  // We re-use the onboarding + intake flow exactly as the appointment
  // happy-path test does. Anything that fails here is upstream of the
  // delivery feature and should be debugged via that spec instead.
  // -------------------------------------------------------------------
  await setupClerkTestingToken({ page });
  await page.goto("/safeguard/");
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: TEST_USER_EMAIL },
  });
  await page.goto("/safeguard/onboarding");
  await expect(page.getByTestId("question-title")).toBeVisible();
  // Walk onboarding to consent.
  await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("input-preferred-name").fill("Delivery Wren");
  await page.getByTestId("button-onboarding-next").click();
  for (let i = 0; i < 3; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("input-country").fill("Ukraine");
  await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("input-dob").fill("1990-01-01");
  await page.getByTestId("button-onboarding-next").click();
  for (let i = 0; i < 4; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  for (let i = 0; i < 5; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  for (let i = 0; i < 3; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("toggle-consent-storage-yes").click();
  await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("toggle-consent-ai-yes").click();
  await page.getByTestId("button-onboarding-next").click();
  await expect(page).toHaveURL(/\/safeguard\/home$/);

  // Create a minimal appointment.
  await page.goto("/safeguard/appointments/new");
  await page.getByTestId("appt-clinician-lang-en").click();
  await page.getByTestId("button-appt-create").click();
  await expect(page.getByTestId("appt-question-title")).toBeVisible();
  await page
    .getByTestId("appt-input-mainConcern")
    .fill("Headache for several days, want a quick check.");
  // Walk through the intake to the summary.
  const stepText = (await page.getByTestId("appt-step").innerText()).trim();
  const total = Number(stepText.match(/^1\s*\/\s*(\d+)$/)?.[1] ?? 0);
  for (let current = 1; current < total; current += 1) {
    await page.getByTestId("button-appt-next").click();
    await expect(page.getByTestId("appt-step")).toHaveText(
      new RegExp(`^${current + 1}\\s*/\\s*${total}$`),
    );
  }
  await page.getByTestId("button-appt-next").click();
  await expect(page.getByTestId("appt-patient-summary-text")).toBeVisible({
    timeout: 60_000,
  });

  // Open review and generate the PDF.
  await page.getByTestId("link-review").click();
  await expect(page).toHaveURL(/\/appointments\/[^/]+\/review$/);
  await page.getByTestId("button-generate-pdf").click();
  await expect(page.getByTestId("link-download-pdf")).toBeVisible({
    timeout: 60_000,
  });

  // -------------------------------------------------------------------
  // 1. Delivery section is visible with all three channels and the
  //    button is initially disabled (no surgery name yet).
  // -------------------------------------------------------------------
  const section = page.getByTestId("delivery-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("delivery-channel-qr")).toBeVisible();
  await expect(section.getByTestId("delivery-channel-nhs-app")).toBeVisible();
  await expect(section.getByTestId("delivery-channel-email")).toBeVisible();
  await expect(section.getByTestId("button-deliver")).toBeDisabled();

  // -------------------------------------------------------------------
  // 2. QR happy path. Pick QR, fill surgery name, deliver, expect a QR
  //    image + a public URL to render. Then fetch the public URL via
  //    Playwright's APIRequestContext (no auth headers) and assert it
  //    returns a real PDF.
  // -------------------------------------------------------------------
  await section.getByTestId("delivery-channel-qr").check();
  await section
    .getByTestId("delivery-surgery-name")
    .fill("Riverside Medical Practice");
  await section.getByTestId("button-deliver").click();
  const qrBlock = section.getByTestId("delivery-qr");
  await expect(qrBlock).toBeVisible({ timeout: 15_000 });
  const publicUrl = (await qrBlock.locator("p.break-all").innerText()).trim();
  // The QR now lands on an HTML preview page (no `.pdf` suffix); the PDF
  // is served from the same token URL with `?pdf=1`.
  expect(publicUrl).toMatch(/\/safeguard-api\/public\/exports\/[^/.?]+$/);

  // Hitting the bare token URL must return the friendly landing page,
  // NOT the PDF — and viewing the landing page must not stamp fetchedAt.
  const landingRes = await request.get(publicUrl);
  expect(landingRes.status()).toBe(200);
  expect(landingRes.headers()["content-type"] ?? "").toContain("text/html");
  const landingHtml = await landingRes.text();
  expect(landingHtml).toContain("Patient summary");
  expect(landingHtml).toContain("Riverside Medical Practice");
  expect(landingHtml).toContain("?pdf=1");

  const pdfRes = await fetchPublicPdf(request, `${publicUrl}?pdf=1`);
  expect(pdfRes.status()).toBe(200);
  const ct = pdfRes.headers()["content-type"] ?? "";
  expect(ct).toContain("application/pdf");
  const body = await pdfRes.body();
  expect(body.byteLength).toBeGreaterThan(500);
  expect(body.subarray(0, 4).toString("utf8")).toBe("%PDF");

  // The history list should now show the new delivery row, and after
  // the public fetch above it should report "Opened by …".
  await page.reload();
  const history = page.getByTestId("delivery-history");
  await expect(history).toBeVisible();
  await expect(history.getByText(/Opened by/i)).toBeVisible({
    timeout: 10_000,
  });

  // -------------------------------------------------------------------
  // 3. NHS-app share channel: must mint a tokenized public URL that
  //    the surgery can fetch with no auth headers, exactly like QR.
  //    The browser's Web Share API is not available under Playwright,
  //    so the client falls back to `navigator.clipboard.writeText` and
  //    surfaces the share notice. We grab the public URL out of the
  //    deliver response itself, then hit it the same way a recipient
  //    tapping the link would.
  // -------------------------------------------------------------------
  await section.getByTestId("delivery-channel-nhs-app").check();
  // Surgery name is already filled from the QR step, but re-set it to
  // be explicit about which row this test owns.
  await section
    .getByTestId("delivery-surgery-name")
    .fill("Riverside NHS App Share");
  const sharePromise = page.waitForResponse(
    (r) =>
      /\/safeguard-api\/me\/appointments\/[^/]+\/export\/[^/]+\/deliver$/.test(
        r.url(),
      ) && r.request().method() === "POST",
  );
  await section.getByTestId("button-deliver").click();
  const shareRes = await sharePromise;
  expect(shareRes.status()).toBe(200);
  const shareJson = (await shareRes.json()) as {
    delivery: { channel: string };
    share?: { publicUrl: string; shareText: string };
  };
  expect(shareJson.delivery.channel).toBe("nhs_app");
  const sharePublicUrl = shareJson.share?.publicUrl ?? "";
  // NHS-app share URLs land on the same friendly preview page as the
  // QR — surgery audience is identical, so behaviour is identical.
  expect(sharePublicUrl).toMatch(
    /\/safeguard-api\/public\/exports\/[^/.?]+$/,
  );
  const shareLanding = await request.get(sharePublicUrl);
  expect(shareLanding.status()).toBe(200);
  expect(shareLanding.headers()["content-type"] ?? "").toContain("text/html");
  const sharePdf = await fetchPublicPdf(request, `${sharePublicUrl}?pdf=1`);
  expect(sharePdf.status()).toBe(200);
  expect(sharePdf.headers()["content-type"] ?? "").toContain("application/pdf");
  const shareBody = await sharePdf.body();
  expect(shareBody.subarray(0, 4).toString("utf8")).toBe("%PDF");

  // -------------------------------------------------------------------
  // 4. Email channel without SMTP wired up must fail loudly with a
  //    visible retry button — never silently pretend the email went out.
  //    (CI does not configure SAFEGUARD_DELIVERY_SMTP_URL.)
  // -------------------------------------------------------------------
  await section.getByTestId("delivery-channel-email").check();
  await section
    .getByTestId("delivery-recipient-email")
    .fill("team@example-surgery.test");
  await section.getByTestId("button-deliver").click();
  await expect(section.getByTestId("delivery-error")).toBeVisible({
    timeout: 15_000,
  });
  await expect(section.getByTestId("delivery-retry")).toBeVisible();
});
