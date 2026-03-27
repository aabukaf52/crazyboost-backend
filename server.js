require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is missing. Put it in your .env file.");
}

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const videoQueue = new Queue("video-processing", {
  connection: redis,
});

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

/* =========================
   Helpers
========================= */

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function normalizeString(value, fallback = "") {
  if (value == null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function getPublicBaseUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  return `${req.protocol}://${req.get("host")}`;
}

function buildAppliedEnhancements(options = {}) {
  const items = [];

  if (toBool(options.enableColorBoost) || toBool(options.smartMode)) {
    items.push("Color Boost");
  }

  if (toBool(options.enableSocialExport) || toBool(options.smartMode)) {
    items.push("Social Export");
  }

  if (options.exportTarget) {
    items.push(`Export: ${options.exportTarget}`);
  }

  if (options.qualityLevel) {
    items.push(`Quality: ${options.qualityLevel}`);
  }

  return items;
}

function buildPipeline(options = {}) {
  const steps = [];
  const smartMode = toBool(options.smartMode);

  const wantsColorBoost = smartMode || toBool(options.enableColorBoost);
  const wantsSocialExport = smartMode || toBool(options.enableSocialExport);
  const hasQualityLevel = Boolean(normalizeString(options.qualityLevel));
  const hasExportTarget = Boolean(normalizeString(options.exportTarget));

  if (
    wantsColorBoost ||
    wantsSocialExport ||
    hasQualityLevel ||
    hasExportTarget
  ) {
    steps.push({
      key: "finalExport",
      label: "Final Export",
      type: "ffmpeg",
      model: null,
    });
  }

  return steps;
}

function getJobRedisKey(jobId) {
  return `job:${jobId}`;
}

async function saveJob(job) {
  const key = getJobRedisKey(job.id);
  await redis.set(key, JSON.stringify(job));
}

async function getJob(jobId) {
  const key = getJobRedisKey(jobId);
  const raw = await redis.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function updateJob(jobId, updates) {
  const existing = await getJob(jobId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };

  await saveJob(updated);
  return updated;
}

/* =========================
   Routes
========================= */

app.get("/", (req, res) => {
  res.json({
    message: "CrazyBoost backend is running (Queue Mode)",
  });
});

app.get("/health", async (req, res) => {
  try {
    await redis.ping();
    res.status(200).json({
      ok: true,
      redis: "connected",
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      redis: "disconnected",
      error: error.message,
    });
  }
});

app.post("/enhance", upload.single("video"), async (req, res) => {
  try {
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
    const pipeline = buildPipeline(options);

    const jobData = {
      id: jobId,
      fileName: req.file.originalname,
      storedFileName: req.file.filename,
      originalUrl: publicVideoUrl,
      resultUrl: null,
      options,
      appliedEnhancements,
      status: "queued",
      progress: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: "queued",
      currentStepLabel: "Queued",
      currentModel: null,
      pipeline,
      totalSteps: pipeline.length,
      completedSteps: 0,
      error: null,
      queueJobId: null,
    };

    console.log("========================================");
    console.log(`[Job ${jobId}] Video received:`, req.file.originalname);
    console.log(`[Job ${jobId}] Stored as:`, req.file.filename);
    console.log(`[Job ${jobId}] Public video URL:`, publicVideoUrl);
    console.log(`[Job ${jobId}] Options:`, options);
    console.log(`[Job ${jobId}] Applied enhancements:`, appliedEnhancements);
    console.log(`[Job ${jobId}] Pipeline:`, pipeline);
    console.log("========================================");

    await saveJob(jobData);

    const queuedJob = await videoQueue.add(
      "process-video",
      {
        jobId,
        videoUrl: publicVideoUrl,
        options,
      },
      {
        removeOnComplete: 20,
        removeOnFail: 50,
      }
    );

    await updateJob(jobId, {
      queueJobId: queuedJob.id,
      status: "queued",
      progress: 10,
      currentStep: pipeline.length > 0 ? "queued" : "done",
      currentStepLabel: pipeline.length > 0 ? "Queued" : "Completed",
    });

    if (pipeline.length === 0) {
      await updateJob(jobId, {
        status: "done",
        progress: 100,
        resultUrl: publicVideoUrl,
        currentStep: "done",
        currentStepLabel: "Completed",
      });
    }

    return res.json({
      success: true,
      message: "Video received successfully",
      jobId,
      fileName: req.file.originalname,
      options,
      appliedEnhancements,
      pipeline,
    });
  } catch (error) {
    console.error("Enhance error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error while creating processing job",
      details: error.message,
    });
  }
});

app.get("/status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    return res.json({
      success: true,
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      currentStepLabel: job.currentStepLabel,
      currentModel: job.currentModel,
      totalSteps: job.totalSteps,
      completedSteps: job.completedSteps,
      pipeline: job.pipeline,
      resultUrl: job.resultUrl,
      originalUrl: job.originalUrl,
      error: job.error,
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
    const job = await getJob(jobId);

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

    if (job.status !== "done") {
      return res.status(400).json({
        success: false,
        error: "Processing not finished yet",
      });
    }

    return res.json({
      success: true,
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      resultUrl: job.resultUrl || job.originalUrl,
      originalUrl: job.originalUrl,
      appliedEnhancements: job.appliedEnhancements,
      pipeline: job.pipeline,
      exportTarget: job.options?.exportTarget || "Horizontal",
      qualityLevel: job.options?.qualityLevel || "Medium",
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

/* =========================
   Worker helper endpoints
   (يستدعيها worker أو يحدّث Redis مباشرة)
========================= */

app.post("/internal/job/:jobId/progress", async (req, res) => {
  try {
    const { jobId } = req.params;
    const updates = req.body || {};

    const job = await updateJob(jobId, updates);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    return res.json({
      success: true,
      jobId,
    });
  } catch (error) {
    console.error("Internal progress update error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update job",
      details: error.message,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});