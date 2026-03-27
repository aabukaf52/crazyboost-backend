const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

const app = express();
app.set("trust proxy", true);

const uploadsDir = path.join(__dirname, "uploads");
const jobsFilePath = path.join(__dirname, "jobs.json");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(jobsFilePath)) {
  fs.writeFileSync(jobsFilePath, JSON.stringify({}, null, 2), "utf8");
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

let jobs = loadJobsFromDisk();

/* =========================
   Helpers
========================= */

function loadJobsFromDisk() {
  try {
    const raw = fs.readFileSync(jobsFilePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("Failed to load jobs from disk:", error);
    return {};
  }
}

async function saveJobsToDisk() {
  try {
    await fsp.writeFile(jobsFilePath, JSON.stringify(jobs, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save jobs to disk:", error);
  }
}

async function updateJob(jobId, updates) {
  if (!jobs[jobId]) return;
  jobs[jobId] = {
    ...jobs[jobId],
    ...updates,
    updatedAt: Date.now(),
  };
  await saveJobsToDisk();
}

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
  return String(value).trim() || fallback;
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

function getLocalUploadedPathFromUrl(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    const maybeFileName = path.basename(parsed.pathname);
    const fullPath = path.join(uploadsDir, maybeFileName);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }

    return null;
  } catch (_) {
    const maybeFileName = path.basename(videoUrl);
    const fullPath = path.join(uploadsDir, maybeFileName);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }

    return null;
  }
}

async function downloadRemoteVideoToLocal(videoUrl) {
  console.log("Downloading remote video:", videoUrl);

  const response = await fetch(videoUrl);

  if (!response.ok) {
    throw new Error(`Failed to download remote video: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  let ext = ".mp4";
  try {
    const pathname = new URL(videoUrl).pathname;
    const parsedExt = path.extname(pathname);
    if (parsedExt) ext = parsedExt;
  } catch (_) {}

  const localPath = path.join(
    uploadsDir,
    `remote-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
  );

  fs.writeFileSync(localPath, buffer);
  console.log("Remote video downloaded to:", localPath);

  return localPath;
}

async function resolveVideoUrlToLocalPath(videoUrl) {
  const existingLocalPath = getLocalUploadedPathFromUrl(videoUrl);

  if (existingLocalPath) {
    return {
      inputPath: existingLocalPath,
      isTemp: false,
    };
  }

  const downloadedPath = await downloadRemoteVideoToLocal(videoUrl);

  return {
    inputPath: downloadedPath,
    isTemp: true,
  };
}

function createOutputPath(prefix = "processed") {
  return path.join(
    uploadsDir,
    `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`
  );
}

function computeProgress(currentStepIndex, totalSteps, state = "running") {
  const start = 10;
  const end = 95;

  if (totalSteps <= 0) return 100;

  const perStep = (end - start) / totalSteps;
  const base = start + currentStepIndex * perStep;

  if (state === "queued") return Math.round(base);
  if (state === "running") return Math.round(base + perStep * 0.55);
  if (state === "done") return Math.round(base + perStep);

  return Math.round(base);
}

function buildVideoPipeline(options = {}) {
  const steps = [];
  const smartMode = toBool(options.smartMode);

  const wantsColorBoost = smartMode || toBool(options.enableColorBoost);
  const wantsSocialExport = smartMode || toBool(options.enableSocialExport);
  const hasQualityLevel = Boolean(normalizeString(options.qualityLevel));
  const hasExportTarget = Boolean(normalizeString(options.exportTarget));

  console.log("Pipeline decision:", {
    smartMode,
    wantsColorBoost,
    wantsSocialExport,
    qualityLevel: options.qualityLevel,
    exportTarget: options.exportTarget,
  });

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
    });
  }

  console.log("Built pipeline steps:", steps);

  return steps;
}

function buildFfmpegArgs(inputPath, outputPath, options = {}) {
  const filters = [];

  if (toBool(options.enableColorBoost) || toBool(options.smartMode)) {
    filters.push("eq=saturation=1.12:contrast=1.04:brightness=0.01");
  }

  const exportTarget = normalizeString(options.exportTarget, "Horizontal");
  const qualityLevel = normalizeString(options.qualityLevel, "Medium");

  if (exportTarget === "Vertical") {
    filters.push(
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2"
    );
  } else if (exportTarget === "Square") {
    filters.push(
      "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2"
    );
  } else {
    filters.push(
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
    );
  }

  let crf = "21";
  let preset = "medium";

  if (qualityLevel === "Ultra") {
    crf = "18";
    preset = "slow";
  } else if (qualityLevel === "High") {
    crf = "20";
    preset = "slow";
  }

  const args = ["-y", "-i", inputPath];

  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath
  );

  return args;
}

async function runFfmpegStep(jobId, step, inputVideoUrl, stepIndex, publicBaseUrl) {
  const job = jobs[jobId];
  if (!job) {
    throw new Error(`Job ${jobId} not found before FFmpeg step`);
  }

  await updateJob(jobId, {
    currentStep: step.key,
    currentStepLabel: step.label,
    currentModel: "ffmpeg",
    progress: computeProgress(stepIndex, job.totalSteps, "running"),
    status: "processing",
  });

  console.log(`[Job ${jobId}] Starting ffmpeg step`);

  const resolved = await resolveVideoUrlToLocalPath(inputVideoUrl);
  const outputPath = createOutputPath(step.key);
  const args = buildFfmpegArgs(resolved.inputPath, outputPath, job.options);

  console.log(`[Job ${jobId}] FFmpeg input:`, resolved.inputPath);
  console.log(`[Job ${jobId}] FFmpeg output:`, outputPath);
  console.log(`[Job ${jobId}] FFmpeg args:`, args.join(" "));

  try {
    const result = await execFileAsync(ffmpegPath, args);
    if (result?.stdout) {
      console.log(`[Job ${jobId}] FFmpeg stdout:`, result.stdout);
    }
    if (result?.stderr) {
      console.log(`[Job ${jobId}] FFmpeg stderr:`, result.stderr);
    }
  } finally {
    if (resolved.isTemp && fs.existsSync(resolved.inputPath)) {
      fs.unlinkSync(resolved.inputPath);
    }
  }

  await updateJob(jobId, {
    completedSteps: stepIndex + 1,
    progress: computeProgress(stepIndex, job.totalSteps, "done"),
  });

  const outputUrl = `${publicBaseUrl}/uploads/${path.basename(outputPath)}`;
  console.log(`[Job ${jobId}] FFmpeg finished. Output URL:`, outputUrl);

  return outputUrl;
}

async function runPipeline(jobId, initialVideoUrl, publicBaseUrl) {
  const job = jobs[jobId];
  if (!job) {
    throw new Error(`Job ${jobId} not found before pipeline start`);
  }

  console.log(`[Job ${jobId}] Pipeline starting`);

  const steps = buildVideoPipeline(job.options);

  await updateJob(jobId, {
    pipeline: steps.map((step) => ({
      key: step.key,
      label: step.label,
      type: step.type,
      model: null,
    })),
    totalSteps: steps.length,
    completedSteps: 0,
    status: "processing",
    progress: 10,
    currentStep: "analyzing",
    currentStepLabel: "Analyzing",
    currentModel: null,
  });

  if (steps.length === 0) {
    console.log(`[Job ${jobId}] No processing steps. Returning original video.`);
    await updateJob(jobId, {
      resultUrl: initialVideoUrl,
      status: "done",
      progress: 100,
      currentStep: "done",
      currentStepLabel: "Completed",
      currentModel: null,
    });
    return;
  }

  let currentVideoUrl = initialVideoUrl;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];

    if (step.type === "ffmpeg") {
      currentVideoUrl = await runFfmpegStep(
        jobId,
        step,
        currentVideoUrl,
        i,
        publicBaseUrl
      );
    }
  }

  await updateJob(jobId, {
    resultUrl: currentVideoUrl,
    status: "done",
    progress: 100,
    currentStep: "done",
    currentStepLabel: "Completed",
    currentModel: null,
  });

  console.log(`[Job ${jobId}] Pipeline completed successfully`);
}

function cleanupOldJobs() {
  const now = Date.now();
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
  let changed = false;

  for (const [jobId, job] of Object.entries(jobs)) {
    const createdAt = job.createdAt || 0;
    if (now - createdAt > maxAgeMs) {
      delete jobs[jobId];
      changed = true;
    }
  }

  if (changed) {
    saveJobsToDisk().catch((error) => {
      console.error("Failed to save cleaned jobs:", error);
    });
  }
}

setInterval(cleanupOldJobs, 30 * 60 * 1000);

/* =========================
   Routes
========================= */

app.get("/", (req, res) => {
  res.json({ message: "CrazyBoost backend is running (No AI Version)" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
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

    console.log("========================================");
    console.log(`[Job ${jobId}] Video received:`, req.file.originalname);
    console.log(`[Job ${jobId}] Stored as:`, req.file.filename);
    console.log(`[Job ${jobId}] Public video URL:`, publicVideoUrl);
    console.log(`[Job ${jobId}] Options:`, options);
    console.log(`[Job ${jobId}] Applied enhancements:`, appliedEnhancements);
    console.log("========================================");

    jobs[jobId] = {
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
      activeRequestId: null,
      currentStep: "queued",
      currentStepLabel: "Queued",
      currentModel: null,
      pipeline: [],
      totalSteps: 0,
      completedSteps: 0,
      error: null,
    };

    await saveJobsToDisk();

    runPipeline(jobId, publicVideoUrl, publicBaseUrl).catch(async (error) => {
      console.error(`[Job ${jobId}] Pipeline error:`, error);

      await updateJob(jobId, {
        status: "failed",
        progress: 100,
        error: error.message,
        currentStep: "failed",
        currentStepLabel: "Failed",
        currentModel: null,
        activeRequestId: null,
      });
    });

    return res.json({
      success: true,
      message: "Video received successfully",
      jobId,
      fileName: req.file.originalname,
      options,
      appliedEnhancements,
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
    const job = jobs[jobId];

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

const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});