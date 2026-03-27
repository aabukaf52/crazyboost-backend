require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const crypto = require("crypto");
const { v2: cloudinary } = require("cloudinary");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is missing. Put it in your .env file.");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const videoQueue = new Queue("video-processing", {
  connection: redis,
});

// نستخدم memoryStorage حتى ما نخزن ملفات محليًا على السيرفر
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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

function makeJobId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function buildAppliedEnhancements(options = {}) {
  const items = [];
  const processingMode = normalizeString(options.processingMode).toLowerCase();

  if (toBool(options.enableUpscale) || processingMode === "smart") {
    items.push("Upscale");
  }

  if (toBool(options.enableDenoise) || processingMode === "smart") {
    items.push("Denoise");
  }

  if (toBool(options.enableSharpen) || processingMode === "smart") {
    items.push("Sharpen");
  }

  if (toBool(options.enableColorBoost) || toBool(options.smartMode)) {
    items.push("Color Boost");
  }

  if (toBool(options.enableFrameSmoothing)) {
    items.push("Frame Smoothing");
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

  if (processingMode) {
    items.push(`Mode: ${processingMode}`);
  }

  return items;
}

function buildPipeline(options = {}) {
  const steps = [];
  const smartMode = toBool(options.smartMode);
  const processingMode = normalizeString(options.processingMode, "").toLowerCase();

  const wantsAnyProcessing =
    smartMode ||
    ["smart", "fast", "balance", "balanced", "ultra", "custom", "ai"].includes(
      processingMode
    ) ||
    toBool(options.enableUpscale) ||
    toBool(options.enableDenoise) ||
    toBool(options.enableSharpen) ||
    toBool(options.enableColorBoost) ||
    toBool(options.enableFrameSmoothing) ||
    toBool(options.enableSocialExport) ||
    Boolean(normalizeString(options.qualityLevel)) ||
    Boolean(normalizeString(options.exportTarget));

  if (wantsAnyProcessing) {
    steps.push({
      key: "videoEnhancement",
      label: "Video Enhancement",
      type: "ffmpeg",
      model: processingMode || (smartMode ? "smart" : "custom"),
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

async function uploadBufferToCloudinary(fileBuffer, fileName = "video.mp4") {
  return new Promise((resolve, reject) => {
    const publicId = `crazyboost/input/${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}`;

    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        public_id: publicId,
        use_filename: true,
        unique_filename: true,
        filename_override: fileName,
        overwrite: false,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(fileBuffer);
  });
}

/* =========================
   Routes
========================= */

app.get("/", (req, res) => {
  res.json({
    message: "CrazyBoost backend is running (Queue Mode + Cloudinary Mode)",
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

// يدعم حالتين:
// 1) videoUrl قادم من Flutter بعد رفع Cloudinary
// 2) ملف مباشر كـ fallback
app.post("/enhance", upload.single("video"), async (req, res) => {
  try {
    const options = req.body || {};
    const providedVideoUrl = normalizeString(req.body?.videoUrl);
    let originalUrl = providedVideoUrl;
    let originalFileName = "video.mp4";
    let storedFileName = `remote-source-${Date.now()}.mp4`;

    if (!originalUrl && req.file) {
      const uploaded = await uploadBufferToCloudinary(
        req.file.buffer,
        req.file.originalname || "video.mp4"
      );

      originalUrl = uploaded.secure_url;
      originalFileName = req.file.originalname || "video.mp4";
      storedFileName = uploaded.public_id || storedFileName;
    }

    if (!originalUrl) {
      return res.status(400).json({
        success: false,
        error: "No video provided. Send videoUrl or upload a video file.",
      });
    }

    if (req.file && !originalFileName) {
      originalFileName = req.file.originalname || "video.mp4";
    }

    if (!req.file && providedVideoUrl) {
      const cleanUrl = providedVideoUrl.split("?")[0];
      const guessedName = cleanUrl.split("/").pop();
      if (guessedName) {
        originalFileName = guessedName;
        storedFileName = guessedName;
      }
    }

    const jobId = makeJobId();
    const appliedEnhancements = buildAppliedEnhancements(options);
    const pipeline = buildPipeline(options);

    const normalizedOptions = {
      smartMode: options.smartMode,
      processingMode: normalizeString(options.processingMode),
      enableUpscale: options.enableUpscale,
      enableDenoise: options.enableDenoise,
      enableSharpen: options.enableSharpen,
      enableColorBoost: options.enableColorBoost,
      enableFrameSmoothing: options.enableFrameSmoothing,
      enableSocialExport: options.enableSocialExport,
      exportTarget: normalizeString(options.exportTarget, "Horizontal"),
      qualityLevel: normalizeString(options.qualityLevel, "High"),
    };

    const jobData = {
      id: jobId,
      fileName: originalFileName,
      storedFileName,
      originalUrl,
      resultUrl: null,
      options: normalizedOptions,
      appliedEnhancements,
      status: "queued",
      progress: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: "queued",
      currentStepLabel: "Queued",
      currentModel: null,
      pipeline,
      totalSteps: Math.max(pipeline.length, 1),
      completedSteps: 0,
      error: null,
      queueJobId: null,
    };

    console.log("========================================");
    console.log(`[Job ${jobId}] Video source ready`);
    console.log(`[Job ${jobId}] Original file:`, originalFileName);
    console.log(`[Job ${jobId}] Input URL:`, originalUrl);
    console.log(`[Job ${jobId}] Options:`, normalizedOptions);
    console.log(`[Job ${jobId}] Applied enhancements:`, appliedEnhancements);
    console.log(`[Job ${jobId}] Pipeline:`, pipeline);
    console.log("========================================");

    await saveJob(jobData);

    const queuedJob = await videoQueue.add(
      "process-video",
      {
        jobId,
        options: normalizedOptions,
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
      currentStep: "queued",
      currentStepLabel: "Queued",
    });

    return res.status(202).json({
      success: true,
      message: "Processing job created successfully",
      jobId,
      fileName: originalFileName,
      inputUrl: originalUrl,
      options: normalizedOptions,
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