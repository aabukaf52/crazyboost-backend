const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

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

function toBool(value) {
  return value === true || value === "true";
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
  } catch (error) {
    const maybeFileName = path.basename(videoUrl);
    const fullPath = path.join(uploadsDir, maybeFileName);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }

    return null;
  }
}

async function downloadRemoteVideoToLocal(videoUrl) {
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
  return path.join(uploadsDir, `${prefix}-${Date.now()}.mp4`);
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

  if (
    wantsColorBoost ||
    wantsSocialExport ||
    options.qualityLevel ||
    options.exportTarget
  ) {
    steps.push({
      key: "finalExport",
      label: "Final Export",
      type: "ffmpeg",
    });
  }

  return steps;
}

function buildFfmpegArgs(inputPath, outputPath, options = {}) {
  const filters = [];

  if (toBool(options.enableColorBoost) || toBool(options.smartMode)) {
    filters.push("eq=saturation=1.12:contrast=1.04:brightness=0.01");
  }

  const exportTarget = options.exportTarget || "Horizontal";

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

  if (options.qualityLevel === "Ultra") {
    crf = "18";
    preset = "slow";
  } else if (options.qualityLevel === "High") {
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

async function runFfmpegStep(job, step, inputVideoUrl, stepIndex, publicBaseUrl) {
  job.currentStep = step.key;
  job.currentStepLabel = step.label;
  job.currentModel = "ffmpeg";
  job.progress = computeProgress(stepIndex, job.totalSteps, "running");

  const resolved = await resolveVideoUrlToLocalPath(inputVideoUrl);
  const outputPath = createOutputPath(step.key);
  const args = buildFfmpegArgs(resolved.inputPath, outputPath, job.options);

  try {
    await execFileAsync(ffmpegPath, args);
  } finally {
    if (resolved.isTemp && fs.existsSync(resolved.inputPath)) {
      fs.unlinkSync(resolved.inputPath);
    }
  }

  job.completedSteps = stepIndex + 1;
  job.progress = computeProgress(stepIndex, job.totalSteps, "done");

  return `${publicBaseUrl}/uploads/${path.basename(outputPath)}`;
}

async function runPipeline(job, initialVideoUrl, publicBaseUrl) {
  const steps = buildVideoPipeline(job.options);

  job.pipeline = steps.map((step) => ({
    key: step.key,
    label: step.label,
    type: step.type,
    model: null,
  }));

  job.totalSteps = steps.length;
  job.completedSteps = 0;
  job.status = "processing";
  job.progress = 10;
  job.currentStep = "analyzing";
  job.currentStepLabel = "Analyzing";
  job.currentModel = null;

  if (steps.length === 0) {
    job.resultUrl = initialVideoUrl;
    job.status = "done";
    job.progress = 100;
    job.currentStep = "done";
    job.currentStepLabel = "Completed";
    return;
  }

  let currentVideoUrl = initialVideoUrl;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];

    if (step.type === "ffmpeg") {
      currentVideoUrl = await runFfmpegStep(
        job,
        step,
        currentVideoUrl,
        i,
        publicBaseUrl
      );
    }
  }

  job.resultUrl = currentVideoUrl;
  job.status = "done";
  job.progress = 100;
  job.currentStep = "done";
  job.currentStepLabel = "Completed";
  job.currentModel = null;
}

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
      status: "queued",
      progress: 5,
      createdAt: Date.now(),
      activeRequestId: null,
      currentStep: "queued",
      currentStepLabel: "Queued",
      currentModel: null,
      pipeline: [],
      totalSteps: 0,
      completedSteps: 0,
      error: null,
    };

    runPipeline(jobs[jobId], publicVideoUrl, publicBaseUrl).catch((error) => {
      console.error("Pipeline error:", error);

      jobs[jobId].status = "failed";
      jobs[jobId].progress = 100;
      jobs[jobId].error = error.message;
      jobs[jobId].currentStep = "failed";
      jobs[jobId].currentStepLabel = "Failed";
      jobs[jobId].currentModel = null;
      jobs[jobId].activeRequestId = null;
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