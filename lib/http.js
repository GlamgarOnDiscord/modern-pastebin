export function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 20 && /^[a-zA-Z0-9]+$/.test(id);
}

export function methodNotAllowed(res) {
  return res.status(405).json({ message: "Method Not Allowed" });
}

export function serverError(res, label, error) {
  console.error(`${label} Error:`, error);
  return res.status(500).json({ message: "Internal Server Error" });
}
