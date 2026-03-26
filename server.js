const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { fal } = require("@fal-ai/client");

const app = express();
app.set("trust proxy", true);

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const originalExt = path.extname(file.originalname) || ".mp4";
    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${originalExt}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

const jobs = {};

if (process.env.FAL_KEY) {
  fal.config({
    credentials: process.env.FAL_KEY,
  });
}

function getPublicBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function buildAppliedEnhancements(options = {}) {
  const items = [];

  if (options.enableUpscale === "true") items.push("Upscale");
  if (options.enableDenoise === "true") items.push("Denoise");
  if (options.enableSharpen === "true") items.push("Sharpen");
  if (options.enableColorBoost === "true") items.push("Color Boost");
  if (options.enableFrameSmoothing === "true") items.push("Frame Smoothing");
  if (options.enableSocialExport === "true") items.push("Social Export");

  return items;
}

function mapTargetResolution(qualityLevel) {
  if (qualityLevel === "Ultra") return "1080p";
  return "720p";
}

function mapCreativity(options = {}) {
  if (options.smartMode === "true") return 1;
  return 1;
}

app.get("/", (req, res) => {
  res.json({ message: "CrazyBoost backend is running" });
});

app.post("/enhance", upload.single("video"), async (req, res) => {
  try {
    if (!process.env.FAL_KEY) {
      return res.status(500).json({
        success: false,
        error: "FAL_KEY is missing in environment variables",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No video uploaded",
      });
    }

    const jobId = Date.now().toString();
    const publicBaseUrl = getPublicBaseUrl(req);
    const publicVideoUrl = `${publicBaseUrl}/uploads/${req.file.filename}`;

    const options = req.body || {};
    const appliedEnhancements = buildAppliedEnhancements(options);

    console.log("Video received:", req.file.originalname);
    console.log("Stored as:", req.file.filename);
    console.log("Public video URL:", publicVideoUrl);
    console.log("Options:", options);
    console.log("Job created:", jobId);

    jobs[jobId] = {
      id: jobId,
      fileName: req.file.originalname,
      storedFileName: req.file.filename,
      originalUrl: publicVideoUrl,
      resultUrl: null,
      options,
      appliedEnhancements,
      status: "processing",
      progress: 5,
      createdAt: Date.now(),
      falRequestId: null,
      falModel: "fal-ai/wan-vision-enhancer",
      error: null,
    };

    const submitResult = await fal.queue.submit("fal-ai/wan-vision-enhancer", {
      input: {
        video_url: publicVideoUrl,
        target_resolution: mapTargetResolution(options.qualityLevel),
        creativity: mapCreativity(options),
        prompt: "",
      },
    });

    jobs[jobId].falRequestId = submitResult.request_id;
    jobs[jobId].progress = 15;

    return res.json({
      success: true,
      message: "Video received successfully",
      jobId,
      fileName: req.file.originalname,
      options,
    });
  } catch (error) {
    console.error("Enhance error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error while submitting AI job",
      details: error.message,
    });
  }
});

app.get("/status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (!job.falRequestId) {
      return res.json({
        success: true,
        jobId: job.id,
        fileName: job.fileName,
        status: job.status,
        progress: job.progress,
      });
    }

    if (job.status === "done" || job.status === "failed") {
      return res.json({
        success: true,
        jobId: job.id,
        fileName: job.fileName,
        status: job.status,
        progress: job.progress,
      });
    }

    const falStatus = await fal.queue.status(job.falModel, {
      requestId: job.falRequestId,
      logs: true,
    });

    const falState = falStatus.status;

    if (falState === "IN_QUEUE") {
      job.status = "processing";
      job.progress = 20;
    } else if (falState === "IN_PROGRESS") {
      job.status = "processing";
      job.progress = 70;
    } else if (falState === "COMPLETED") {
      job.status = "done";
      job.progress = 100;
    } else if (falState === "FAILED" || falState === "CANCELLED") {
      job.status = "failed";
      job.progress = 100;
      job.error = "AI processing failed";
    }

    return res.json({
      success: true,
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      progress: job.progress,
    });
  } catch (error) {
    console.error("Status error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
});

app.get("/result/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (job.status === "failed") {
      return res.status(400).json({
        success: false,
        error: job.error || "Processing failed",
      });
    }

    if (!job.falRequestId) {
      return res.status(400).json({
        success: false,
        error: "AI request not created yet",
      });
    }

    if (job.status !== "done") {
      const falStatus = await fal.queue.status(job.falModel, {
        requestId: job.falRequestId,
        logs: false,
      });

      if (falStatus.status !== "COMPLETED") {
        return res.status(400).json({
          success: false,
          error: "Processing not finished yet",
        });
      }

      job.status = "done";
      job.progress = 100;
    }

    const result = await fal.queue.result(job.falModel, {
      requestId: job.falRequestId,
    });

    const resultUrl = result?.data?.video?.url || null;

    if (!resultUrl) {
      return res.status(500).json({
        success: false,
        error: "No result video returned from AI",
      });
    }

    job.resultUrl = resultUrl;

    return res.json({
      success: true,
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      resultUrl: job.resultUrl,
      appliedEnhancements: job.appliedEnhancements,
    });
  } catch (error) {
    console.error("Result error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});