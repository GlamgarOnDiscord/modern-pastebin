export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export const QUOTAS = {
  paste: { maxFiles: 20, maxTotal: 200 * 1024 * 1024 },
  drive: { maxFiles: 200, maxTotal: 1024 * 1024 * 1024 },
};

export const MAX_PATH_DEPTH = 10;
export const MAX_SEGMENT_LENGTH = 255;
export const MAX_PATH_LENGTH = 1024;

export const TTL_MAP = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
};

export const KINDS = new Set(["paste", "drive"]);
