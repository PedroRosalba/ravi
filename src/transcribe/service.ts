import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { transcribeAudio, type TranscriptionOptions, type TranscriptionResult } from "./openai.js";

const EXT_MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export const SUPPORTED_AUDIO_EXTENSIONS = Object.keys(EXT_MIME);

/**
 * Hard ceiling for any local file handed to transcription. The file is read
 * fully into memory, so callers must never hand an unbounded path here.
 * Callers acting for an agent (gateway/tool) should pass a tighter `maxBytes`.
 */
export const MAX_TRANSCRIBE_FILE_BYTES = 200 * 1024 * 1024;

export type TranscribeFileErrorCode = "NOT_A_REGULAR_FILE" | "FILE_TOO_LARGE";

export class TranscribeFileError extends Error {
  constructor(
    readonly code: TranscribeFileErrorCode,
    message: string,
    readonly details: { sizeBytes?: number; maxBytes?: number } = {},
  ) {
    super(message);
    this.name = "TranscribeFileError";
  }
}

export interface TranscribeFileInput extends TranscriptionOptions {
  filePath: string;
  mimeType?: string;
  /** Upper bound in bytes; defaults to (and is clamped by) MAX_TRANSCRIBE_FILE_BYTES. */
  maxBytes?: number;
}

export interface TranscribeFileResult extends TranscriptionResult {
  source: {
    filePath: string;
    mimeType: string;
    sizeBytes: number;
    sizeMB: number;
  };
}

export function inferAudioMimeType(filePath: string): string | undefined {
  return EXT_MIME[extname(filePath).toLowerCase()];
}

export async function transcribeFile(input: TranscribeFileInput): Promise<TranscribeFileResult> {
  const mimeType = input.mimeType ?? inferAudioMimeType(input.filePath);
  if (!mimeType) {
    throw new Error(`Unsupported audio format: ${extname(input.filePath) || "<none>"}`);
  }

  // Stat before reading so oversized or non-regular files are never loaded into memory.
  const stats = await stat(input.filePath);
  if (!stats.isFile()) {
    throw new TranscribeFileError("NOT_A_REGULAR_FILE", "Audio path is not a regular file.");
  }
  const maxBytes = Math.min(input.maxBytes ?? MAX_TRANSCRIBE_FILE_BYTES, MAX_TRANSCRIBE_FILE_BYTES);
  if (stats.size > maxBytes) {
    throw new TranscribeFileError("FILE_TOO_LARGE", "Audio file exceeds the transcription size limit.", {
      sizeBytes: stats.size,
      maxBytes,
    });
  }
  const buffer = await readFile(input.filePath);
  const result = await transcribeAudio(buffer, mimeType, {
    language: input.language,
    durationHintSec: input.durationHintSec,
  });
  return {
    ...result,
    source: {
      filePath: input.filePath,
      mimeType,
      sizeBytes: stats.size,
      sizeMB: Number((stats.size / 1024 / 1024).toFixed(1)),
    },
  };
}
