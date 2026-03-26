const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

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

app.get("/", (req, res) => {
  res.json({ message: "CrazyBoost backend is running" });
});

app.post("/enhance", upload.single("video"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No video uploaded",
      });
    }

    const jobId = Date.now().toString();

    jobs[jobId] = {
      id: jobId,
      fileName: req.file.originalname,
      storedFileName: req.file.filename,
      resultUrl: `/uploads/${req.file.filename}`,
      options: req.body,
      status: "processing",
      progress: 0,
      createdAt: Date.now(),
    };

    console.log("Video received:", req.file.originalname);
    console.log("Stored as:", req.file.filename);
    console.log("Options:", req.body);
    console.log("Job created:", jobId);

    return res.json({
      success: true,
      message: "Video received successfully",
      jobId: jobId,
      fileName: req.file.originalname,
      options: req.body,
    });
  } catch (error) {
    console.error("Enhance error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

app.get("/status/:jobId", (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    const elapsedSeconds = Math.floor((Date.now() - job.createdAt) / 1000);

    let progress = 0;
    let status = "processing";

    if (elapsedSeconds >= 1) progress = 15;
    if (elapsedSeconds >= 2) progress = 35;
    if (elapsedSeconds >= 3) progress = 55;
    if (elapsedSeconds >= 4) progress = 75;
    if (elapsedSeconds >= 5) progress = 90;
    if (elapsedSeconds >= 6) {
      progress = 100;
      status = "done";
    }

    job.progress = progress;
    job.status = status;

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
    });
  }
});

app.get("/result/:jobId", (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
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
      resultUrl: job.resultUrl,
      appliedEnhancements: [],
    });
  } catch (error) {
    console.error("Result error:", error);

    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

app.listen(5000, () => {
  console.log("🚀 Server running on http://localhost:5000");
});