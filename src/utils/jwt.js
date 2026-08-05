/**
 * Centralized JWT Secret resolution
 * In production (NODE_ENV === 'production'), JWT_SECRET must be explicitly provided in environment variables.
 * In development, a fallback key is allowed for convenience.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FATAL: JWT_SECRET environment variable is not defined. Server cannot start securely in production.'
      );
    }
    return 'aesthetic_girly_fashion_analytics_secret_key_2026';
  }
  return secret.trim();
}

module.exports = {
  getJwtSecret,
};
