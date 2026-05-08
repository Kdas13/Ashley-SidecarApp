import { test, expect, type Page, type Route } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";

/**
 * Edge-case coverage for the Safeguard appointment + follow-up flow.
 *
 * The happy-path spec (`appointment-flow.spec.ts`) only proves the green
 * road works end-to-end with real AI output. The pilot's actual
 * safeguarding value lives in the corner cases — refusing to advance
 * without consent, surfacing low-confidence AI output, rendering an
 * escalation follow-up with destructive styling and the "come back if
 * things get worse" copy, and degrading gracefully when the intake
 * summary call fails. Those are guarded here.
 *
 * Strategy:
 *   - The consent-gate test runs against the real backend with a fresh
 *     test user; nothing is mocked because the gate is a pure client-side
 *     state check we want to verify against the real onboarding form.
 *   - The remaining tests stub the `/safeguard-api/*` endpoints with
 *     `page.route()` so we can deterministically force low-confidence
 *     summaries, an escalation follow-up payload, and a 5xx on the
 *     intake summary call without depending on prompt drift in the
 *     model. These tests still authenticate via Clerk so the SignedIn
 *     gates and `getToken()` call paths are exercised.
 *
 * Required env (CI must provide all of these):
 *   - VITE_CLERK_PUBLISHABLE_KEY   (test instance pk_test_…)
 *   - CLERK_PUBLISHABLE_KEY        (same value, for @clerk/testing)
 *   - CLERK_SECRET_KEY             (test instance sk_test_…)
 *   - DATABASE_URL                 (for the consent-gate test which talks
 *                                   to the real backend)
 *
 * The mocked tests do NOT depend on AI_INTEGRATIONS_OPENAI_* — that is
 * intentional, the whole point is to exercise paths the real model
 * wouldn't reliably reproduce.
 */

const CONSENT_USER_EMAIL = `safeguard.consent+clerk_test@example.com`;
const LOW_CONF_USER_EMAIL = `safeguard.lowconf+clerk_test@example.com`;
const ESCALATION_USER_EMAIL = `safeguard.escalation+clerk_test@example.com`;
const FAILURE_USER_EMAIL = `safeguard.failure+clerk_test@example.com`;

test.beforeAll(async () => {
  await clerkSetup();
});

async function signInAs(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/safeguard/");
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: email },
  });
}

// ---------------------------------------------------------------------------
// Mock helpers — used by the three tests that stub the API.
//
// We only mock the surfaces each test exercises. Anything else falls
// through to the real backend so an unexpected dependency surfaces as a
// loud failure rather than a silently-stubbed pass.
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-05-08T10:00:00.000Z";

function mockProfile(profileOverrides: Record<string, unknown> = {}): {
  url: RegExp;
  handler: (route: Route) => Promise<void>;
} {
  return {
    url: /\/safeguard-api\/me\/profile$/,
    handler: async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          profile: {
            userId: "user_mock",
            preferredName: "Edge Wren",
            preferredLanguage: "en",
            nativeLanguage: "en",
            secondaryLanguage: "",
            literacyLevel: "medium",
            countryOfOrigin: "Ukraine",
            dateOfBirth: "1990-01-01",
            gpName: "",
            gpSurgery: "",
            ongoingConcerns: "",
            currentMedications: "",
            accessibilityLargeText: false,
            accessibilityHighContrast: false,
            accessibilityAudio: false,
            accessibilitySimplified: false,
            accessibilitySlowerPacing: false,
            trustedContactName: "",
            trustedContactRelation: "",
            trustedContactPhone: "",
            consentStorage: true,
            consentAiProcessing: true,
            consentRecordedAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            ...profileOverrides,
          },
        }),
      });
    },
  };
}

function mockCreateAppointment(apptId: string): {
  url: RegExp;
  handler: (route: Route) => Promise<void>;
} {
  return {
    url: /\/safeguard-api\/me\/appointments$/,
    handler: async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appointment: {
            id: apptId,
            userId: "user_mock",
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            status: "draft",
            patientLang: "en",
            clinicianLang: "en",
            title: "",
          },
        }),
      });
    },
  };
}

/**
 * Walks the intake one question at a time. The intake question count is
 * hardcoded in `AppointmentPrep.tsx` (see `questions` useMemo). We read
 * it dynamically off the `appt-step` indicator so this stays in sync if
 * a question is added or removed.
 */
async function walkIntakeToFinalSubmit(
  page: Page,
  mainConcern: string,
): Promise<void> {
  await expect(page.getByTestId("appt-question-title")).toBeVisible();
  await page.getByTestId("appt-input-mainConcern").fill(mainConcern);
  const stepText = (await page.getByTestId("appt-step").innerText()).trim();
  const total = Number(stepText.match(/^1\s*\/\s*(\d+)$/)?.[1] ?? 0);
  if (!total) throw new Error(`unexpected step indicator: "${stepText}"`);
  for (let current = 1; current < total; current += 1) {
    await page.getByTestId("button-appt-next").click();
    await expect(page.getByTestId("appt-step")).toHaveText(
      new RegExp(`^${current + 1}\\s*/\\s*${total}$`),
    );
  }
  await page.getByTestId("button-appt-next").click();
}

// ---------------------------------------------------------------------------
// 1. Consent gate — the Continue button stays disabled and a destructive
//    warning surfaces when the user lands on the consent question without
//    toggling "I agree". Walks the real onboarding form against the live
//    backend so the gate is verified against the same UI shipped to
//    pilots.
// ---------------------------------------------------------------------------

test("Consent gate: cannot advance past consent question without agreeing", async ({
  page,
}) => {
  // Force the profile GET to look fresh-and-empty so consents start OFF
  // even if a previous run left a profile row for this email.
  await page.route(/\/safeguard-api\/me\/profile$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ profile: null }),
      });
      return;
    }
    await route.fallback();
  });

  await signInAs(page, CONSENT_USER_EMAIL);
  await page.goto("/safeguard/onboarding");
  await expect(page.getByTestId("question-title")).toBeVisible();

  // Walk to the consent-storage question (index 19, so 19 clicks from
  // step 0). We have to fill the required free-text fields along the way
  // or the Continue button is disabled by `canAdvance` and we'll get
  // stuck before reaching the consent step.
  await page.getByTestId("button-onboarding-next").click(); // language
  await page.getByTestId("input-preferred-name").fill("Consent Wren");
  await page.getByTestId("button-onboarding-next").click();
  // native, secondary, literacy
  for (let i = 0; i < 3; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("input-country").fill("Ukraine");
  await page.getByTestId("button-onboarding-next").click();
  await page.getByTestId("input-dob").fill("1990-01-01");
  await page.getByTestId("button-onboarding-next").click();
  // gpName, gpSurgery, concerns, medications
  for (let i = 0; i < 4; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  // 5 accessibility yes/no
  for (let i = 0; i < 5; i += 1)
    await page.getByTestId("button-onboarding-next").click();
  // trustedName, trustedRelation, trustedPhone
  for (let i = 0; i < 3; i += 1)
    await page.getByTestId("button-onboarding-next").click();

  // We're now on the consentStorage question. Continue must be disabled
  // and the destructive consent-required warning must be visible.
  await expect(page.getByTestId("step-indicator")).toHaveText("20 / 21");
  const nextBtn = page.getByTestId("button-onboarding-next");
  await expect(nextBtn).toBeDisabled();
  await expect(page.getByTestId("consent-warning")).toBeVisible();

  // Even forcing a click must not advance us past this step.
  await nextBtn.click({ force: true }).catch(() => {});
  await expect(page.getByTestId("step-indicator")).toHaveText("20 / 21");

  // Toggling "I agree" unblocks Continue and hides the warning.
  await page.getByTestId("toggle-consent-storage-yes").click();
  await expect(nextBtn).toBeEnabled();
  await expect(page.getByTestId("consent-warning")).toHaveCount(0);

  // Advance to the AI-consent question and verify the same gate.
  await nextBtn.click();
  await expect(page.getByTestId("step-indicator")).toHaveText("21 / 21");
  await expect(nextBtn).toBeDisabled();
  await expect(page.getByTestId("consent-warning")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Low-confidence pill rendering — when the intake summary comes back
//    with `confidence: "low"`, both summary cards must surface the red
//    confidence pill so the patient knows to double-check before the
//    appointment.
// ---------------------------------------------------------------------------

test("Low-confidence summaries surface the red confidence pill on both cards", async ({
  page,
}) => {
  const apptId = "appt_low_conf_mock";
  const profileMock = mockProfile();
  const createMock = mockCreateAppointment(apptId);

  await page.route(profileMock.url, profileMock.handler);
  await page.route(createMock.url, createMock.handler);

  // Force both AI summaries to come back as low-confidence with notes
  // explaining why. The UI renders the red pill + the notes after the
  // em-dash inside `ConfidenceInline`.
  await page.route(
    new RegExp(`/safeguard-api/me/appointments/${apptId}/intake$`),
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      const summary = (audience: "patient" | "clinician") => ({
        id: `sum_${audience}`,
        appointmentId: apptId,
        audience,
        lang: "en",
        summary:
          audience === "patient"
            ? "I have a headache and I am not sure how bad it is."
            : "Patient reports a headache; severity and timeline unclear.",
        edited: false,
        confidence: "low",
        notes: "Intake answers were too short to be confident.",
        provider: "mock",
        model: "mock",
        createdAt: FIXED_NOW,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          intake: { lang: "en", answers: { mainConcern: "headache" } },
          patientSummary: summary("patient"),
          clinicianSummary: summary("clinician"),
        }),
      });
    },
  );

  await signInAs(page, LOW_CONF_USER_EMAIL);
  await page.goto("/safeguard/appointments/new");
  await page.getByTestId("appt-clinician-lang-en").click();
  await page.getByTestId("button-appt-create").click();

  await walkIntakeToFinalSubmit(page, "headache");

  // Both summary cards render with their text and a red `confidence-low`
  // pill. The pill testid is reused across both cards, so we assert the
  // count and that each card contains its own.
  const patientCard = page.getByTestId("appt-patient-summary");
  const clinicianCard = page.getByTestId("appt-clinician-summary");
  await expect(patientCard).toBeVisible({ timeout: 30_000 });
  await expect(clinicianCard).toBeVisible();
  await expect(patientCard.getByTestId("confidence-low")).toBeVisible();
  await expect(clinicianCard.getByTestId("confidence-low")).toBeVisible();
  // Notes text from the AI must be surfaced — that's the "why low" cue.
  await expect(patientCard).toContainText(
    "Intake answers were too short to be confident.",
  );
});

// ---------------------------------------------------------------------------
// 3. Escalation follow-up styling — escalation items render with the
//    destructive border, the "return if X worsens" plain explanation in
//    destructive text, and NO "mark done" button (escalations stay
//    visible until the patient resolves them in person).
// ---------------------------------------------------------------------------

test("Escalation follow-ups render with destructive styling and no mark-done", async ({
  page,
}) => {
  const profileMock = mockProfile();
  await page.route(profileMock.url, profileMock.handler);

  // The standalone /followup route hits `/me/followups` (no appointment
  // id). Return a single escalation item so we can assert its styling.
  await page.route(
    /\/safeguard-api\/me\/followups$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          followups: [
            {
              id: "fu_escalation_1",
              appointmentId: "appt_mock",
              userId: "user_mock",
              kind: "escalation",
              sourceLang: "en",
              targetLang: "en",
              titleOriginal:
                "Return immediately if vision changes or vomiting starts.",
              titleTranslated:
                "Return immediately if vision changes or vomiting starts.",
              detailOriginal: "Go back to the surgery or call 111.",
              detailTranslated: "Go back to the surgery or call 111.",
              plainExplanation:
                "Come back if things get worse — don't wait for the next appointment.",
              confidence: "high",
              dueAt: null,
              nextReminderAt: null,
              cadence: { kind: "none" },
              reminderCount: 0,
              remindersEnabled: false,
              completedAt: null,
              createdAt: FIXED_NOW,
            },
          ],
        }),
      });
    },
  );
  // The reminders opt-in component pings push endpoints; stub them so
  // they don't fall through to the real backend with a fake user id.
  await page.route(
    /\/safeguard-api\/me\/push\/(public-key|subscriptions)$/,
    async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ publicKey: "", subscriptions: [] }),
      }),
  );

  await signInAs(page, ESCALATION_USER_EMAIL);
  await page.goto("/safeguard/followup");

  const item = page.getByTestId("followup-fu_escalation_1");
  await expect(item).toBeVisible();

  // Destructive border on the card itself.
  await expect(item).toHaveClass(/border-destructive/);
  // The plain explanation paragraph must use destructive text styling.
  // It is rendered as a sibling <p> inside the same card — locate by
  // the "Come back if things get worse" copy.
  const plain = item.locator("p", {
    hasText: "Come back if things get worse",
  });
  await expect(plain).toBeVisible();
  await expect(plain).toHaveClass(/text-destructive/);

  // Escalations must NOT show a "mark done" affordance — that button is
  // gated behind `!isEsc` in Followup.tsx and removing the gate would
  // let patients silently dismiss safeguarding instructions.
  await expect(
    item.getByTestId("followup-fu_escalation_1-complete"),
  ).toHaveCount(0);
  // No reminder UI either — cadence is `none` for escalations.
  await expect(
    item.getByTestId("followup-fu_escalation_1-reminder"),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 4. Intake-summary 5xx fallback — when the API returns 500 on the final
//    intake submit, the page must surface the destructive error message
//    (not crash, not silently advance) so the user knows to retry.
// ---------------------------------------------------------------------------

test("Intake summary 5xx surfaces a retryable error instead of crashing", async ({
  page,
}) => {
  const apptId = "appt_failure_mock";
  const profileMock = mockProfile();
  const createMock = mockCreateAppointment(apptId);

  await page.route(profileMock.url, profileMock.handler);
  await page.route(createMock.url, createMock.handler);

  let intakeAttempts = 0;
  await page.route(
    new RegExp(`/safeguard-api/me/appointments/${apptId}/intake$`),
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      intakeAttempts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "internal",
          message: "summary generation failed",
        }),
      });
    },
  );

  await signInAs(page, FAILURE_USER_EMAIL);
  await page.goto("/safeguard/appointments/new");
  await page.getByTestId("appt-clinician-lang-en").click();
  await page.getByTestId("button-appt-create").click();

  await walkIntakeToFinalSubmit(page, "headache");

  // The mutation's onError path renders the destructive paragraph with
  // the API error text. We assert on the "API 500" prefix the
  // hand-written client uses (`API ${status}: ${text}`) so a copy
  // tweak doesn't break the assertion.
  const errMsg = page.locator("p.text-destructive", { hasText: /API 500/ });
  await expect(errMsg).toBeVisible({ timeout: 15_000 });
  expect(intakeAttempts).toBeGreaterThanOrEqual(1);

  // We must NOT have advanced into the review state — the patient
  // summary card from a successful submit should not be on the page.
  await expect(page.getByTestId("appt-patient-summary")).toHaveCount(0);
  // The final intake question stays on screen so the user can hit
  // "Create summary" again to retry.
  await expect(page.getByTestId("button-appt-next")).toBeVisible();
});
