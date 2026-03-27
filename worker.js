require("dotenv").config();

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is missing in .env");
}

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const uploadsDir = path.join(__dirname, "uploads");

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

function getJobRedisKey(jobId) {
  return `job:${jobId}`;
}

async function getJob(jobId) {
  const raw = await redis.get(getJobRedisKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveJob(job) {
  await redis.set(getJobRedisKey(job.id), JSON.stringify(job));
}

async function updateJob(jobId, updates) {
  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job ${jobId} not found in Redis`);
  }

  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };

  await saveJob(updated);
  return updated;
}

function buildBestFfmpegArgs(inputPath, outputPath, options = {}) {
  const filters = [];

  const smartMode = toBool(options.smartMode);
  const colorBoost = smartMode || toBool(options.enableColorBoost);
  const socialExport = smartMode || toBool(options.enableSocialExport);

  const exportTarget = normalizeString(options.exportTarget, "Horizontal");
  const qualityLevel = normalizeString(options.qualityLevel, "High");

  // تحسين بصري قوي بدون AI:
  // - ألوان محسنة بشكل طبيعي
  // - وضوح أفضل بدون مبالغة
  // - توازن جيد للسوشال
  if (colorBoost) {
    filters.push(
      "eq=saturation=1.08:contrast=1.06:brightness=0.01"
    );
    filters.push(
      "unsharp=5:5:0.8:3:3:0.4"
    );
    filters.push(
      "colorbalance=rs=0.01:gs=0.01:bs=-0.005"
    );
  } else {
    filters.push(
      "unsharp=5:5:0.5:3:3:0.2"
    );
  }

  // تجهيز أبعاد احترافية
  if (exportTarget === "Vertical") {
    filters.push(
      "scale=1080:1920:force_original_aspect_ratio=decrease"
    );
    filters.push(
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
    );
  } else if (exportTarget === "Square") {
    filters.push(
      "scale=1080:1080:force_original_aspect_ratio=decrease"
    );
    filters.push(
      "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black"
    );
  } else {
    filters.push(
      "scale=1920:1080:force_original_aspect_ratio=decrease"
    );
    filters.push(
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black"
    );
  }

  // تجهيز إضافي للمنصات
  if (socialExport) {
    filters.push("format=yuv420p");
  }

  let crf = "18";
  let preset = "slow";

  if (qualityLevel === "Ultra") {
    crf = "16";
    preset = "slow";
  } else if (qualityLevel === "High") {
    crf = "18";
    preset = "slow";
  } else if (qualityLevel === "Medium") {
    crf = "21";
    preset = "medium";
  }

  const args = ["-y", "-i", inputPath];

  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  args.push(
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-profile:v", "high",
    "-level", "4.2",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    outputPath
  );

  return args;
}

const worker = new Worker(
  "video-processing",
  async (queueJob) => {
    const { jobId, options } = queueJob.data;

    console.log(`[Worker] Starting queue job ${queueJob.id} for app job ${jobId}`);

    const job = await getJob(jobId);
    if (!job) {
      throw new Error(`App job ${jobId} not found`);
    }

    const inputPath = path.join(uploadsDir, job.storedFileName);
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const outputFileName = `finalExport-${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}.mp4`;
    const outputPath = path.join(uploadsDir, outputFileName);

    const args = buildBestFfmpegArgs(inputPath, outputPath, options);

    await updateJob(jobId, {
      status: "processing",
      progress: 15,
      currentStep: "analyzing",
      currentStepLabel: "Analyzing",
      currentModel: null,
      totalSteps: 1,
      completedSteps: 0,
      error: null,
    });

    console.log(`[Worker] Preparing ffmpeg for job ${jobId}`);

    await updateJob(jobId, {
      status: "processing",
      progress: 35,
      currentStep: "finalExport",
      currentStepLabel: "Enhancing & Exporting",
      currentModel: "ffmpeg",
    });

    console.log(`[Worker] FFmpeg input: ${inputPath}`);
    console.log(`[Worker] FFmpeg output: ${outputPath}`);
    console.log(`[Worker] FFmpeg args: ${args.join(" ")}`);

    const result = await execFileAsync(ffmpegPath, args);

    if (result?.stdout) {
      console.log("[Worker] FFmpeg stdout:", result.stdout);
    }

    if (result?.stderr) {
      console.log("[Worker] FFmpeg stderr:", result.stderr);
    }

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL || "http://localhost:5000";
    const resultUrl = `${baseUrl}/uploads/${outputFileName}`;

    await updateJob(jobId, {
      status: "processing",
      progress: 90,
      currentStep: "finalizing",
      currentStepLabel: "Finalizing",
      currentModel: null,
      completedSteps: 1,
    });

    await updateJob(jobId, {
      status: "done",
      progress: 100,
      resultUrl,
      currentStep: "done",
      currentStepLabel: "Completed",
      currentModel: null,
      completedSteps: 1,
    });

    console.log(`[Worker] Job ${jobId} completed: ${resultUrl}`);

    return {
      resultUrl,
    };
  },
  {
    connection,
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Queue job ${job.id} completed`);
});

worker.on("failed", async (job, error) => {
  console.error(`[Worker] Queue job ${job?.id} failed:`, error);

  try {
    const appJobId = job?.data?.jobId;
    if (appJobId) {
      await updateJob(appJobId, {
        status: "failed",
        progress: 100,
        error: error.message,
        currentStep: "failed",
        currentStepLabel: "Failed",
        currentModel: null,
      });
    }
  } catch (updateError) {
    console.error("[Worker] Failed to mark app job as failed:", updateError);
  }
});

console.log("🔥 Worker is running...");