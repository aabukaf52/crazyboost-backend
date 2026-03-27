require("dotenv").config();

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

// 🔥 Cloudinary
const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ============================
// 🔥 Cloudinary Upload Result
// ============================
async function uploadProcessedVideo(filePath, jobId, mode) {
  const publicId = `crazyboost/results/${jobId}-${mode}-${Date.now()}`;

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: "video",
    public_id: publicId,
    overwrite: true,
  });

  return result.secure_url;
}

// ============================
// 🔧 Helpers (بدون تغيير)
// ============================
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
  if (!existing) throw new Error(`Job ${jobId} not found`);

  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };

  await saveJob(updated);
  return updated;
}

// ============================
// 🔥 تحميل الفيديو من Cloudinary
// ============================
async function downloadFile(url, outputPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

async function resolveInputPath(job) {
  const localPath = path.join(uploadsDir, job.storedFileName);

  if (fs.existsSync(localPath)) {
    return { inputPath: localPath, isTemp: false };
  }

  if (!job.originalUrl) {
    throw new Error("originalUrl missing");
  }

  const tempPath = path.join(
    uploadsDir,
    `remote-${Date.now()}-${Math.random()}.mp4`
  );

  await downloadFile(job.originalUrl, tempPath);

  return { inputPath: tempPath, isTemp: true };
}

// ============================
// 🎯 FFmpeg Logic (نفسك + تحسين)
// ============================
function getProcessingMode(options = {}) {
  const mode = normalizeString(options.processingMode, "").toLowerCase();

  if (!mode) {
    if (toBool(options.smartMode)) return "smart";
    return "custom";
  }

  if (mode === "balance") return "balanced";

  return ["smart", "fast", "balanced", "ultra", "custom"].includes(mode)
    ? mode
    : "custom";
}

function getEncodingByQuality(q = "High") {
  if (q === "Ultra") return { crf: "14", preset: "slower" };
  if (q === "High") return { crf: "17", preset: "slow" };
  return { crf: "20", preset: "medium" };
}

function getModeProfile(mode, options = {}) {
  const exportTarget = normalizeString(options.exportTarget, "Horizontal");
  const encoding = getEncodingByQuality(options.qualityLevel);

  return {
    mode,
    exportTarget,
    useUpscale: true,
    useDenoise: true,
    useSharpen: true,
    useColorBoost: true,
    useFrameSmoothing: mode === "ultra",
    ...encoding,
  };
}

function buildFilterComplex(profile) {
  const filters = [];

  filters.push("format=yuv420p");

  if (profile.useDenoise) {
    filters.push("hqdn3d=1.4:1.4:6:6");
  }

  filters.push(
    "scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int"
  );

  if (profile.useSharpen) {
    filters.push("unsharp=7:7:1.2:5:5:0.5");
  }

  const base = filters.join(",");

  return `[0:v]${base}[vout]`;
}

function buildArgs(input, output, options) {
  const mode = getProcessingMode(options);
  const profile = getModeProfile(mode, options);
  const filter = buildFilterComplex(profile);

  return {
    args: [
      "-y",
      "-i",
      input,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      profile.preset,
      "-crf",
      profile.crf,
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      output,
    ],
    profile,
  };
}

// ============================
// 🚀 WORKER
// ============================
const worker = new Worker(
  "video-processing",
  async (queueJob) => {
    const { jobId, options } = queueJob.data;

    const job = await getJob(jobId);
    if (!job) throw new Error("Job not found");

    const { inputPath, isTemp } = await resolveInputPath(job);

    const outputFile = `out-${Date.now()}.mp4`;
    const outputPath = path.join(uploadsDir, outputFile);

    await updateJob(jobId, { status: "processing", progress: 30 });

    const { args, profile } = buildArgs(inputPath, outputPath, options);

    await execFileAsync(ffmpegPath, args);

    // 🧹 حذف input المؤقت
    if (isTemp && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
    }

    await updateJob(jobId, { progress: 80 });

    // 🔥 رفع إلى Cloudinary
    const resultUrl = await uploadProcessedVideo(
      outputPath,
      jobId,
      profile.mode
    );

    // 🧹 حذف output
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    await updateJob(jobId, {
      status: "done",
      progress: 100,
      resultUrl,
    });

    return { resultUrl };
  },
  { connection }
);

console.log("🔥 Worker running...");