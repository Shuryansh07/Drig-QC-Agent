import multer from "multer";

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
];

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB (OpenAI Whisper API limit)
  },
  fileFilter: (req, file, cb) => {
    // Browsers label recordings with codec parameters ("audio/webm;codecs=opus"): compare the base type only.
    const baseType = String(file.mimetype).split(";")[0].trim().toLowerCase();
    if (ALLOWED_MIME_TYPES.includes(baseType)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported audio file type"));
    }
  },
});

export default upload;
