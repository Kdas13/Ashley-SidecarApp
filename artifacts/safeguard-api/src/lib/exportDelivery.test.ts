import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { sendMail, verify, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  return { sendMail, verify, createTransport };
});

vi.mock("nodemailer", () => ({
  default: { createTransport },
  createTransport,
}));

import {
  isValidEmail,
  sendExportEmail,
  _resetEmailTransportCache,
} from "./exportDelivery";

describe("isValidEmail", () => {
  it("accepts a normal surgery address", () => {
    expect(isValidEmail("team@surgery.nhs.uk")).toBe(true);
  });
  it("rejects empty / malformed input", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a @b.co")).toBe(false);
  });
});

describe("sendExportEmail", () => {
  const baseArgs = {
    to: "team@surgery.nhs.uk",
    surgeryName: "Riverside Medical Practice",
    pdfBytes: Buffer.from("%PDF-fake-bytes"),
    patientName: "Aleksandra K.",
    appointmentId: "appt-123",
  };

  beforeEach(() => {
    sendMail.mockReset();
    verify.mockReset();
    verify.mockResolvedValue(true);
    createTransport.mockClear();
    _resetEmailTransportCache();
    delete process.env.SAFEGUARD_DELIVERY_SMTP_URL;
    delete process.env.SAFEGUARD_DELIVERY_FROM;
  });

  afterEach(() => {
    delete process.env.SAFEGUARD_DELIVERY_SMTP_URL;
    delete process.env.SAFEGUARD_DELIVERY_FROM;
  });

  it("returns transport_not_configured when no SMTP URL is set, without calling nodemailer", async () => {
    const result = await sendExportEmail(baseArgs);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("transport_not_configured");
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("dispatches via nodemailer with the PDF attached on the happy path", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    process.env.SAFEGUARD_DELIVERY_FROM = "Safeguard <noreply@safeguard.test>";
    sendMail.mockResolvedValueOnce({
      accepted: [baseArgs.to],
      messageId: "<abc@safeguard.test>",
    });

    const result = await sendExportEmail(baseArgs);

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("<abc@safeguard.test>");
    expect(createTransport).toHaveBeenCalledWith(
      "smtps://u:p@smtp.test:465",
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0]![0] as {
      from: string;
      to: string;
      subject: string;
      text: string;
      attachments: Array<{
        filename: string;
        content: Buffer;
        contentType: string;
      }>;
    };
    expect(call.from).toBe("Safeguard <noreply@safeguard.test>");
    expect(call.to).toBe(baseArgs.to);
    expect(call.subject).toContain(baseArgs.patientName);
    expect(call.subject).toContain(baseArgs.surgeryName);
    expect(call.text).toContain(baseArgs.appointmentId);
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments[0]!.filename).toBe(
      `safeguard-${baseArgs.appointmentId}.pdf`,
    );
    expect(call.attachments[0]!.contentType).toBe("application/pdf");
    expect(call.attachments[0]!.content.equals(baseArgs.pdfBytes)).toBe(true);
  });

  it("falls back to a default from-address when SAFEGUARD_DELIVERY_FROM is unset", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtp://u:p@smtp.test:587";
    sendMail.mockResolvedValueOnce({ accepted: [baseArgs.to] });

    await sendExportEmail(baseArgs);

    const call = sendMail.mock.calls[0]![0] as { from: string };
    expect(call.from).toMatch(/Safeguard/);
    expect(call.from).toMatch(/noreply@/);
  });

  it("only verifies the transport once per URL across calls", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    sendMail.mockResolvedValue({ accepted: [baseArgs.to] });

    await sendExportEmail(baseArgs);
    await sendExportEmail(baseArgs);
    await sendExportEmail(baseArgs);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it("returns auth_failed when the transport rejects credentials at verify time", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    const err = Object.assign(new Error("Invalid login: 535 auth failed"), {
      code: "EAUTH",
    });
    verify.mockRejectedValueOnce(err);

    const result = await sendExportEmail(baseArgs);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("auth_failed");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns transport_unverified for non-auth verify failures (e.g. unreachable host)", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    const err = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:465"), {
      code: "ESOCKET",
    });
    verify.mockRejectedValueOnce(err);

    const result = await sendExportEmail(baseArgs);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("transport_unverified");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns recipient_rejected when the surgery's MTA refuses the address (5xx on RCPT TO)", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    const err = Object.assign(new Error("550 5.1.1 Mailbox not found"), {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
    });
    sendMail.mockRejectedValueOnce(err);

    const result = await sendExportEmail(baseArgs);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("recipient_rejected");
    expect(result.errorMessage).toContain("550");
  });

  it("returns smtp_error with the underlying message for generic transport failures", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    sendMail.mockRejectedValueOnce(new Error("connection reset"));

    const result = await sendExportEmail(baseArgs);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("smtp_error");
    expect(result.errorMessage).toContain("connection reset");
  });

  it("rebuilds the transport when the SMTP URL is rotated", async () => {
    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@smtp.test:465";
    sendMail.mockResolvedValue({ accepted: [baseArgs.to] });
    await sendExportEmail(baseArgs);

    process.env.SAFEGUARD_DELIVERY_SMTP_URL = "smtps://u:p@other.test:465";
    await sendExportEmail(baseArgs);

    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
