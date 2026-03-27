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

function getProcessingMode(options = {}) {
  const mode = normalizeString(options.processingMode, "");
  if (mode) return mode.toLowerCase();

  // افتراضيًا الآن كل شيء non-ai
  return "non-ai";
}

function buildNonAiFfmpegArgs(inputPath, outputPath, options = {}) {
  const filters = [];

  const smartMode = toBool(options.smartMode);

  const enableUpscale = smartMode || toBool(options.enableUpscale);
  const enableDenoise = smartMode || toBool(options.enableDenoise);
  const enableSharpen = smartMode || toBool(options.enableSharpen);
  const enableColorBoost = smartMode || toBool(options.enableColorBoost);
  const enableFrameSmoothing = toBool(options.enableFrameSmoothing);
  const enableSocialExport = smartMode || toBool(options.enableSocialExport);

  const exportTarget = normalizeString(options.exportTarget, "Horizontal");
  const qualityLevel = normalizeString(options.qualityLevel, "High");

  // 1) Denoise
  if (enableDenoise) {
    filters.push("hqdn3d=1.5:1.5:6:6");
  }

  // 2) Upscale / Resize بجودة عالية
  if (enableUpscale) {
    if (exportTarget === "Vertical") {
      filters.push(
        "scale=1440:2560:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=1440:2560:(ow-iw)/2:(oh-ih)/2:black");
    } else if (exportTarget === "Square") {
      filters.push(
        "scale=1440:1440:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=1440:1440:(ow-iw)/2:(oh-ih)/2:black");
    } else {
      filters.push(
        "scale=2560:1440:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=2560:1440:(ow-iw)/2:(oh-ih)/2:black");
    }
  } else {
    if (exportTarget === "Vertical") {
      filters.push(
        "scale=1080:1920:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black");
    } else if (exportTarget === "Square") {
      filters.push(
        "scale=1080:1080:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black");
    } else {
      filters.push(
        "scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease"
      );
      filters.push("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black");
    }
  }

  // 3) Color grading أقوى وواضح
  if (enableColorBoost) {
    filters.push("eq=contrast=1.12:brightness=0.015:saturation=1.18:gamma=1.03");
    filters.push("colorbalance=rs=0.015:gs=0.008:bs=-0.010");
    filters.push("curves=all='0/0 0.20/0.16 0.50/0.55 0.80/0.90 1/1'");
  }

  // 4) Sharpen
  if (enableSharpen) {
    filters.push("unsharp=7:7:1.4:5:5:0.8");
  } else {
    filters.push("unsharp=5:5:0.6:3:3:0.3");
  }

  // 5) Frame smoothing
  let fpsArgs = [];
  if (enableFrameSmoothing) {
    fpsArgs = ["-r", "60"];
    filters.push("minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir");
  }

  // 6) Social export / توافق المنصات
  if (enableSocialExport) {
    filters.push("format=yuv420p");
  }

  let crf = "18";
  let preset = "slow";

  if (qualityLevel === "Ultra") {
    crf = "15";
    preset = "slow";
  } else if (qualityLevel === "High") {
    crf = "17";
    preset = "slow";
  } else if (qualityLevel === "Medium") {
    crf = "20";
    preset = "medium";
  }

  const args = ["-y", "-i", inputPath];

  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  args.push(
    ...fpsArgs,
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

// Placeholder للمستقبل
function buildAiFfmpegArgs() {
  throw new Error("AI mode is not implemented yet");
}

function buildOutputFileName(mode) {
  return `${mode}-output-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
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

    const processingMode = getProcessingMode(options);
    const outputFileName = buildOutputFileName(processingMode);
    const outputPath = path.join(uploadsDir, outputFileName);

    await updateJob(jobId, {
      status: "processing",
      progress: 10,
      currentStep: "analyzing",
      currentStepLabel: "Analyzing",
      currentModel: processingMode,
      totalSteps: 1,
      completedSteps: 0,
      error: null,
    });

    let args;

    if (processingMode === "ai") {
      await updateJob(jobId, {
        status: "processing",
        progress: 20,
        currentStep: "ai_prepare",
        currentStepLabel: "Preparing AI processing",
        currentModel: "ai",
      });

      args = buildAiFfmpegArgs(inputPath, outputPath, options);
    } else {
      await updateJob(jobId, {
        status: "processing",
        progress: 25,
        currentStep: "non_ai_enhance",
        currentStepLabel: "Enhancing with advanced filters",
        currentModel: "ffmpeg-non-ai",
      });

      args = buildNonAiFfmpegArgs(inputPath, outputPath, options);
    }

    console.log(`[Worker] Input: ${inputPath}`);
    console.log(`[Worker] Output: ${outputPath}`);
    console.log(`[Worker] Mode: ${processingMode}`);
    console.log(`[Worker] FFmpeg args: ${args.join(" ")}`);

    await updateJob(jobId, {
      status: "processing",
      progress: 55,
      currentStep: "rendering",
      currentStepLabel: "Rendering video",
      currentModel: processingMode,
    });

    const result = await execFileAsync(ffmpegPath, args);

    if (result?.stdout) {
      console.log("[Worker] FFmpeg stdout:", result.stdout);
    }

    if (result?.stderr) {
      console.log("[Worker] FFmpeg stderr:", result.stderr);
    }

    await updateJob(jobId, {
      status: "processing",
      progress: 90,
      currentStep: "finalizing",
      currentStepLabel: "Finalizing",
      currentModel: processingMode,
      completedSteps: 1,
    });

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL || "http://localhost:5000";
    const resultUrl = `${baseUrl}/uploads/${outputFileName}`;

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
      processingMode,
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