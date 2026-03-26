const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { fal } = require("@fal-ai/client");
const { execFile } = require("child_process");
const { promisify } = require("util");

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

if (process.env.FAL_KEY) {
  fal.config({
    credentials: process.env.FAL_KEY,
  });
}

const MODELS = {
  topaz: "fal-ai/topaz/upscale/video",
  crystal: "clarityai/crystal-video-upscaler",
  film: "fal-ai/film/video",
  reframe: "fal-ai/luma-dream-machine/ray-2/reframe",
};

function toBool(value) {
  return value === true || value === "true";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPublicBaseUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function buildAppliedEnhancements(options = {}) {
  const items = [];

  if (toBool(options.enableUpscale)) items.push("Upscale");
  if (toBool(options.enableDenoise)) items.push("Denoise");
  if (toBool(options.enableSharpen)) items.push("Sharpen");
  if (toBool(options.enableColorBoost)) items.push("Color Boost");
  if (toBool(options.enableFrameSmoothing)) items.push("Frame Smoothing");
  if (toBool(options.enableSocialExport)) items.push("Social Export");
  if (toBool(options.enableReframing)) items.push("Reframing");

  return items;
}

function mapAspectRatio(exportTarget) {
  switch (exportTarget) {
    case "Vertical":
      return "9:16";
    case "Square":
      return "1:1";
    case "Horizontal":
    default:
      return "16:9";
  }
}

function mapUpscaleFactor(qualityLevel) {
  switch (qualityLevel) {
    case "Ultra":
      return 4;
    case "High":
      return 2;
    case "Medium":
    default:
      return 2;
  }
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

function extractResultVideoUrl(result) {
  return (
    result?.data?.video?.url ||
    result?.data?.video_url ||
    result?.data?.output?.url ||
    result?.video?.url ||
    result?.video_url ||
    result?.output?.url ||
    null
  );
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
  const ext =
    path.extname(new URL(videoUrl).pathname).split("?")[0] ||
    ".mp4";

  const localPath = path.join(
    uploadsDir,
    `remote-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext || ".mp4"}`
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

function buildVideoPipeline(options = {}) {
  const steps = [];

  const smartMode = toBool(options.smartMode);

  const wantsDenoise = smartMode || toBool(options.enableDenoise);
  const wantsSharpen = smartMode || toBool(options.enableSharpen);
  const wantsUpscale = smartMode || toBool(options.enableUpscale);
  const wantsFrameSmoothing = toBool(options.enableFrameSmoothing);
  const wantsReframing = toBool(options.enableReframing);
  const wantsColorBoost = smartMode || toBool(options.enableColorBoost);
  const wantsSocialExport = smartMode || toBool(options.enableSocialExport);

  if (wantsDenoise || wantsSharpen) {
    steps.push({
      key: "topazEnhance",
      label: "Topaz Enhance",
      type: "fal",
      model: MODELS.topaz,
      buildInput: (videoUrl, opts) => ({
        video_url: videoUrl,
        model: wantsDenoise ? "Artemis HQ" : "Proteus",
        upscale_factor: mapUpscaleFactor(opts.qualityLevel),
        noise: wantsDenoise ? 0.35 : 0.1,
        recover_detail: wantsSharpen ? 0.3 : 0.15,
        compression: 0.2,
        halo: 0.05,
      }),
    });
  }

  if (wantsUpscale) {
    steps.push({
      key: "crystalUpscale",
      label: "Crystal Upscale",
      type: "fal",
      model: MODELS.crystal,
      buildInput: (videoUrl, opts) => ({
        video_url: videoUrl,
        scale_factor: mapUpscaleFactor(opts.qualityLevel),
      }),
    });
  }

  if (wantsFrameSmoothing) {
    steps.push({
      key: "frameSmoothing",
      label: "Frame Smoothing",
      type: "fal",
      model: MODELS.film,
      buildInput: (videoUrl) => ({
        video_url: videoUrl,
        num_frames: 1,
        use_scene_detection: true,
        use_calculated_fps: true,
      }),
    });
  }

  if (wantsReframing) {
    steps.push({
      key: "reframing",
      label: "Reframing",
      type: "fal",
      model: MODELS.reframe,
      buildInput: (videoUrl, opts) => ({
        video_url: videoUrl,
        aspect_ratio: mapAspectRatio(opts.exportTarget),
      }),
    });
  }

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

async function runFalStep(job, step, inputVideoUrl, stepIndex) {
  job.currentStep = step.key;
  job.currentStepLabel = step.label;
  job.currentModel = step.model;
  job.progress = computeProgress(stepIndex, job.totalSteps, "queued");

  const submitResult = await fal.queue.submit(step.model, {
    input: step.buildInput(inputVideoUrl, job.options),
  });

  const requestId = submitResult.request_id;
  job.activeRequestId = requestId;

  while (true) {
    const status = await fal.queue.status(step.model, {
      requestId,
      logs: true,
    });

    const falState = status.status;

    if (falState === "IN_QUEUE") {
      job.status = "processing";
      job.progress = computeProgress(stepIndex, job.totalSteps, "queued");
    } else if (falState === "IN_PROGRESS") {
      job.status = "processing";
      job.progress = computeProgress(stepIndex, job.totalSteps, "running");
    } else if (falState === "COMPLETED") {
      const result = await fal.queue.result(step.model, {
        requestId,
      });

      const outputVideoUrl = extractResultVideoUrl(result);

      if (!outputVideoUrl) {
        throw new Error(
          `Step "${step.key}" completed but no output video URL was returned`
        );
      }

      job.completedSteps = stepIndex + 1;
      job.progress = computeProgress(stepIndex, job.totalSteps, "done");
      return outputVideoUrl;
    } else if (falState === "FAILED" || falState === "CANCELLED") {
      throw new Error(`AI step failed: ${step.key}`);
    }

    await sleep(2000);
  }
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
    const ffmpegPath = require("ffmpeg-static");

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
    model: step.model || "ffmpeg",
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

    if (step.type === "fal") {
      currentVideoUrl = await runFalStep(job, step, currentVideoUrl, i);
    } else if (step.type === "ffmpeg") {
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
  job.activeRequestId = null;
}

app.get("/", (req, res) => {
  res.json({ message: "CrazyBoost backend is running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
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