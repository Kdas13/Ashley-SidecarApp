import { test, expect, type Page } from "@playwright/test";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";

/**
 * End-to-end happy path for the Safeguard appointment + follow-up flow.
 *
 * Why this test exists:
 *   The two regressions we caught manually this round — a stale profile-cache
 *   redirect on onboarding submit, and a hooks-order violation in
 *   AppointmentPrep when the question list was defined after the step===0
 *   early return — would both have been caught here. Keep this green or
 *   the pilot is broken.
 *
 * Required env (CI must provide all of these):
 *   - VITE_CLERK_PUBLISHABLE_KEY   (test instance pk_test_…)
 *   - CLERK_PUBLISHABLE_KEY        (same value, for @clerk/testing)
 *   - CLERK_SECRET_KEY             (test instance sk_test_…)
 *   - DATABASE_URL                 (writable Postgres for safeguard tables)
 *   - AI_INTEGRATIONS_OPENAI_BASE_URL + AI_INTEGRATIONS_OPENAI_API_KEY
 *     (the API will return 200 with a `null` summary if these are missing,
 *     but the AI summary / translation / follow-up assertions below depend
 *     on real model output and will fail fast — that is intentional.)
 *
 * Clerk test mode:
 *   `+clerk_test` emails accept the canonical verification code 424242, so
 *   the test signs in deterministically without inbox polling.
 */

// Clerk test mode auto-accepts verification code 424242 for `+clerk_test`
// addresses, so no inbox polling is required and we never need to pass
// the code explicitly.
const TEST_USER_EMAIL = `safeguard.e2e+clerk_test@example.com`;

async function fillAndContinue(
  page: Page,
  testid: string,
  value: string,
): Promise<void> {
  await page.getByTestId(testid).fill(value);
  await page.getByTestId("button-onboarding-next").click();
}

async function clickContinue(page: Page): Promise<void> {
  await page.getByTestId("button-onboarding-next").click();
}

test.beforeAll(async () => {
  // Loads the Clerk testing token used by setupClerkTestingToken below.
  // Reads CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY from env.
  await clerkSetup();
});

test("Safeguard appointment happy path: onboarding → intake → review → follow-up", async ({
  page,
}) => {
  // ---------------------------------------------------------------------
  // 1. Sign in via Clerk test mode (no UI interaction with Clerk modal).
  // ---------------------------------------------------------------------
  await setupClerkTestingToken({ page });
  await page.goto("/safeguard/");
  await clerk.signIn({
    page,
    signInParams: {
      strategy: "email_code",
      identifier: TEST_USER_EMAIL,
    },
  });
  // After sign-in, the AppShell either lands us on /home or — if no profile
  // exists yet — bounces to /onboarding. Force the onboarding path so the
  // test is deterministic for both fresh and recycled test users.
  await page.goto("/safeguard/onboarding");
  await expect(page.getByTestId("question-title")).toBeVisible();

  // ---------------------------------------------------------------------
  // 2. Walk onboarding. We rely on data-testids only — string copy is
  //    intentionally not asserted here so language tweaks don't break the
  //    regression net.
  // ---------------------------------------------------------------------
  // Q1 language (default `en` is fine).
  await clickContinue(page);
  // Q2 preferredName (required).
  await fillAndContinue(page, "input-preferred-name", "Test Wren");
  // Q3 nativeLanguage, Q4 secondaryLanguage, Q5 literacy — defaults are valid.
  await clickContinue(page);
  await clickContinue(page);
  await clickContinue(page);
  // Q6 country (required).
  await fillAndContinue(page, "input-country", "Ukraine");
  // Q7 dob (required).
  await fillAndContinue(page, "input-dob", "1990-01-01");
  // Q8 gpName, Q9 gpSurgery, Q10 concerns, Q11 medications — optional.
  await clickContinue(page);
  await clickContinue(page);
  await clickContinue(page);
  await clickContinue(page);
  // Q12-Q16 accessibility yes/no — leave as default (no), continue.
  for (let i = 0; i < 5; i += 1) await clickContinue(page);
  // Q17 trustedName, Q18 trustedRelation, Q19 trustedPhone — optional.
  await clickContinue(page);
  await clickContinue(page);
  await clickContinue(page);
  // Q20 consentStorage (must be ON). Click the "Yes/I agree" button inside
  // the YesNo control before continuing.
  await page.getByTestId("toggle-consent-storage-yes").click();
  await clickContinue(page);
  // Q21 consentAi (must be ON), then Continue submits.
  await page.getByTestId("toggle-consent-ai-yes").click();
  await clickContinue(page);

  // After submit, the profile cache is seeded synchronously and we should
  // land on /home — NOT bounce back to /onboarding. This is the exact
  // regression that the stale-cache fix targets, so guard it tightly.
  await expect(page).toHaveURL(/\/safeguard\/home$/);
  await expect(page.getByTestId("link-start-checkin")).toBeVisible();

  // ---------------------------------------------------------------------
  // 3. Start an appointment.
  // ---------------------------------------------------------------------
  await page.goto("/safeguard/appointments/new");
  // Step 0 — pick clinician language, then create appointment.
  await page.getByTestId("appt-clinician-lang-en").click();
  await page.getByTestId("button-appt-create").click();

  // Step 1 onwards — first intake question is the main concern (required).
  // The hooks-order regression in AppointmentPrep would surface as a
  // React error here, *before* the question title renders.
  await expect(page.getByTestId("appt-question-title")).toBeVisible();
  await expect(page.getByTestId("appt-step")).toHaveText(/^1 \/ \d+$/);

  await page
    .getByTestId("appt-input-mainConcern")
    .fill("Persistent headache for the last week, worse in the morning.");

  // Read the total intake length from the "1 / N" indicator and walk one
  // step at a time, waiting for the indicator to advance before clicking
  // again. This avoids double-clicking the final submit while the
  // summary generation is still in flight.
  const stepText = (await page.getByTestId("appt-step").innerText()).trim();
  const totalMatch = stepText.match(/^1\s*\/\s*(\d+)$/);
  if (!totalMatch) {
    throw new Error(`unexpected intake step indicator: "${stepText}"`);
  }
  const totalIntakeSteps = Number(totalMatch[1]);

  for (let current = 1; current < totalIntakeSteps; current += 1) {
    await page.getByTestId("button-appt-next").click();
    await expect(page.getByTestId("appt-step")).toHaveText(
      new RegExp(`^${current + 1}\\s*/\\s*${totalIntakeSteps}$`),
    );
  }

  // Single, deliberate "Create summary" click on the final question. After
  // this the page transitions to the review state (no more step indicator,
  // patient summary card present).
  await page.getByTestId("button-appt-next").click();

  // ---------------------------------------------------------------------
  // 4. Assert the dual AI summaries rendered.
  // ---------------------------------------------------------------------
  const patientSummary = page.getByTestId("appt-patient-summary-text");
  const clinicianSummary = page.getByTestId("appt-clinician-summary-text");
  await expect(patientSummary).toBeVisible({ timeout: 60_000 });
  await expect(clinicianSummary).toBeVisible({ timeout: 60_000 });
  await expect(patientSummary).not.toHaveText("");
  await expect(clinicianSummary).not.toHaveText("");

  // ---------------------------------------------------------------------
  // 5. Translation workspace renders without crashing and shows a
  //    translated utterance + confidence pill.
  // ---------------------------------------------------------------------
  await page.getByTestId("button-appt-open-translate").click();
  await expect(page).toHaveURL(/\/appointments\/[^/]+\/translate$/);
  await page.getByTestId("speaker-patient").click();
  await page
    .getByTestId("translate-input")
    .fill("My head hurts a lot, especially in the morning.");
  await page.getByTestId("button-translate-send").click();
  // First utterance + its confidence indicator must render.
  await expect(page.locator('[data-testid^="utterance-"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid^="confidence-"]').first(),
  ).toBeVisible();

  // ---------------------------------------------------------------------
  // 6. Review screen — generate the GP-export PDF and assert the
  //    download link appears.
  // ---------------------------------------------------------------------
  await page.getByTestId("link-review").click();
  await expect(page).toHaveURL(/\/appointments\/[^/]+\/review$/);
  await page.getByTestId("button-generate-pdf").click();
  const downloadLink = page.getByTestId("link-download-pdf");
  await expect(downloadLink).toBeVisible({ timeout: 60_000 });
  await expect(downloadLink).toHaveAttribute(
    "href",
    /\/safeguard-api\/me\/appointments\/[^/]+\/export\/[^/]+\.pdf$/,
  );

  // ---------------------------------------------------------------------
  // 7. Capture clinician follow-up notes → assert at least one translated
  //    follow-up item shows up on the follow-up screen.
  // ---------------------------------------------------------------------
  await page
    .getByTestId("followup-input")
    .fill(
      "Take paracetamol 500mg up to four times a day for 5 days. " +
        "Come back in two weeks. Return sooner if vision changes or vomiting starts.",
    );
  await page.getByTestId("button-followup-submit").click();
  await expect(page).toHaveURL(/\/appointments\/[^/]+\/followup$/);
  await expect(page.locator('[data-testid^="followup-"]').first()).toBeVisible({
    timeout: 60_000,
  });
});
