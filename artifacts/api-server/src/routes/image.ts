import { Router, type IRouter } from "express";
import { openSelfie, openUserImage } from "../lib/storage";

const router: IRouter = Router();

// Filenames are unguessable UUIDs with a known image extension.
const USER_IMAGE_FILENAME_RE = /^[a-zA-Z0-9-]+\.(jpg|jpeg|png|webp|gif|heic)$/i;

router.get("/user-images/:filename", async (req, res): Promise<void> => {
  const filename = req.params.filename;
  if (!USER_IMAGE_FILENAME_RE.test(filename)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  let result;
  try {
    result = await openUserImage(filename);
  } catch (err) {
    req.log.error({ err, filename }, "Failed to open user image");
    res.status(500).json({ error: "Failed to read image" });
    return;
  }
  if (!result) {
    res.status(404).json({ error: "Image not found" });
    return;
  }
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  if (result.contentLength !== undefined) {
    res.setHeader("Content-Length", String(result.contentLength));
  }
  result.stream.on("error", (err) => {
    req.log.error({ err, filename }, "User image stream error");
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  result.stream.pipe(res);
});

// Legacy DB-backed POST /image/selfie was removed in the V1 security pass —
// the mobile client uses the stateless /chat/selfie poll-based flow instead.
// What remains here is the public static-file delivery for selfie PNGs so
// React Native <Image> tags (which can't attach Authorization headers) can
// load the generated images directly. Filenames are unguessable UUIDs.

const SELFIE_ID_RE = /^[a-zA-Z0-9-]+$/;

router.get("/selfies/:filename", async (req, res): Promise<void> => {
  const filename = req.params.filename;
  if (!filename.endsWith(".png")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const id = filename.slice(0, -".png".length);
  if (!SELFIE_ID_RE.test(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  let result;
  try {
    result = await openSelfie(id);
  } catch (err) {
    req.log.error({ err, id }, "Failed to open selfie");
    res.status(500).json({ error: "Failed to read selfie" });
    return;
  }
  if (!result) {
    res.status(404).json({ error: "Selfie not found" });
    return;
  }

  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  if (result.contentLength !== undefined) {
    res.setHeader("Content-Length", String(result.contentLength));
  }

  result.stream.on("error", (err) => {
    req.log.error({ err, id }, "Selfie stream error");
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  result.stream.pipe(res);
});

export default router;
